// The MCP Docs desktop app's Google sign-in. Google refuses to sign in inside an app's own browser, so the app opens
// /api/auth/google/start?desktop=<key> in the system browser (packages/docs/desktop/main.js, googleSignIn). There the
// person signs in as on any visit, then confirms that the app on this computer may sign in as them, which approves the
// key in the directory. The app asks every two seconds whether its key is approved (/api/auth/handoff/status), then
// trades it once for a session of its own (/api/auth/handoff), set as its cookie.
//
// The confirmation is a form the person submits: without it, a link carrying someone else's key, opened by a person
// already signed in, would hand that someone a session. The form's POST carries the session cookie only from this site.
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { directory, type AuthEnv } from './auth';

const KEY = /^[A-Za-z0-9_-]{43}$/;
const KEY_COOKIE = 'desktop_handoff';
const CLAIM = '/api/auth/handoff/claim';
const SESSION_TTL = 30 * 86400;
type C = Context<{ Bindings: AuthEnv }>;

export const handoffRoutes = new Hono<{ Bindings: AuthEnv }>();

const secure = (c: C) => c.env.WEB_URL_BASE.startsWith('https://');
const signIn = (c: C) => c.redirect(`/?next=${encodeURIComponent(CLAIM)}`);
const escape = (s: string) => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);

function page(c: C, body: string, status: 200 | 400 = 200) {
  c.header('cache-control', 'no-store');
  return c.html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>MCP Docs sign-in</title>
<style>body{margin:0;font:15px/1.5 Inter,system-ui,sans-serif;color:#1f1f1f;background:#f8f9fa;display:flex;min-height:100vh;align-items:center;justify-content:center}
main{background:#fff;border:1px solid #e3e6ea;border-radius:12px;padding:28px 32px;max-width:420px;margin:16px}h1{font-size:19px;margin:0 0 8px}p{margin:0 0 16px;color:#3c4043}
button{font:inherit;font-weight:600;border:0;border-radius:8px;background:#1a73e8;color:#fff;padding:10px 18px;cursor:pointer}button:hover{background:#1558b0}.small{font-size:13px;color:#5f6368}
@media (prefers-color-scheme:dark){body{background:#1f1f1f;color:#e8eaed}main{background:#2a2b2e;border-color:#3c4043}p{color:#c4c7c5}.small{color:#9aa0a6}}</style></head><body><main>${body}</main></body></html>`, status);
}

/** Whoever this browser is signed in as, or null. */
async function viewer(c: C) {
  const token = getCookie(c, 'sid');
  if (!token) return null;
  try {
    return (await directory(c, 'authenticate', token)).user;
  } catch {
    return null;
  }
}

handoffRoutes.get('/api/auth/google/start', (c) => {
  const key = c.req.query('desktop');
  if (!key || !KEY.test(key)) return c.redirect('/');
  setCookie(c, KEY_COOKIE, key, { path: CLAIM, httpOnly: true, sameSite: 'Lax', secure: secure(c), maxAge: 600 });
  return signIn(c);
});

handoffRoutes.get(CLAIM, async (c) => {
  const key = getCookie(c, KEY_COOKIE);
  if (!key || !KEY.test(key)) return page(c, '<h1>This sign-in has expired</h1><p>Start again from MCP Docs.</p>', 400);
  const user = await viewer(c);
  if (!user) return signIn(c);
  return page(c, `<h1>Sign in to MCP Docs?</h1><p>The MCP Docs app on this computer will be signed in as <b>${escape(user.email ?? user.displayName ?? '')}</b>.</p>
<form method="post" action="${CLAIM}"><button type="submit">Sign in to MCP Docs</button></form>
<p class="small" style="margin-top:16px">Continue only if you just chose to sign in from the MCP Docs app.</p>`);
});

handoffRoutes.post(CLAIM, async (c) => {
  const key = getCookie(c, KEY_COOKIE);
  if (!key || !KEY.test(key)) return page(c, '<h1>This sign-in has expired</h1><p>Start again from MCP Docs.</p>', 400);
  const user = await viewer(c);
  if (!user) return signIn(c);
  await directory(c, 'approveDesktopHandoff', key, user.id);
  deleteCookie(c, KEY_COOKIE, { path: CLAIM, secure: secure(c) });
  return page(c, '<h1>You’re signed in</h1><p>Go back to MCP Docs: it opens your files in a moment. You can close this tab.</p>');
});

handoffRoutes.get('/api/auth/handoff/status', async (c) => {
  const key = c.req.query('key');
  c.header('cache-control', 'no-store');
  return c.json({ ready: !!key && KEY.test(key) && (await directory(c, 'desktopHandoffReady', key)) });
});

handoffRoutes.get('/api/auth/handoff', async (c) => {
  const key = c.req.query('key');
  if (key && KEY.test(key)) {
    try {
      const token = await directory(c, 'exchangeDesktopHandoff', key, 'MCP Docs desktop');
      setCookie(c, 'sid', token, { path: '/', httpOnly: true, sameSite: 'Lax', secure: secure(c), maxAge: SESSION_TTL });
    } catch {
      // Expired or used: /workspace sends the app to sign in again.
    }
  }
  return c.redirect('/workspace');
});

// Docs' Sign out (the Workspace app's /api/auth/logout, ahead of Docs' own routes): the session ends in the directory,
// so Chat, which holds the same session, is signed out too, and the cookie goes. Docs' object cannot do it: it has no
// sessions (docs/object.ts signOut).
handoffRoutes.post('/api/auth/logout', async (c) => {
  const header = c.req.header('authorization');
  const token = (header?.startsWith('Bearer ') ? header.slice(7).trim() : getCookie(c, 'sid')) || null;
  if (token) await directory(c, 'logout', token).catch(() => {});
  deleteCookie(c, 'sid', { path: '/', secure: secure(c) });
  c.header('cache-control', 'no-store');
  return c.json({ ok: true });
});

