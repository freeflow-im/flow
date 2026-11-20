// Hosted user apps (docs/specs/user-apps.md §7.2, §8; decision_log 2026-11-17): an app version's server code, kept as
// text in R2, loaded into an isolate of its own by the Worker Loader. The isolate's env holds only the entrypoints below,
// each bound to its app and organization by `ctx.props`, which the app cannot change:
//
//   DB     AppDb      SQL on the app's store in this organization (AppStore, one Durable Object per app and organization)
//   FILES  AppFiles   files in R2 under the install's own prefix (§8)
//   SUITE  AppSuite   the suite as the app may use it: its events (§5.1), and as its caller what `uses` declares (§6.3)
//
// and its `globalOutbound` is AppEgress, which lets it reach only the hosts its manifest declared. A tool call reaches
// the app as a request the host makes (`POST https://app.invalid/__freeflow/tool`), with the caller context in the body.
import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import type { UserAppManifest } from '@flow/shared';
import { FREEFLOW_SDK_SOURCE, SDK_MODULE } from './sdk';

/** What the runner needs of a hosted app's installed version (the Org object's `installedCode`). */
export interface HostedCode { manifest: UserAppManifest; version: number; prefix: string; files: Record<string, number> }

/** The limits on an install's files (§8): per file, and in all. */
export const APP_FILE_MAX_BYTES = 10_000_000;
export const APP_FILES_MAX_BYTES = 10_000_000_000;
/** A file's key in the app: letters, digits and `._-/`, no `..`, at most 300 characters. */
const FILE_KEY = /^(?!.*\.\.)(?!\/)[A-Za-z0-9._\-/]{1,300}$/;

/** Where an install's files are in R2 (§8): its own prefix, a dev install's apart from the organization's. */
export const filesPrefix = (p: AppProps): string => `appfiles/${p.org}/${p.app}/${p.dev ? `dev/${p.dev}` : 'live'}/`;

/** The limits an app's isolate runs with (§7.2). */
export const HOSTED_CPU_MS = 1_000;
export const HOSTED_SUBREQUESTS = 50;
/** The first path segment the host keeps for itself in the app's isolate. */
export const HOST_PATH = '/__freeflow/';

export interface HostedEnv {
  LOADER?: WorkerLoader;
  BLOBS?: R2Bucket;
  APP_STORE?: DurableObjectNamespace<AppStore>;
  EVENTS?: DurableObjectNamespace<import('../events/object').Events>;
  ORG?: DurableObjectNamespace<import('../org/object').Org>;
  DOCS?: DurableObjectNamespace<import('../docs/object').Docs>;
  /** The apps domain the screens are served on (§6.1): `flowtoo.org`; `flowtoo.localhost:<port>` in local development. */
  APPS_DOMAIN?: string;
  /** `http` in local development; https otherwise. */
  APPS_SCHEME?: string;
}

/** The props every app entrypoint is bound with. `dev`: a draft's dev install (§9.3), by its author's account. */
export interface AppProps { org: string; app: string; dev?: string }

/** One SQL statement and its parameters. */
export interface Statement { sql: string; params?: unknown[] }

/** The store's name: the install's, or a dev install's own (§9.3), apart from it. */
export const storeName = (p: AppProps): string => (p.dev ? `${p.app}:${p.org}:dev:${p.dev}` : `${p.app}:${p.org}`);
const storeOf = (env: HostedEnv, p: AppProps) => env.APP_STORE!.get(env.APP_STORE!.idFromName(storeName(p)));

/**
 * One installed app's data in one organization (§8): its SQLite, its migrations applied once each in order, and the
 * restore point an update is taken after (step 5). Only the platform reaches it; the app does so through AppDb.
 */
export class AppStore extends DurableObject<HostedEnv> {
  private sql() {
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS _freeflow_migrations (name TEXT PRIMARY KEY, at INTEGER NOT NULL)');
    return this.ctx.storage.sql;
  }

  exec(sql: string, params: unknown[] = []): Record<string, unknown>[] {
    if (/_freeflow_/i.test(sql)) throw new Error('the _freeflow_ tables are the platform’s');
    return this.sql().exec(sql, ...params).toArray();
  }

  /** Several statements in one transaction: the rows of each, in order. */
  batch(statements: Statement[]): Record<string, unknown>[][] {
    return this.ctx.storage.transactionSync(() => statements.map((s) => this.exec(s.sql, s.params ?? [])));
  }

  /** Applies the migrations not applied yet, in name order, each in its own transaction. A failure stops at that one. */
  migrate(migrations: { name: string; sql: string }[]): { applied: string[] } {
    const sql = this.sql();
    const done = new Set(sql.exec('SELECT name FROM _freeflow_migrations').toArray().map((r) => r.name as string));
    const applied: string[] = [];
    for (const m of [...migrations].sort((a, b) => a.name.localeCompare(b.name))) {
      if (done.has(m.name)) continue;
      this.ctx.storage.transactionSync(() => {
        for (const statement of m.sql.split(/;\s*(?:\n|$)/).map((s) => s.trim()).filter(Boolean)) sql.exec(statement);
        sql.exec('INSERT INTO _freeflow_migrations (name, at) VALUES (?, ?)', m.name, Date.now());
      });
      applied.push(m.name);
    }
    return { applied };
  }

  /** Every table of the app and its rows, for an owner's or admin's export (§8). The platform's own tables stay out. */
  dump(): Record<string, Record<string, unknown>[]> {
    const sql = this.sql();
    // GLOB, not LIKE: in LIKE `_` is any one character. The runtime's tables (`_cf_*`, a local runtime's `__*`) stay out.
    const tables = sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' AND name NOT GLOB '__*' AND name NOT GLOB '_freeflow_*'").toArray().map((r) => r.name as string);
    return Object.fromEntries(tables.map((t) => [t, sql.exec(`SELECT * FROM "${t.replace(/"/g, '""')}"`).toArray()]));
  }

  /** The file index (§8): each file's size and type, for the limit, the listing and the export. */
  private files() {
    this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS _freeflow_files (key TEXT PRIMARY KEY, size INTEGER NOT NULL, type TEXT NOT NULL, at INTEGER NOT NULL)');
    return this.ctx.storage.sql;
  }

  /** Records a file about to be written; false when it would take the install over its limit. */
  fileWillPut(key: string, size: number, type: string): boolean {
    const sql = this.files();
    const others = (sql.exec('SELECT COALESCE(SUM(size), 0) AS n FROM _freeflow_files WHERE key != ?', key).one().n as number) ?? 0;
    if (others + size > APP_FILES_MAX_BYTES) return false;
    sql.exec('INSERT INTO _freeflow_files (key, size, type, at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET size = excluded.size, type = excluded.type, at = excluded.at', key, size, type, Date.now());
    return true;
  }

  fileRemoved(key: string): void {
    this.files().exec('DELETE FROM _freeflow_files WHERE key = ?', key);
  }

  /** The files under a prefix, by key. */
  fileList(prefix = ''): { key: string; size: number; type: string; at: number }[] {
    return this.files().exec('SELECT key, size, type, at FROM _freeflow_files WHERE substr(key, 1, ?) = ? ORDER BY key LIMIT 1000', prefix.length, prefix).toArray() as never;
  }

  /** Deletes everything: a deleted draft's dev install (§9.3). */
  async clear(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }

  bookmark(): Promise<string> {
    return this.ctx.storage.getCurrentBookmark();
  }

  /** Goes back to a restore point: the object restarts with the data it had then (§8). */
  async restore(bookmark: string): Promise<void> {
    await this.ctx.storage.onNextSessionRestoreBookmark(bookmark);
    this.ctx.abort();
  }
}

/** The app's `env.DB`: SQL on its own store in this organization. */
export class AppDb extends WorkerEntrypoint<HostedEnv, AppProps> {
  exec(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]> {
    return storeOf(this.env, this.ctx.props).exec(String(sql), Array.isArray(params) ? params : []) as Promise<Record<string, unknown>[]>;
  }

  batch(statements: Statement[]): Promise<Record<string, unknown>[][]> {
    return storeOf(this.env, this.ctx.props).batch(Array.isArray(statements) ? statements : []) as Promise<Record<string, unknown>[][]>;
  }
}

/** Docs' read paths an app may ask for, as its caller (`docs:read`): a file's text or meta, a document, sheet or deck. */
const DOCS_READ = /^\/api\/(files\/[A-Za-z0-9_-]{1,80}\/(text|meta)|(docs|sheets|decks|markdown)\/[A-Za-z0-9_-]{1,80})(\?[A-Za-z0-9=&_-]{0,200})?$/;

/** One file as the app gets it back. */
export interface AppFile { data: ArrayBuffer; type: string; size: number }

/** A file's full key in R2 under the install's prefix; throws on a key the app may not use. */
function fileKeyOf(env: HostedEnv, props: AppProps, key: string): string {
  if (typeof key !== 'string' || !FILE_KEY.test(key)) throw new Error('a file key is letters, digits and . _ - /, at most 300, not starting with /');
  if (!env.BLOBS) throw new Error('this server has no file storage');
  return filesPrefix(props) + key;
}

/** Writes one of the install's files (§8), within its limits: AppFiles.put, and AppSuite's copy of a Chat file. */
async function putAppFile(env: HostedEnv, props: AppProps, key: string, data: ArrayBuffer | ArrayBufferView | string, type: string): Promise<{ key: string; size: number }> {
  const full = fileKeyOf(env, props, key);
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (bytes.byteLength > APP_FILE_MAX_BYTES) throw new Error(`a file is at most ${APP_FILE_MAX_BYTES} bytes`);
  const kind = String(type).slice(0, 100) || 'application/octet-stream';
  if (!(await storeOf(env, props).fileWillPut(key, bytes.byteLength, kind))) throw new Error('this app has used its 10 GB of files here');
  await env.BLOBS!.put(full, bytes, { httpMetadata: { contentType: kind } });
  return { key, size: bytes.byteLength };
}

/** A Chat file as a hosted app sees it (`files:read`): its id, name, type, size, and an image's size in pixels. */
export interface AppChatFile { id: string; name: string; type: string; size: number; width: number | null; height: number | null }

/**
 * The app's `env.FILES` (§8): files in R2 under its install's prefix, at most 10 MB each and 10 GB in all. The app's screen
 * uploads and shows them through its own routes, which check who is looking; nothing here is public.
 */
export class AppFiles extends WorkerEntrypoint<HostedEnv, AppProps> {
  private check(key: string): string {
    return fileKeyOf(this.env, this.ctx.props, key);
  }

  put(key: string, data: ArrayBuffer | ArrayBufferView | string, type = 'application/octet-stream'): Promise<{ key: string; size: number }> {
    return putAppFile(this.env, this.ctx.props, key, data, type);
  }

  async get(key: string): Promise<AppFile | null> {
    const o = await this.env.BLOBS!.get(this.check(key));
    if (!o) return null;
    return { data: await o.arrayBuffer(), type: o.httpMetadata?.contentType ?? 'application/octet-stream', size: o.size };
  }

  async delete(key: string): Promise<void> {
    await this.env.BLOBS!.delete(this.check(key));
    await storeOf(this.env, this.ctx.props).fileRemoved(key);
  }

  list(prefix = ''): Promise<{ key: string; size: number; type: string; at: number }[]> {
    return storeOf(this.env, this.ctx.props).fileList(String(prefix)) as Promise<{ key: string; size: number; type: string; at: number }[]>;
  }
}

/**
 * The app's `env.SUITE`: what of the suite the app may use (§6.3). Its events, checked against its manifest; and as a
 * caller, with the ticket the host gave it for that caller's request, each use it declared in `uses`: never more than the
 * caller may do, and no token that could be taken elsewhere.
 */
export class AppSuite extends WorkerEntrypoint<HostedEnv, AppProps> {
  private org() {
    return this.env.ORG!.get(this.env.ORG!.idFromName(this.ctx.props.org));
  }

  /** `docs:read`: a Docs read path (DOCS_READ) as the caller: what the caller may read, nothing else. */
  async readDocs(ticket: string, path: string): Promise<unknown> {
    if (!DOCS_READ.test(String(path))) throw new Error('readDocs reads /api/files/<id>/text, /api/files/<id>/meta, /api/docs/<id>, /api/sheets/<id>, /api/decks/<id> or /api/markdown/<id>');
    const who = await this.org().appSuiteCaller({ organizationId: this.ctx.props.org, name: this.ctx.props.app, ticket, use: 'docs:read', ...(this.ctx.props.dev ? { dev: this.ctx.props.dev } : {}) });
    if (!who.ok) throw new Error(who.error);
    if (!this.env.DOCS) throw new Error('Docs is not here');
    const res = await this.env.DOCS.get(this.env.DOCS.idFromName(this.ctx.props.org)).handle(new Request(`https://suite.invalid${path}`), who.docs as never, this.ctx.props.org);
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error((body as { error?: string } | null)?.error ?? `Docs answered ${res.status}`);
    return body;
  }

  /** `chat:write`: a message in a channel, posted as the caller, where the caller may post. */
  async postMessage(ticket: string, channelId: string, text: string): Promise<{ id: string }> {
    const r = await this.org().postAsAppCaller({ organizationId: this.ctx.props.org, name: this.ctx.props.app, ticket, channelId: String(channelId), text: String(text).slice(0, 40_000), ...(this.ctx.props.dev ? { dev: this.ctx.props.dev } : {}) });
    if (!r.ok) throw new Error(r.error);
    return { id: r.id };
  }

  /** `members:read`: the organization's people and agents as the caller sees them (no emails, no guests), or those matching `search`. */
  async members(ticket: string, search?: string): Promise<unknown[]> {
    const r = await this.org().membersForAppCaller({ organizationId: this.ctx.props.org, name: this.ctx.props.app, ticket, ...(typeof search === 'string' ? { search: search.slice(0, 100) } : {}), ...(this.ctx.props.dev ? { dev: this.ctx.props.dev } : {}) });
    if (!r.ok) throw new Error(r.error);
    return r.members;
  }

  /** `files:read`: a Chat file's facts by its id (the id an agent sees in a message's attachments), as the caller. */
  async chatFile(ticket: string, fileId: string): Promise<AppChatFile> {
    const r = await this.org().chatFileForAppCaller({ organizationId: this.ctx.props.org, name: this.ctx.props.app, ticket, fileId: String(fileId), ...(this.ctx.props.dev ? { dev: this.ctx.props.dev } : {}) });
    if (!r.ok) throw new Error(r.error);
    return r.file;
  }

  /**
   * `files:read`: copies a Chat file the caller may open into the app's own files under `key` (by default
   * `chat/<file id>`). The copy is the app's from then on: its screen shows it under the app's rules, and it stays when
   * the Chat message or file is deleted.
   */
  async copyChatFile(ticket: string, fileId: string, key?: string): Promise<AppChatFile & { key: string }> {
    const id = String(fileId);
    const to = key === undefined || key === null || key === '' ? `chat/${id}` : String(key);
    fileKeyOf(this.env, this.ctx.props, to);
    const r = await this.org().chatFileForAppCaller({ organizationId: this.ctx.props.org, name: this.ctx.props.app, ticket, fileId: id, data: true, maxBytes: APP_FILE_MAX_BYTES, ...(this.ctx.props.dev ? { dev: this.ctx.props.dev } : {}) });
    if (!r.ok) throw new Error(r.error);
    await putAppFile(this.env, this.ctx.props, to, r.data!, r.file.type);
    return { ...r.file, key: to };
  }

  async publish(type: string, data?: unknown, ref?: { kind: string; id: string }, about?: string[]): Promise<{ id: string }> {
    const r = await this.org().publishHostedAppEvent({ organizationId: this.ctx.props.org, name: this.ctx.props.app, event: { type, data, ref, about }, ...(this.ctx.props.dev ? { dev: this.ctx.props.dev } : {}) });
    if (!r.ok) throw new Error(r.error);
    return { id: r.id };
  }
}

/** The app's `globalOutbound`: the hosts its manifest declared (§7.2), nothing else. */
export class AppEgress extends WorkerEntrypoint<HostedEnv, { allow: string[] }> {
  override async fetch(request: Request): Promise<Response> {
    const host = new URL(request.url).hostname;
    if (!this.ctx.props.allow.includes(host)) return new Response(`This app may not reach ${host}: its manifest does not list it under egress.`, { status: 403 });
    return fetch(request);
  }
}

/** The exports the runner binds an isolate with (`ctx.exports` of the Worker or of the object running it). */
export interface HostedExports {
  AppDb(opts: { props: AppProps }): Fetcher;
  AppSuite(opts: { props: AppProps }): Fetcher;
  AppEgress(opts: { props: { allow: string[] } }): Fetcher;
  AppFiles(opts: { props: AppProps }): Fetcher;
}

const decoder = new TextDecoder();

async function textOf(env: HostedEnv, key: string): Promise<string> {
  const o = await env.BLOBS!.get(key);
  if (!o) throw new Error(`the app's file ${key} is missing`);
  return decoder.decode(await o.arrayBuffer());
}

/** What an isolate runs: its files (by path, and how to read one), its store's props, the hosts it may reach, a cache key. */
export interface RunSource { key: string; files: Record<string, number>; read(path: string): Promise<string>; props: AppProps; egress: string[] }

/** An isolate for a source, kept by the Loader while warm under its key. Its migrations are applied before it is handed out. */
export async function sourceWorker(env: HostedEnv, exports: HostedExports, src: RunSource): Promise<WorkerStub> {
  if (!env.LOADER || !env.APP_STORE) throw new Error('this server cannot run hosted apps (no LOADER or APP_STORE)');
  const migrations = Object.keys(src.files).filter((p) => p.startsWith('migrations/'));
  if (migrations.length) {
    const sql = await Promise.all(migrations.map(async (p) => ({ name: p.slice('migrations/'.length), sql: await src.read(p) })));
    await storeOf(env, src.props).migrate(sql);
  }
  return env.LOADER.get(src.key, async () => ({
    compatibilityDate: '2026-10-01',
    compatibilityFlags: ['nodejs_compat'],
    mainModule: 'server.js',
    // The built-in SDK (§9.6) beside the app's code: `import { defineApp } from 'freeflow'`.
    modules: { 'server.js': await src.read('server.js'), [SDK_MODULE]: { js: FREEFLOW_SDK_SOURCE } },
    env: { DB: exports.AppDb({ props: src.props }), FILES: exports.AppFiles({ props: src.props }), SUITE: exports.AppSuite({ props: src.props }) },
    globalOutbound: exports.AppEgress({ props: { allow: src.egress } }),
    limits: { cpuMs: HOSTED_CPU_MS, subRequests: HOSTED_SUBREQUESTS },
  }));
}

/** The isolate of an app's installed version in an organization, its files in R2. */
export async function hostedWorker(env: HostedEnv, exports: HostedExports, org: string, code: HostedCode): Promise<WorkerStub> {
  if (!env.BLOBS) throw new Error('this server cannot run hosted apps (no BLOBS)');
  const app = code.manifest.name;
  return sourceWorker(env, exports, {
    key: `${org}:${app}:${code.version}:${code.prefix}`, files: code.files, read: (p) => textOf(env, code.prefix + p),
    props: { org, app }, egress: code.manifest.egress ?? [],
  });
}

/**
 * A draft's dev install (§9.3): its files from the draft, its own store apart from the install's, and no internet until an
 * admin approves a version. Only its author calls it, so every ticket it gets is the author's.
 */
export async function draftWorker(env: HostedEnv, exports: HostedExports, org: string, author: string, draft: { manifest: UserAppManifest; files: Record<string, Uint8Array>; key: string }): Promise<WorkerStub> {
  const app = draft.manifest.name;
  return sourceWorker(env, exports, {
    key: `dev:${org}:${app}:${author}:${draft.key}`,
    files: Object.fromEntries(Object.entries(draft.files).map(([p, b]) => [p, b.byteLength])),
    read: async (p) => {
      const b = draft.files[p];
      if (!b) throw new Error(`the draft has no ${p}`);
      return decoder.decode(b);
    },
    props: { org, app, dev: author },
    egress: [],
  });
}

/** A tool call to a hosted app (§5): the caller context and the input go in; `{ result }` or `{ error }` comes back. */
export async function callHostedTool(worker: WorkerStub, tool: string, input: unknown, caller: unknown): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
  let res: Response;
  try {
    res = await worker.getEntrypoint().fetch(new Request(`https://app.invalid${HOST_PATH}tool`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ v: 1, kind: 'tool', tool, input: input ?? {}, caller }),
    }));
  } catch (err) {
    return { ok: false, error: `the app failed: ${(err as Error).message}`.slice(0, 500) };
  }
  let answer: { result?: unknown; error?: unknown } | null;
  try { answer = (await res.json()) as { result?: unknown; error?: unknown } | null; } catch { answer = null; }
  if (!answer || typeof answer !== 'object') return { ok: false, error: `the app answered ${res.status} without JSON` };
  if (typeof answer.error === 'string') return { ok: false, error: answer.error.slice(0, 2000) };
  if (!res.ok) return { ok: false, error: `the app answered ${res.status}` };
  return { ok: true, result: answer.result ?? null };
}

// ---- the screen's host (§6.1): <app>--<org without dashes>.<apps domain> ----

/** The host label of an app in an organization: at most 20 + 2 + 32 = 54 characters, inside the 63 a label may hold. */
export const appHostLabel = (app: string, org: string): string => `${app}--${org.replace(/-/g, '')}`;

/** The app and organization a host on the apps domain names, or null. `domain` may carry a port (local development). */
export function parseAppHost(host: string, domain: string): { app: string; org: string } | null {
  const bare = domain.replace(/:\d+$/, '').toLowerCase();
  const h = host.replace(/:\d+$/, '').toLowerCase();
  if (!h.endsWith(`.${bare}`)) return null;
  const m = /^([a-z][a-z0-9]{1,19})--([0-9a-f]{32})$/.exec(h.slice(0, -bare.length - 1));
  if (!m) return null;
  const x = m[2]!;
  return { app: m[1]!, org: `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}` };
}

/** A draft's preview host label (§9.6): `dev-<id>--<org>`; the `-` keeps it apart from any app's label. */
export const devHostLabel = (devHost: string, org: string): string => `dev-${devHost}--${org.replace(/-/g, '')}`;

/** The draft preview and organization a host names, or null. */
export function parseDevHost(host: string, domain: string): { devHost: string; org: string } | null {
  const bare = domain.replace(/:\d+$/, '').toLowerCase();
  const h = host.replace(/:\d+$/, '').toLowerCase();
  if (!h.endsWith(`.${bare}`)) return null;
  const m = /^dev-([0-9a-f]{10})--([0-9a-f]{32})$/.exec(h.slice(0, -bare.length - 1));
  if (!m) return null;
  const x = m[2]!;
  return { devHost: m[1]!, org: `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}` };
}

/** The origin an app's screen is served from in an organization. */
export const appOrigin = (app: string, org: string, domain: string, scheme = 'https'): string => `${scheme}://${appHostLabel(app, org)}.${domain}`;
