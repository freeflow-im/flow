// The suite's Worker. Today it is the front door: built files from the edge, everything else from the AWS origin.
// docs/specs/cloudflare-migration.md is the plan; each context that is ported gets its routes here, ahead of the proxy.
import { Hono, type Context } from 'hono';
import { ApiError } from './errors';
import { proxy, type ProxyEnv } from './proxy';
import { authRoutes, type AuthEnv } from './routes/auth';
import { orgRoutes } from './routes/org';

export { Directory } from './directory/object';
export { Org } from './org/object';
import type { Org as OrgObject } from './org/object';

export interface Env extends ProxyEnv, AuthEnv {
  ASSETS: Fetcher;
  ASSET_HOSTS: string;
  /** The hosts the ported API answers on: the rehearsal host until the cut-over, then the app's too. */
  PORTED_HOSTS: string;
  ORG: DurableObjectNamespace<OrgObject>;
}

/** Paths that are never files: they skip the look in the assets. */
const NEVER_A_FILE = /^\/(v1|api|mcp|oauth|plugin|\.well-known)(\/|$)/;
/** Vite's content-hashed output, under the web client's root and the Workspace client's. */
const HASHED_FILE = /^(\/workspace)?\/assets\//;

const app = new Hono<{ Bindings: Env }>();

const onError = (err: Error, c: Context) => {
  if (err instanceof ApiError) return c.json({ error: { code: err.code, message: err.message } }, err.statusCode as 400);
  console.error(err);
  return c.json({ error: { code: 'internal', message: 'internal server error' } }, 500);
};
app.onError(onError);

app.get('/edge/health', (c) => c.json({ ok: true }));

// Ported routes, only on the hosts that have been switched. A path not ported yet falls through to the proxy.
const ported = new Hono<{ Bindings: Env }>();
ported.onError(onError);
ported.route('/', authRoutes as never);
ported.route('/', orgRoutes as never);
app.use('*', async (c, next) => {
  if (!c.env.PORTED_HOSTS.split(',').includes(new URL(c.req.url).hostname)) return next();
  const res = await ported.fetch(c.req.raw, c.env, c.executionCtx);
  return res.status === 404 && !res.headers.get('content-type')?.includes('json') ? next() : res;
});

app.all('*', async (c) => {
  const req = c.req.raw;
  const url = new URL(req.url);
  const isRead = req.method === 'GET' || req.method === 'HEAD';
  if (isRead && !NEVER_A_FILE.test(url.pathname) && c.env.ASSET_HOSTS.split(',').includes(url.hostname)) {
    const file = await c.env.ASSETS.fetch(req);
    if (file.status !== 404) {
      if (!HASHED_FILE.test(url.pathname)) return file;
      const hashed = new Response(file.body, file);
      hashed.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
      return hashed;
    }
  }
  return proxy(req, c.env);
});

export default app;

