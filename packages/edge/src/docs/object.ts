// One organization's Docs: its own SQLite, with bodies in R2 under its prefix. Beside the organization's Chat object rather than
// inside it: both apps have `users`, `sessions` and `folders` tables, and a heavy save here should not hold up a message there.
import { DurableObject } from 'cloudflare:workers';
import type { Directory } from '../directory/object';
import { withDocsContext, type DocsContext } from './runtime/context.ts';
import { DocsApp, type Caller, type DocsRequest } from './runtime/fastify.ts';
import { buildApp } from './server/app.ts';
import { insertRows, tableCounts } from '../importing';
import { setBrowserBinding } from './server/pdf.ts';

export interface DocsEnv {
  BLOBS: R2Bucket;
  DIRECTORY: DurableObjectNamespace<Directory>;
  FLOW_WEB_URL?: string;
  ANTHROPIC_API_KEY?: string;
  BROWSER?: Fetcher;
}
const BASE = '/workspace';

export class Docs extends DurableObject<DocsEnv> {
  private readonly app = new DocsApp();
  private readonly context: DocsContext;
  private readonly ready: Promise<unknown>;

  constructor(ctx: DurableObjectState, env: DocsEnv) {
    super(ctx, env);
    setBrowserBinding(env.BROWSER ?? null);
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
      agent: { jobs: false },
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

  async handle(request: Request, caller: Caller, organizationId: string): Promise<Response> {
    const res = await withDocsContext(this.context, async () => {
      await this.ready;
      this.outbox();
      return this.app.handle(request, caller);
    });
    await this.flush(organizationId);
    return res;
  }
}
