// The suite's Worker. Today it is the front door: built files from the edge, everything else from the AWS origin.
// docs/specs/cloudflare-migration.md is the plan; each context that is ported gets its routes here, ahead of the proxy.
import { Hono } from 'hono';
import { proxy, type ProxyEnv } from './proxy';

export interface Env extends ProxyEnv {
  ASSETS: Fetcher;
  ASSET_HOSTS: string;
}

/** Paths that are never files: they skip the look in the assets. */
const NEVER_A_FILE = /^\/(v1|api|mcp|oauth|plugin|\.well-known)(\/|$)/;
/** Vite's content-hashed output, under the web client's root and the Workspace client's. */
const HASHED_FILE = /^(\/workspace)?\/assets\//;

const app = new Hono<{ Bindings: Env }>();

app.get('/edge/health', (c) => c.json({ ok: true }));

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
