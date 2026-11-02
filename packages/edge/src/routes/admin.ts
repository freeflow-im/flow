// The one-time import's way in (packages/server/scripts/export-to-edge.ts). Only the origin can call it: it holds the same
// secret the Worker sends to Caddy. Rows go to the directory, an organization's Chat object or its Docs object; Docs' file
// bodies go to R2 under that object's prefix.
import { timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import type { Docs } from '../docs/object';
import type { Directory } from '../directory/object';
import type { Org } from '../org/object';
import type { ImportRow } from '../importing';

export interface AdminEnv {
  EDGE_ORIGIN_SECRET: string;
  DIRECTORY: DurableObjectNamespace<Directory>;
  ORG: DurableObjectNamespace<Org>;
  DOCS: DurableObjectNamespace<Docs>;
  BLOBS: R2Bucket;
}

export const adminRoutes = new Hono<{ Bindings: AdminEnv }>();

adminRoutes.use('/edge/admin/*', async (c, next) => {
  const given = c.req.header('x-edge-secret') ?? '';
  const want = c.env.EDGE_ORIGIN_SECRET ?? '';
  const a = Buffer.from(given), b = Buffer.from(want);
  if (!want || a.length !== b.length || !timingSafeEqual(a, b)) return c.json({ error: 'forbidden' }, 403);
  await next();
});

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
/** A Docs file body, at the key the object's file system will look for it (docs/runtime/fsp.ts). */
adminRoutes.put('/edge/admin/docs/:id/file/*', async (c) => {
  const rel = new URL(c.req.url).pathname.split('/file/')[1]!;
  if (!/^(sheets|files|images)\/[^/]+$/.test(decodeURIComponent(rel))) return c.json({ error: 'bad path' }, 400);
  const prefix = `docs/${c.env.DOCS.idFromName(c.req.param('id')).toString()}/data/`;
  await c.env.BLOBS.put(prefix + decodeURIComponent(rel), c.req.raw.body);
  return c.json({ ok: true });
});
