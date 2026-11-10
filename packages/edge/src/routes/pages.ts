// The clients' pages, on the hosts the ported API answers on. Until the move the origin served them, because it decided per
// request; now the Worker does, from each app's manifest (@flow/shared's APP_MANIFESTS, `pages`): Docs at /docs, Mail
// at /mail and Calendar at /calendar send a stranger to sign in, a public link's page is kept out of search engines and
// referrers, and every other address of the web client gets its page. scripts/assemble.mjs files them under /_pages.
import { Hono, type Context } from 'hono';
import { getCookie } from 'hono/cookie';
import type { AppPage } from '@flow/shared';
import { APP_MANIFESTS } from '@flow/shared/manifests';
import { directory, type AuthEnv } from './auth';

export interface PagesEnv extends AuthEnv { ASSETS: Fetcher }
type C = Context<{ Bindings: PagesEnv }>;

const NOT_A_PAGE = /^\/(v1|api|mcp|oauth|plugin|\.well-known|edge|download)(\/|$)/;
const A_FILE = /\.[a-z0-9]+$/i;

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

const toSignIn = (c: C) => c.redirect(`/?next=${encodeURIComponent(new URL(c.req.url).pathname + new URL(c.req.url).search)}`);

/** One manifest page: a file under it falls through to the built files (`passFiles`), a stranger goes to sign in (`signIn`). */
const servePage = (p: AppPage) => async (c: C) => {
  const { pathname } = new URL(c.req.url);
  if (p.passFiles && (NOT_A_PAGE.test(pathname) || A_FILE.test(pathname))) return c.notFound();
  if (p.signIn && !(await signedIn(c))) return toSignIn(c);
  return page(c, p.html, p.headers);
};

export const pageRoutes = new Hono<{ Bindings: PagesEnv }>();

// In the manifests' order, except the web client's catch-all, which goes last: the first route that answers wins.
const pages = APP_MANIFESTS.flatMap((m) => m.pages ?? []);
for (const p of pages.filter((p) => p.path !== '*')) pageRoutes.get(p.path, servePage(p));
// Docs' old addresses, so links and bookmarks learn: its public links from before it had a base path, and its pages under
// /workspace, its base until 2026-11-10 (decision_log.md).
const moved = (to: (pathname: string) => string) => (c: C) => {
  const url = new URL(c.req.url);
  return c.redirect(`${to(url.pathname)}${url.search}`, 301);
};
pageRoutes.get('/p/*', moved((p) => `/docs${p}`));
pageRoutes.get('/workspace', moved(() => '/docs'));
pageRoutes.get('/workspace/*', moved((p) => `/docs${p.slice('/workspace'.length)}`));
pageRoutes.get('/privacy', (c) => c.env.ASSETS.fetch(new URL('/privacy.html', c.req.url)));
for (const p of pages.filter((p) => p.path === '*')) pageRoutes.get(p.path, servePage(p));
