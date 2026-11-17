// Hosted user apps (docs/specs/user-apps.md §7.2, §8; decision_log 2026-11-17): an app version's server code, kept as
// text in R2, loaded into an isolate of its own by the Worker Loader. The isolate's env holds only the entrypoints below,
// each bound to its app and organization by `ctx.props`, which the app cannot change:
//
//   DB     AppDb      SQL on the app's store in this organization (AppStore, one Durable Object per app and organization)
//   SUITE  AppSuite   the suite as the app may use it: publish its events (§5.1); `uses` methods come in step 4
//
// and its `globalOutbound` is AppEgress, which lets it reach only the hosts its manifest declared. A tool call reaches
// the app as a request the host makes (`POST https://app.invalid/__freeflow/tool`), with the caller context in the body.
import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';
import type { UserAppManifest } from '@flow/shared';

/** What the runner needs of a hosted app's installed version (the Org object's `installedCode`). */
export interface HostedCode { manifest: UserAppManifest; version: number; prefix: string; files: Record<string, number> }

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
}

/** The props every app entrypoint is bound with. */
export interface AppProps { org: string; app: string }

/** One SQL statement and its parameters. */
export interface Statement { sql: string; params?: unknown[] }

const storeOf = (env: HostedEnv, p: AppProps) => env.APP_STORE!.get(env.APP_STORE!.idFromName(`${p.app}:${p.org}`));

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

/** The app's `env.SUITE`: what of the suite the app may use. Publishing its own events, checked against its manifest. */
export class AppSuite extends WorkerEntrypoint<HostedEnv, AppProps> {
  async publish(type: string, data?: unknown, ref?: { kind: string; id: string }, about?: string[]): Promise<{ id: string }> {
    const org = this.env.ORG!.get(this.env.ORG!.idFromName(this.ctx.props.org));
    const r = await org.publishHostedAppEvent({ organizationId: this.ctx.props.org, name: this.ctx.props.app, event: { type, data, ref, about } });
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
}

const decoder = new TextDecoder();

async function textOf(env: HostedEnv, key: string): Promise<string> {
  const o = await env.BLOBS!.get(key);
  if (!o) throw new Error(`the app's file ${key} is missing`);
  return decoder.decode(await o.arrayBuffer());
}

/**
 * The isolate of an app's installed version in an organization, loaded once per (organization, app, version, upload) and
 * kept by the Loader while warm. Its migrations are applied before it is handed out.
 */
export async function hostedWorker(env: HostedEnv, exports: HostedExports, org: string, code: HostedCode): Promise<WorkerStub> {
  if (!env.LOADER || !env.BLOBS || !env.APP_STORE) throw new Error('this server cannot run hosted apps (no LOADER, BLOBS or APP_STORE)');
  const app = code.manifest.name;
  const migrations = Object.keys(code.files).filter((p) => p.startsWith('migrations/'));
  if (migrations.length) {
    const sql = await Promise.all(migrations.map(async (p) => ({ name: p.slice('migrations/'.length), sql: await textOf(env, code.prefix + p) })));
    await storeOf(env, { org, app }).migrate(sql);
  }
  return env.LOADER.get(`${org}:${app}:${code.version}:${code.prefix}`, async () => ({
    compatibilityDate: '2026-10-01',
    compatibilityFlags: ['nodejs_compat'],
    mainModule: 'server.js',
    modules: { 'server.js': await textOf(env, `${code.prefix}server.js`) },
    env: { DB: exports.AppDb({ props: { org, app } }), SUITE: exports.AppSuite({ props: { org, app } }) },
    globalOutbound: exports.AppEgress({ props: { allow: code.manifest.egress ?? [] } }),
    limits: { cpuMs: HOSTED_CPU_MS, subRequests: HOSTED_SUBREQUESTS },
  }));
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
