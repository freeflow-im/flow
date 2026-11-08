// The one-time import's way in (packages/server/scripts/export-to-edge.ts). Only the origin can call it: it holds the same
// secret the Worker sends to Caddy. Rows go to the directory, an organization's Chat object or its Docs object; Docs' file
// bodies go to R2 under that object's prefix. Beside it, behind the same secret, the one-time move of Mail and Calendar
// from the per-person objects to the per-account ones (POST /v1/admin/accounts/rekey, platform.md §3.6).
import { timingSafeEqual } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { AwsClient } from 'aws4fetch';
import type { Docs } from '../docs/object';
import type { Directory } from '../directory/object';
import type { Org } from '../org/object';
import type { AccountDTO } from '@flow/shared';
import type { Calendar } from '../calendar/object';
import { CALENDAR_TABLES } from '../calendar/store';
import { MAIL_TABLES, type Mail } from '../imap/object';
import type { ImportRow } from '../importing';
import { EXPORT_PAGE } from '../perAccount';
import { directory } from './auth';

export interface AdminEnv {
  EDGE_ORIGIN_SECRET: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_ENDPOINT?: string;
  R2_BUCKET?: string;
  DIRECTORY: DurableObjectNamespace<Directory>;
  ORG: DurableObjectNamespace<Org>;
  DOCS: DurableObjectNamespace<Docs>;
  MAIL: DurableObjectNamespace<Mail>;
  CALENDAR: DurableObjectNamespace<Calendar>;
  BLOBS: R2Bucket;
}

export const adminRoutes = new Hono<{ Bindings: AdminEnv }>();

const requireSecret = async (c: Context<{ Bindings: AdminEnv }>, next: () => Promise<void>) => {
  const given = c.req.header('x-edge-secret') ?? '';
  const want = c.env.EDGE_ORIGIN_SECRET ?? '';
  const a = Buffer.from(given), b = Buffer.from(want);
  if (!want || a.length !== b.length || !timingSafeEqual(a, b)) return c.json({ error: 'forbidden' }, 403);
  await next();
};
adminRoutes.use('/edge/admin/*', requireSecret);
adminRoutes.use('/v1/admin/*', requireSecret);

const docsStub = (env: AdminEnv, org: string) => env.DOCS.get(env.DOCS.idFromName(org));

adminRoutes.post('/edge/admin/directory', async (c) => {
  const { table, rows } = await c.req.json<{ table: string; rows: ImportRow[] }>();
  const stub = c.env.DIRECTORY.get(c.env.DIRECTORY.idFromName('directory'));
  return c.json(await stub.importRows(table, rows));
});
adminRoutes.post('/edge/admin/org/:id', async (c) => {
  const { table, rows } = await c.req.json<{ table: string; rows: ImportRow[] }>();
  return c.json(await c.env.ORG.get(c.env.ORG.idFromName(c.req.param('id'))).importRows(table, rows));
});
adminRoutes.post('/edge/admin/org/:id/done', async (c) => c.json(await c.env.ORG.get(c.env.ORG.idFromName(c.req.param('id'))).importDone()));
adminRoutes.get('/edge/admin/org/:id/counts', async (c) => c.json(await c.env.ORG.get(c.env.ORG.idFromName(c.req.param('id'))).counts()));
adminRoutes.get('/edge/admin/docs/:id/counts', async (c) => c.json(await docsStub(c.env, c.req.param('id')).counts()));
adminRoutes.post('/edge/admin/docs/:id', async (c) => {
  const { table, rows } = await c.req.json<{ table: string; rows: ImportRow[] }>();
  return c.json(await docsStub(c.env, c.req.param('id')).importRows(table, rows, c.req.param('id')));
});
/**
 * A signed address to put a large Docs file body straight into R2, at the same key the route below would use. Cloudflare
 * refuses a request body over 100 MB, so a file larger than that cannot come through the Worker.
 */
adminRoutes.get('/edge/admin/docs/:id/upload-url', async (c) => {
  const rel = c.req.query('path') ?? '';
  if (!/^(sheets|files|images)\/[^/]+$/.test(rel)) return c.json({ error: 'bad path' }, 400);
  const e = c.env;
  if (!e.R2_ACCESS_KEY_ID || !e.R2_SECRET_ACCESS_KEY || !e.R2_ENDPOINT || !e.R2_BUCKET) return c.json({ error: 'the Worker has no R2 keys' }, 500);
  const key = `docs/${e.DOCS.idFromName(c.req.param('id')).toString()}/data/${rel}`;
  const url = new URL(`${e.R2_ENDPOINT.replace(/\/$/, '')}/${e.R2_BUCKET}/${key.split('/').map(encodeURIComponent).join('/')}`);
  url.searchParams.set('X-Amz-Expires', '3600');
  const client = new AwsClient({ accessKeyId: e.R2_ACCESS_KEY_ID, secretAccessKey: e.R2_SECRET_ACCESS_KEY, service: 's3', region: 'auto' });
  const signed = await client.sign(new Request(url, { method: 'PUT' }), { aws: { signQuery: true } });
  return c.json({ url: signed.url });
});

/** A Docs file body, at the key the object's file system will look for it (docs/runtime/fsp.ts). */
adminRoutes.put('/edge/admin/docs/:id/file/*', async (c) => {
  const rel = new URL(c.req.url).pathname.split('/file/')[1]!;
  if (!/^(sheets|files|images)\/[^/]+$/.test(decodeURIComponent(rel))) return c.json({ error: 'bad path' }, 400);
  const prefix = `docs/${c.env.DOCS.idFromName(c.req.param('id')).toString()}/data/`;
  await c.env.BLOBS.put(prefix + decodeURIComponent(rel), c.req.raw.body);
  return c.json({ ok: true });
});

/** One object's rows into another of its kind, a page at a time: how many rows each table had. */
async function copyRows(
  from: { exportRows(o: { table?: string; offset?: number; limit?: number }): Promise<{ table: string; rows: ImportRow[] }[]> },
  to: { importRows(table: string, rows: ImportRow[]): Promise<{ added: number }> },
  tables: readonly string[], prefix: string, counts: Record<string, number>,
): Promise<void> {
  for (const table of tables) {
    let offset = 0;
    for (;;) {
      const rows = (await from.exportRows({ table, offset, limit: EXPORT_PAGE }))[0]?.rows ?? [];
      if (rows.length) await to.importRows(table, rows);
      offset += rows.length;
      if (rows.length < EXPORT_PAGE) break;
    }
    if (offset) counts[`${prefix}.${table}`] = offset;
  }
}

/**
 * The one-time move (platform.md §11, phase 1 item 4): each person's Mail and Calendar rows, from the objects named by
 * their user id to the ones named by their account's id, `INSERT OR IGNORE`, so it can run again; the old objects are left
 * as they were (the rollback). The account is the person's only one, else the earliest made that is not removed: `others`
 * lists the rest, for the operator to move by hand. `{ users: [...] }` limits a run to those people (a Worker request
 * may make only so many calls).
 */
adminRoutes.post('/v1/admin/accounts/rekey', async (c) => {
  const only = ((await c.req.json().catch(() => ({}))) as { users?: unknown }).users;
  const wanted = Array.isArray(only) ? new Set(only.filter((u): u is string => typeof u === 'string')) : null;
  const people = (await directory(c as never, 'principalsWithAccounts')) as { userId: string; accounts: AccountDTO[] }[];
  const moved: { userId: string; accountId: string; tables: Record<string, number>; others?: string[] }[] = [];
  const skipped: { userId: string; reason: string }[] = [];
  for (const { userId, accounts } of people) {
    if (wanted && !wanted.has(userId)) continue;
    if (!accounts.length) { skipped.push({ userId, reason: 'no account' }); continue; }
    const target = accounts.find((a) => a.state !== 'removed') ?? accounts[0]!;
    const tables: Record<string, number> = {};
    await copyRows(c.env.MAIL.get(c.env.MAIL.idFromName(userId)), c.env.MAIL.get(c.env.MAIL.idFromName(target.id)), MAIL_TABLES, 'mail', tables);
    await copyRows(c.env.CALENDAR.get(c.env.CALENDAR.idFromName(userId)), c.env.CALENDAR.get(c.env.CALENDAR.idFromName(target.id)), CALENDAR_TABLES, 'calendar', tables);
    const others = accounts.filter((a) => a.id !== target.id).map((a) => a.id);
    if (!Object.keys(tables).length) { skipped.push({ userId, reason: 'nothing to move' }); continue; }
    moved.push({ userId, accountId: target.id, tables, ...(others.length ? { others } : {}) });
  }
  return c.json({ moved, skipped });
});
