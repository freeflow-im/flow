// One organization's Docs: its own SQLite, with bodies in R2 under its prefix. Beside the organization's Chat object rather than
// inside it: both apps have `users`, `sessions` and `folders` tables, and a heavy save here should not hold up a message there.
import { DurableObject } from 'cloudflare:workers';
import type { Directory } from '../directory/object';
import { withDocsContext, type DocsContext } from './runtime/context.ts';
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

export interface DocsEnv {
  BLOBS: R2Bucket;
  DIRECTORY: DurableObjectNamespace<Directory>;
  FLOW_WEB_URL?: string;
  ANTHROPIC_API_KEY?: string;
  BROWSER?: Fetcher;
  /** The PdfOcr container (src/pdfOcr.ts), for scanned PDFs. */
  PDF_OCR?: DurableObjectNamespace;
  /** FreeFlow Mail's objects, one per person (src/imap/object.ts): the MCP endpoint's Mail tools act on the caller's. */
  MAIL?: DurableObjectNamespace<import('../imap/object').Mail>;
  CALENDAR?: DurableObjectNamespace<import('../calendar/object').Calendar>;
}
const BASE = '/workspace';

export class Docs extends DurableObject<DocsEnv> {
  private readonly app = new DocsApp();
  private readonly context: DocsContext;
  private readonly ready: Promise<unknown>;
  /** The MCP endpoint's view of this object's stores (plugin/server/worker.ts), made once the app has opened them. */
  private hub: FileHub | null = null;
  /** Where the assistant's save_mail_attachment_to_docs imports to: the app's own stores, once it has opened them. */
  private importStores: ImportStores | null = null;

  constructor(ctx: DurableObjectState, env: DocsEnv) {
    super(ctx, env);
    setBrowserBinding(env.BROWSER ?? null);
    setOcrBinding(env.PDF_OCR ?? null);
    // The headless browser loads Docs' print pages from the public address, through the Worker like any visitor.
    process.env.PRINT_ORIGIN = (env.FLOW_WEB_URL ?? 'https://app.freeflow.im').replace(/\/+$/, '');
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
      agent: { jobs: false, mail: (userId: string, scope: unknown) => this.assistantMail(userId, scope, base), calendar: (userId: string) => this.assistantCalendar(userId, base) },
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
        stores: (stores: Parameters<typeof suiteHub>[0]) => {
          this.hub = suiteHub(stores, `${base}/workspace`);
          if (stores.sheets && stores.images && stores.files) this.importStores = { sheets: stores.sheets, images: stores.images, files: stores.files };
        },
      },
    });
  }

  /** New file ids, reported to the directory so that a request naming only a file finds this object (routes/docs.ts). */
  private outbox(): void {
    const sql = this.ctx.storage.sql;
    sql.exec('CREATE TABLE IF NOT EXISTS _outbox (seq INTEGER PRIMARY KEY, kind TEXT NOT NULL, id TEXT NOT NULL, user_id TEXT, role TEXT, payload TEXT)');
    for (const table of ['sheets', 'stored_files', 'images']) {
      sql.exec(`CREATE TRIGGER IF NOT EXISTS _index_${table} AFTER INSERT ON ${table} BEGIN INSERT INTO _outbox (kind, id) VALUES ('index', NEW.id); END`);
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
    return this.inOrganization(caller.orgId, () => handleMcp(request, this.hub!, caller, this.mailOf(caller.userId, caller.origin), this.calendarOf(caller.userId, caller.origin)));
  }

  /**
   * The assistant's mail tools (server/agent/tools.ts): the person's own Mail object, and saving an attachment into the
   * chat's scope (their My files in this organization) with the importer the preview's Save to Docs uses.
   */
  private assistantMail(userId: string, scope: unknown, origin: string): MailToolContext | undefined {
    const mail = this.mailOf(userId, origin);
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
   * A person's own Mail object, as its HTTP API (docs/specs/mail-api.md), for the Mail tools: mail is a person's, so this
   * is theirs whatever organization this object is. Undefined where the Worker has no Mail.
   */
  private mailOf(userId: string, origin: string): ((path: string, init?: RequestInit) => Promise<Response>) | undefined {
    const ns = this.env.MAIL;
    if (!ns) return undefined;
    return (path, init) => ns.get(ns.idFromName(userId)).handle(new Request(`${origin}${path}`, init));
  }

  /**
   * A person's own Calendar object, as its HTTP API (docs/specs/calendar.md §4), for the Calendar tools: calendars are a
   * person's, so this is theirs whatever organization this object is. Undefined where the Worker has no Calendar.
   */
  private calendarOf(userId: string, origin: string): ((path: string, init?: RequestInit) => Promise<Response>) | undefined {
    const ns = this.env.CALENDAR;
    if (!ns) return undefined;
    return (path, init) => ns.get(ns.idFromName(userId)).handle(new Request(`${origin}${path}`, init));
  }

  /** The assistant's Calendar tools (server/agent/tools.ts): the person's own Calendar object. */
  private assistantCalendar(userId: string, origin: string): import('../calendar/calendarTools').CalendarToolContext | undefined {
    const calendar = this.calendarOf(userId, origin);
    return calendar ? { calendar, origin } : undefined;
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
