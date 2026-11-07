// One organization's Docs: its own SQLite, with bodies in R2 under its prefix. Beside the organization's Chat object rather than
// inside it: both apps have `users`, `sessions` and `folders` tables, and a heavy save here should not hold up a message there.
import { DurableObject } from 'cloudflare:workers';
import type { Directory } from '../directory/object';
import { formatReference, type AccountDTO } from '@flow/shared';
import type { CallerContext } from '../org/routes/compat';
import { currentOrganization, withDocsContext, type DocsContext } from './runtime/context.ts';
import { DocsApp, type Caller, type DocsRequest } from './runtime/fastify.ts';
import { buildApp } from './server/app.ts';
import { insertRows, tableCounts } from '../importing';
import { setBrowserBinding } from './server/pdf.ts';
import { setOcrBinding } from './runtime/pdfOcr.ts';
import { handleMcp, handleMcpImport, suiteHub, type McpRequestCaller } from './plugin/server/worker.ts';
import type { FileHub } from './plugin/server/files.ts';
import { DatabaseSync } from './runtime/sqlite.ts';
import { PREVIEW_TTL_MS, Previews } from './server/previews.ts';
import { importBytes, type ImportStores } from './server/importFile.ts';
import type { MailToolContext } from '../imap/mailTools.ts';
import { lazySubscriptions, subscriptionsAs, type SubscriptionOps } from '../events/subscriptions.ts';
import { docsAddress } from './addresses.ts';
import { calendarRequest, type AccountCaller } from '../calendar/forward';
import type { FileChange, GrantChange } from './server/app.ts';

export interface DocsEnv {
  BLOBS: R2Bucket;
  /** The deployment's data key (org/crypto): also seals the assistant's keys and connector credentials in this object. */
  FLOW_DATA_KEY?: string;
  DIRECTORY: DurableObjectNamespace<Directory>;
  FLOW_WEB_URL?: string;
  ANTHROPIC_API_KEY?: string;
  BROWSER?: Fetcher;
  /** The PdfOcr container (src/pdfOcr.ts), for scanned PDFs. */
  PDF_OCR?: DurableObjectNamespace;
  /** FreeFlow Mail's objects, one per account (src/imap/object.ts): the MCP endpoint's Mail tools act on the caller's account's here. */
  MAIL?: DurableObjectNamespace<import('../imap/object').Mail>;
  CALENDAR?: DurableObjectNamespace<import('../calendar/object').Calendar>;
  /** The organizations' event logs and Chat objects: the MCP endpoint's event tools read subscriptions as the caller's account. */
  EVENTS?: DurableObjectNamespace<import('../events/object').Events>;
  ORG?: DurableObjectNamespace<import('../org/object').Org>;
}
const BASE = '/workspace';
/** A file's saves publish `docs.file.changed` at most this often, so a typing session does not flood the log. */
export const FILE_CHANGED_EVERY_MS = 30_000;

/** Mail's or Calendar's namespace, as the tools reach an account's object. */
type AccountObjects = { idFromName(name: string): DurableObjectId; get(id: DurableObjectId): { handle(request: Request, caller: CallerContext): Promise<Response> } };

export class Docs extends DurableObject<DocsEnv> {
  private readonly app = new DocsApp();
  private readonly context: DocsContext;
  private readonly ready: Promise<unknown>;
  /** The MCP endpoint's view of this object's stores (plugin/server/worker.ts), made once the app has opened them. */
  private hub: FileHub | null = null;
  /** Where the assistant's save_mail_attachment_to_docs imports to: the app's own stores, once it has opened them. */
  private importStores: ImportStores | null = null;
  /** When each file last published `docs.file.changed` (in memory: an evicted object may publish one more). */
  private readonly changedAt = new Map<string, number>();
  /** Owners' accounts in an organization, asked of the directory once each. */
  private readonly ownerAccounts = new Map<string, Promise<string | null>>();

  constructor(ctx: DurableObjectState, env: DocsEnv) {
    super(ctx, env);
    setBrowserBinding(env.BROWSER ?? null);
    setOcrBinding(env.PDF_OCR ?? null);
    // The headless browser loads Docs' print pages from the public address, through the Worker like any visitor.
    process.env.PRINT_ORIGIN = (env.FLOW_WEB_URL ?? 'https://app.freeflow.im').replace(/\/+$/, '');
    // The assistant's keys and the connectors' credentials are sealed with CONNECTOR_ENCRYPTION_KEY (connectors/secrets.ts
    // loadKey); with none, and no key file on the object's disk, it would be a random key per instance, and a saved key
    // stopped working whenever the object restarted. FLOW_DATA_KEY is the deployment's one secret, so it stands in.
    if (!process.env.CONNECTOR_ENCRYPTION_KEY && env.FLOW_DATA_KEY) process.env.CONNECTOR_ENCRYPTION_KEY = env.FLOW_DATA_KEY;
    this.context = {
      sql: ctx.storage.sql,
      bucket: env.BLOBS,
      prefix: `docs/${ctx.id.toString()}/`,
      transactionSync: (fn) => ctx.storage.transactionSync(fn),
    };
    this.ready = withDocsContext(this.context, () => this.build());
    void ctx.blockConcurrencyWhile(async () => { await this.ready; });
  }

  private directory<T>(method: string, ...args: unknown[]): Promise<T> {
    const stub = this.env.DIRECTORY.get(this.env.DIRECTORY.idFromName('directory'));
    return (stub.call as never as (m: string, a: unknown[]) => Promise<{ ok: boolean; value: T }>)(method, args).then((a) => a.value);
  }

  private build(): Promise<unknown> {
    const base = (this.env.FLOW_WEB_URL ?? 'https://app.freeflow.im').replace(/\/+$/, '');
    const callerOf = (req: DocsRequest) => req.caller;
    return (buildApp as never as (o: unknown) => Promise<unknown>)({
      dataDir: 'data',
      logger: false,
      appUrl: base,
      agent: { jobs: false, mail: (userId: string, scope: unknown) => this.assistantMail(userId, scope, base, currentOrganization()), calendar: (userId: string) => this.assistantCalendar(userId, base, currentOrganization()) },
      host: {
        app: this.app,
        basePath: BASE,
        signInUrl: `${base}/`,
        authenticate: async (req: DocsRequest) => {
          const c = callerOf(req);
          return c.userId ? { id: c.userId, email: c.email ?? '' } : null;
        },
        signOut: async () => {},
        userForCookie: async () => null,
        isMember: async (userId: string, organizationId: string) => (await this.directory<string[]>('organizationsOf', userId)).includes(organizationId),
        organizationsOf: async (userId: string) => this.directory<string[]>('organizationsOf', userId),
        // Grants are matched against the caller context the Worker resolved (routes/docs.ts; docs/server/access.ts).
        readerOf: (req: DocsRequest) => ({ accountId: req.caller.accountId ?? null, channelIds: req.caller.channelIds ?? [] }),
        isAccountOf: async (accountId: string, organizationId: string) => !!this.env.ORG && (await this.env.ORG.get(this.env.ORG.idFromName(organizationId)).isActiveAccount(accountId)),
        linkSharing: async (organizationId: string) => (await this.directory<{ policies?: { linkSharing?: boolean } } | null>('organization', organizationId))?.policies?.linkSharing !== false,
        onGrantChange: (change: GrantChange) => this.reportGrant(change),
        onFileChanged: (change: FileChange) => this.fileChanged(change),
        stores: (stores: Parameters<typeof suiteHub>[0]) => {
          this.hub = suiteHub(stores, `${base}/workspace`);
          if (stores.sheets && stores.images && stores.files) this.importStores = { sheets: stores.sheets, images: stores.images, files: stores.files };
        },
      },
    });
  }

  /** A Docs object's reference (platform.md §4.1): what the share index and the bus name it by. */
  private static refOf(c: { workspaceId: string; kind: string; id: string }): string {
    return formatReference({ organizationId: c.workspaceId, app: 'docs', kind: c.kind, id: c.id });
  }

  /**
   * A grant change, reported to the organization's share index (platform.md §4.5) by binding. Fire-and-forget: the
   * request does not wait for the index, and a failure is logged.
   */
  private reportGrant(c: GrantChange): void {
    const ns = this.env.ORG;
    if (!ns) return;
    const org = ns.get(ns.idFromName(c.workspaceId));
    const ref = Docs.refOf(c);
    const sent = c.role
      ? org.recordShare({ ref, principal: c.principal, role: c.role, grantedBy: c.actor, title: c.title, kind: c.fileKind, ...(c.silent ? { silent: true } : {}) })
      : org.revokeShare({ ref, principal: c.principal, revokedBy: c.actor });
    this.ctx.waitUntil(Promise.resolve(sent).catch((err: Error) => console.error(`[docs] share index, ${c.principal} on ${ref}: ${err.message}`)));
  }

  /**
   * A document saved (or renamed): `docs.file.changed` into the organization's event log, for whoever it is shared with
   * (the `ref:` audience, read from the share index) and its owner, at most once per FILE_CHANGED_EVERY_MS per file.
   */
  private fileChanged(c: FileChange): void {
    const ns = this.env.EVENTS;
    if (!ns) return;
    const now = Date.now();
    if (now - (this.changedAt.get(c.id) ?? -Infinity) < FILE_CHANGED_EVERY_MS) return;
    this.changedAt.set(c.id, now);
    if (this.changedAt.size > 5_000) this.changedAt.clear();
    const ref = Docs.refOf(c);
    const key = `${c.workspaceId}|${c.ownerId}`;
    let owner = this.ownerAccounts.get(key);
    if (!owner) {
      owner = this.directory<AccountDTO | null>('accountFor', c.ownerId, c.workspaceId).then((a) => a?.id ?? null, () => null);
      this.ownerAccounts.set(key, owner);
    }
    const sent = owner.then((ownerAccountId) =>
      ns.get(ns.idFromName(c.workspaceId)).publish({
        type: 'docs.file.changed',
        organizationId: c.workspaceId,
        actor: null,
        ref: { organizationId: c.workspaceId, app: 'docs', kind: c.kind, id: c.id },
        audience: `ref:${ref}`,
        ts: new Date(now).toISOString(),
        data: { ref, kind: c.fileKind, id: c.id, title: c.title, ownerAccountId, url: docsAddress({ organizationId: c.workspaceId, app: 'docs', kind: c.kind, id: c.id }, c.fileKind) },
      }),
    );
    this.ctx.waitUntil(sent.catch((err: Error) => console.error(`[docs] docs.file.changed for ${ref}: ${err.message}`)));
  }

  /**
   * New file ids, reported to the directory so that a request naming only a file finds this object (routes/docs.ts); so
   * are the tokens of new links (`link:<token>` grants), so that a guest's request for a public link finds it too.
   */
  private outbox(): void {
    const sql = this.ctx.storage.sql;
    sql.exec('CREATE TABLE IF NOT EXISTS _outbox (seq INTEGER PRIMARY KEY, kind TEXT NOT NULL, id TEXT NOT NULL, user_id TEXT, role TEXT, payload TEXT)');
    for (const table of ['sheets', 'stored_files', 'images']) {
      sql.exec(`CREATE TRIGGER IF NOT EXISTS _index_${table} AFTER INSERT ON ${table} BEGIN INSERT INTO _outbox (kind, id) VALUES ('index', NEW.id); END`);
    }
    sql.exec("CREATE TRIGGER IF NOT EXISTS _index_links AFTER INSERT ON grants WHEN NEW.principal LIKE 'link:%' BEGIN INSERT INTO _outbox (kind, id) VALUES ('index', substr(NEW.principal, 6)); END");
    // Once: the tokens the move to grants made from the old public links (server/access.ts' migrateToGrants) predate the
    // trigger, so a guest's request for one found no organization; they go to the directory as new ones do.
    sql.exec('CREATE TABLE IF NOT EXISTS _once (name TEXT PRIMARY KEY)');
    if (!sql.exec("SELECT 1 FROM _once WHERE name = 'link_tokens'").toArray().length) {
      sql.exec("INSERT INTO _outbox (kind, id) SELECT 'index', substr(principal, 6) FROM grants WHERE principal LIKE 'link:%'");
      sql.exec("INSERT INTO _once (name) VALUES ('link_tokens')");
    }
  }

  private async flush(organizationId: string): Promise<void> {
    const sql = this.ctx.storage.sql;
    const rows = sql.exec('SELECT * FROM _outbox ORDER BY seq').toArray();
    if (!rows.length) return;
    const stub = this.env.DIRECTORY.get(this.env.DIRECTORY.idFromName('directory'));
    const answer = await (stub.call as never as (m: string, a: unknown[]) => Promise<{ ok: boolean }>)('applyOrgChanges', [organizationId, rows]);
    if (answer.ok) sql.exec('DELETE FROM _outbox WHERE seq <= ?', rows.at(-1)!.seq as number);
  }

  /** The one-time import (routes/admin.ts). The object's tables are made first, by building the app as any request does. */
  async importRows(table: string, rows: Record<string, unknown>[], organizationId: string): Promise<{ added: number }> {
    const added = await withDocsContext(this.context, async () => {
      await this.ready;
      this.outbox();
      return insertRows(this.ctx.storage.sql, table, rows);
    });
    await this.flush(organizationId);
    return { added };
  }

  /** Row counts per table, to compare an import with its source. */
  async counts(): Promise<Record<string, number>> {
    return withDocsContext(this.context, async () => { await this.ready; return tableCounts(this.ctx.storage.sql); });
  }

  /** A request to /mcp, authenticated by the Worker against the directory (routes/mcp.ts), as `caller` in this organization. */
  async mcp(request: Request, caller: McpRequestCaller): Promise<Response> {
    return this.inOrganization(caller.orgId, () => handleMcp(request, this.hub!, caller, this.mailOf(caller.userId, caller.origin, caller.orgId), this.calendarOf(caller.userId, caller.origin, caller.orgId), this.eventsOf(caller.userId, caller.orgId), this.memberOf(caller.orgId)));
  }

  /**
   * The assistant's mail tools (server/agent/tools.ts): the Mail object of the person's account here, and saving an attachment into the
   * chat's scope (their My files in this organization) with the importer the preview's Save to Docs uses.
   */
  private assistantMail(userId: string, scope: unknown, origin: string, organizationId: string | undefined): MailToolContext | undefined {
    const mail = organizationId ? this.mailOf(userId, origin, organizationId) : undefined;
    const stores = this.importStores;
    if (!mail) return undefined;
    return {
      mail,
      origin,
      ...(stores
        ? {
            saveToDocs: async (bytes: Buffer, filename: string) => {
              const made = await importBytes(stores, scope as never, bytes, filename, undefined);
              const file = made.sheet
                ? { id: made.sheet.id, kind: made.sheet.kind, title: made.sheet.title, [made.sheet.kind === 'deck' ? 'deck_id' : made.sheet.kind === 'sheet' ? 'sheet_id' : 'doc_id']: made.sheet.id }
                : { id: made.file!.id, kind: 'file', file_id: made.file!.id, filename: made.file!.filename, type: made.file!.type };
              return { file, warnings: made.warnings ?? [] };
            },
          }
        : {}),
    };
  }

  /**
   * The caller context for the Mail and Calendar objects of the person's account in this organization (platform.md §3.6),
   * asked of the directory once per tool context. Null for no account here, or one suspended or removed.
   */
  private accountCaller(userId: string, organizationId: string): () => Promise<CallerContext | null> {
    let found: Promise<CallerContext | null> | null = null;
    return () =>
      (found ??= this.directory<AccountDTO | null>('accountFor', userId, organizationId).then((account) =>
        account && account.state !== 'suspended' && account.state !== 'removed' ? { user: null, token: null, authKind: null, ip: '', organizationId, account } : null,
      ));
  }

  /** A per-account object's HTTP API, as the tools call it: the account's object, or a 403 `no_account`. */
  private accountFetch(ns: AccountObjects, app: string, userId: string, origin: string, organizationId: string) {
    const caller = this.accountCaller(userId, organizationId);
    return async (path: string, init?: RequestInit): Promise<Response> => {
      const who = await caller();
      if (!who?.account) return Response.json({ error: { code: 'no_account', message: `join an organization to use ${app}` } }, { status: 403 });
      return ns.get(ns.idFromName(who.account.id)).handle(new Request(`${origin}${path}`, init), who);
    };
  }

  /**
   * The Mail object of the person's account in this organization, as its HTTP API (docs/specs/mail-api.md), for the Mail
   * tools. Undefined where the Worker has no Mail.
   */
  private mailOf(userId: string, origin: string, organizationId: string): ((path: string, init?: RequestInit) => Promise<Response>) | undefined {
    const ns = this.env.MAIL;
    return ns ? this.accountFetch(ns as unknown as AccountObjects, 'Mail', userId, origin, organizationId) : undefined;
  }

  /**
   * The Calendar object of the person's account in this organization, as its HTTP API (docs/specs/calendar.md §4), for the
   * Calendar tools. Undefined where the Worker has no Calendar.
   */
  private calendarOf(userId: string, origin: string, organizationId: string): ((path: string, init?: RequestInit) => Promise<Response>) | undefined {
    const { CALENDAR: ns, ORG: org } = this.env;
    if (!ns) return undefined;
    if (!org) return this.accountFetch(ns as unknown as AccountObjects, 'Calendar', userId, origin, organizationId);
    // As the routes do (calendar/forward.ts): a shared calendar's id reaches its owner's object, `/shared` the share index.
    const caller = this.accountCaller(userId, organizationId);
    return async (path: string, init?: RequestInit): Promise<Response> => {
      const who = await caller();
      if (!who?.account) return Response.json({ error: { code: 'no_account', message: 'join an organization to use Calendar' } }, { status: 403 });
      return calendarRequest({ CALENDAR: ns, ORG: org }, new Request(`${origin}${path}`, init), who as AccountCaller, userId);
    };
  }

  /** An address of an account in this organization (not suspended or removed), for share_calendar; null for anyone else. */
  private memberOf(organizationId: string): (address: string) => Promise<{ accountId: string; name: string } | null> {
    return async (address) => {
      const a = await this.directory<AccountDTO | null>('accountByAddress', address).catch(() => null);
      return a && a.organizationId === organizationId && a.state !== 'suspended' && a.state !== 'removed' ? { accountId: a.id, name: a.displayName ?? address } : null;
    };
  }

  /** The organization's event subscriptions as the person's account here, for the event tools. Undefined where the Worker has no Events. */
  private eventsOf(userId: string, organizationId: string): SubscriptionOps | undefined {
    const { EVENTS: events, ORG: org } = this.env;
    if (!events || !org) return undefined;
    const caller = this.accountCaller(userId, organizationId);
    return lazySubscriptions(async () => {
      const who = await caller();
      if (!who?.account) throw Object.assign(new Error('no account in this organization'), { status: 403 });
      return subscriptionsAs(events.get(events.idFromName(organizationId)), org.get(org.idFromName(organizationId)), who.account.id, userId, who.account.role, organizationId);
    });
  }

  /** The assistant's Calendar tools (server/agent/tools.ts): the Calendar object of the person's account here. */
  private assistantCalendar(userId: string, origin: string, organizationId: string | undefined): import('../calendar/calendarTools').CalendarToolContext | undefined {
    const calendar = organizationId ? this.calendarOf(userId, origin, organizationId) : undefined;
    return calendar && organizationId ? { calendar, origin, member: this.memberOf(organizationId) } : undefined;
  }

  /** An agent's upload to the address upload_file gave it; the ticket in it is the credential. */
  async mcpImport(request: Request, organizationId: string): Promise<Response> {
    return this.inOrganization(organizationId, () => handleMcpImport(request, this.hub!));
  }

  private async inOrganization(organizationId: string, fn: () => Promise<Response>): Promise<Response> {
    const res = await withDocsContext({ ...this.context, organizationId }, async () => {
      await this.ready;
      this.outbox();
      return fn();
    });
    await this.flush(organizationId);
    return res;
  }

  async handle(request: Request, caller: Caller, organizationId: string): Promise<Response> {
    const res = await withDocsContext({ ...this.context, organizationId }, async () => {
      await this.ready;
      this.outbox();
      return this.app.handle(request, caller);
    });
    await this.flush(organizationId);
    // A preview was made (server/previews.ts): the alarm removes it once it expires, if no use has swept it before.
    if (request.method === 'POST' && new URL(request.url).pathname === '/api/previews' && res.ok && (await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + PREVIEW_TTL_MS + 60_000);
    }
    return res;
  }

  /** Expired previews and their files go; the alarm is set again for the next one to expire, while any is left. */
  async alarm(): Promise<void> {
    const next = await withDocsContext(this.context, async () => {
      await this.ready;
      return new Previews(new DatabaseSync() as never, 'data/previews').sweep();
    });
    if (next !== null) await this.ctx.storage.setAlarm(next + 60_000);
  }
}
