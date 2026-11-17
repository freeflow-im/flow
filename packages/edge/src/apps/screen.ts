// A hosted app's screen (docs/specs/user-apps.md §6, §14 phase 2 step 3), served by the suite Worker on the app's own host
// on the apps domain: `<app>--<org>.flowtoo.org`. Never on the suite's origin, so the app's code never sees the suite's
// session (§6.1).
//
//   ?flow_token=<door key>  the key the tab minted (§6.2), checked and used once; a session cookie on this host, then a
//                           redirect to the same address without the key
//   a session cookie        checked on every request (membership and scopes, §6.2); then
//     GET of a ui/ file     the file, from R2 (`/` is ui/index.html)
//     anything else         the app's own isolate, with the viewer in `x-freeflow-viewer`
//   neither                 401, one line: the screen is opened from its tab
import type { HostedCode, HostedEnv, HostedExports } from './hosted';
import { HOST_PATH, hostedWorker, parseAppHost } from './hosted';

export const APP_SESSION_COOKIE = 'ff_app_session';
const TOKEN_PARAM = 'flow_token';

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8',
  json: 'application/json', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  ico: 'image/x-icon', woff2: 'font/woff2', woff: 'font/woff', txt: 'text/plain; charset=utf-8', map: 'application/json', wasm: 'application/wasm',
};
const typeOf = (path: string) => TYPES[path.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';

const refuse = () =>
  new Response('<!doctype html><meta charset="utf-8"><p>Open this app from its tab in FreeFlow.</p>', { status: 401, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });

function cookieOf(req: Request, name: string): string | null {
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

/**
 * The host a request is for. In production that is the URL's. A local `wrangler dev --local-upstream` rewrites the URL to
 * its own host, so in local development (APPS_SCHEME http) the forwarded host is read instead; never in production.
 */
function hostOf(env: HostedEnv, req: Request): string {
  const url = new URL(req.url);
  if (env.APPS_SCHEME === 'http') return req.headers.get('x-forwarded-host') ?? url.host;
  return url.host;
}

/** Whether a request is for an app's screen: its host is on the apps domain. */
export const isAppHost = (env: HostedEnv, req: Request): boolean => !!env.APPS_DOMAIN && !!parseAppHost(hostOf(env, req), env.APPS_DOMAIN);

/** Serves one request to a hosted app's host. `exports` are the Worker's own (`ctx.exports`), to bind the app's isolate. */
export async function serveAppScreen(req: Request, env: HostedEnv, exports: HostedExports): Promise<Response> {
  const url = new URL(req.url);
  url.host = hostOf(env, req);
  const at = parseAppHost(url.host, env.APPS_DOMAIN ?? '');
  if (!at || !env.ORG) return new Response('not found', { status: 404 });
  const org = env.ORG.get(env.ORG.idFromName(at.org));
  const secure = (env.APPS_SCHEME ?? 'https') === 'https';

  const token = url.searchParams.get(TOKEN_PARAM);
  if (token) {
    const opened = await org.openHostedAppSession({ organizationId: at.org, name: at.app, token });
    if (!opened) return refuse();
    url.searchParams.delete(TOKEN_PARAM);
    // Framed by the suite on another site: SameSite=None needs Secure, and Partitioned keeps it the suite's frame's alone.
    const attrs = secure ? 'Secure; SameSite=None; Partitioned' : 'SameSite=Lax';
    return new Response(null, { status: 302, headers: { location: url.pathname + url.search, 'set-cookie': `${APP_SESSION_COOKIE}=${opened.cookie}; Path=/; HttpOnly; ${attrs}; Max-Age=${opened.maxAge}`, 'cache-control': 'no-store' } });
  }

  const cookie = cookieOf(req, APP_SESSION_COOKIE);
  const viewer = cookie ? await org.checkHostedAppSession({ name: at.app, cookie }) : null;
  if (!viewer) return refuse();
  if (url.pathname.startsWith(HOST_PATH)) return new Response('not found', { status: 404 });

  const code = (await org.userAppCode(at.app)) as HostedCode | null;
  if (!code) return new Response('This app has no installed version.', { status: 404 });

  if (req.method === 'GET' || req.method === 'HEAD') {
    const file = `ui${url.pathname === '/' ? '/index.html' : url.pathname}`;
    if (file in code.files && env.BLOBS) {
      const o = await env.BLOBS.get(code.prefix + file);
      if (o) return new Response(req.method === 'HEAD' ? null : o.body, { headers: { 'content-type': typeOf(file), 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' } });
    }
  }

  // The app's own paths: its isolate answers, told who is looking (the headers a viewer sends under that name are dropped).
  const headers = new Headers(req.headers);
  for (const k of [...headers.keys()]) if (k.startsWith('x-freeflow-')) headers.delete(k);
  headers.delete('cookie');
  headers.set('x-freeflow-viewer', JSON.stringify({ organizationId: at.org, accountId: viewer.accountId, userId: viewer.userId, displayName: viewer.displayName, isAgent: viewer.isAgent, scopes: viewer.scopes }));
  const worker = await hostedWorker(env, exports, at.org, code);
  try {
    return await worker.getEntrypoint().fetch(new Request(url.toString(), { method: req.method, headers, body: req.body, redirect: 'manual' }));
  } catch (err) {
    return new Response(`The app failed: ${(err as Error).message}`.slice(0, 300), { status: 502 });
  }
}
