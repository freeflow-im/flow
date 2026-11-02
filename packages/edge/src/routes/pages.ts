// The clients' pages, on the hosts the ported API answers on. Until the move the origin served them, because it decided per
// request; now the Worker does: Docs at /workspace sends a stranger to sign in, a public link's page is kept out of search
// engines and referrers, and every other address of the web client gets its page. scripts/assemble.mjs files them under /_pages.
import { Hono, type Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { directory, type AuthEnv } from './auth';

export interface PagesEnv extends AuthEnv { ASSETS: Fetcher }
type C = Context<{ Bindings: PagesEnv }>;

const BASE = '/workspace';
const NOT_A_PAGE = /^\/(v1|api|mcp|oauth|plugin|\.well-known|edge|download)(\/|$)/;

async function page(c: C, name: string, extra: Record<string, string> = {}): Promise<Response> {
  const file = await c.env.ASSETS.fetch(new URL(`/_pages/${name}`, c.req.url));
  if (!file.ok) return c.text('This page is not built into this deploy.', 404);
  return new Response(file.body, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', ...extra } });
}

async function signedIn(c: C): Promise<boolean> {
  const header = c.req.header('authorization');
  const token = (header?.startsWith('Bearer ') ? header.slice(7).trim() : getCookie(c, 'sid')) || null;
  if (!token) return false;
  return directory(c, 'authenticate', token).then(() => true, () => false);
}

export const pageRoutes = new Hono<{ Bindings: PagesEnv }>();

pageRoutes.get(BASE, async (c) => ((await signedIn(c)) ? page(c, 'workspace.html') : c.redirect(`/?next=${encodeURIComponent(BASE + new URL(c.req.url).search)}`)));
pageRoutes.get(`${BASE}/p/*`, (c) => page(c, 'workspace.html', { 'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex' }));
// A file under /workspace (its scripts and styles) is not a page: it falls through to the built files.
pageRoutes.get(`${BASE}/*`, (c) => (/\.[a-z0-9]+$/i.test(new URL(c.req.url).pathname) ? c.notFound() : page(c, 'workspace.html')));
// Public links from before Docs moved under /workspace.
pageRoutes.get('/p/*', (c) => c.redirect(`${BASE}${new URL(c.req.url).pathname}${new URL(c.req.url).search}`, 301));
pageRoutes.get('/privacy', (c) => c.env.ASSETS.fetch(new URL('/privacy.html', c.req.url)));
// The web client's page for every other address (a channel, a thread, a settings tab): it routes in the browser.
pageRoutes.get('*', (c) => {
  const { pathname } = new URL(c.req.url);
  if (NOT_A_PAGE.test(pathname) || /\.[a-z0-9]+$/i.test(pathname)) return c.notFound();
  return page(c, 'index.html');
});
