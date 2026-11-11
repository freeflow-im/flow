// The ChatGPT plugin's sign-in on its own hosts. The plugin (Universal Docs: docs.freeflow.im, mcpdocs.freeflow.im) still
// runs on the AWS origin (decision_log 2026-11-03), and a session cookie is per host, so a sign-in here is invisible there.
// Its sign-in page sends the person to /api/auth/cross-host on this host; signed in (the usual sign-in page first, if not),
// they get a one-time key and go back to the plugin's host with it, where the plugin's server trades it with
// /api/auth/cross-host/exchange, under the edge secret, for who they are, and signs them in on that host
// (packages/server/src/workspace.ts). The key only ever travels in the person's own browser to a host of ours, and only
// the plugin's server, with the secret, can redeem it.
import { Hono, type Context } from 'hono';
import { getCookie } from 'hono/cookie';
import { directory, type AuthEnv } from './auth';

export interface CrossHostEnv extends AuthEnv {
  /** The plugin's hosts, comma-separated; none turns the sign-in off. */
  PLUGIN_HOSTS?: string;
  /** The secret the plugin's server (through Caddy) and this Worker share. */
  EDGE_ORIGIN_SECRET?: string;
}
type C = Context<{ Bindings: CrossHostEnv }>;

const KEY = /^[A-Za-z0-9_-]{43}$/;
/** Where the plugin may be sent back to: one of its own OAuth pages. */
const NEXT = /^\/oauth\/[a-z-]+(\?[^#]*)?$/;

/** The plugin's hosts from the environment. */
export const pluginHosts = (env: { PLUGIN_HOSTS?: string }): string[] => (env.PLUGIN_HOSTS ?? '').split(',').map((h) => h.trim().toLowerCase()).filter(Boolean);

/** The address of the plugin's handoff page on `host`, or null when the host or the way back is not one of ours. */
export function handoffTarget(host: string | undefined, next: string | undefined, hosts: string[]): string | null {
  const h = (host ?? '').trim().toLowerCase();
  if (!h || !hosts.includes(h) || !next || !NEXT.test(next)) return null;
  return `https://${h}/oauth/handoff?next=${encodeURIComponent(next)}`;
}

/** Whether two secrets match, in time that does not depend on where they differ. */
export function secretMatches(given: string | undefined, expected: string | undefined): boolean {
  if (!given || !expected || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export const crossHostRoutes = new Hono<{ Bindings: CrossHostEnv }>();

crossHostRoutes.get('/api/auth/cross-host', async (c: C) => {
  const target = handoffTarget(c.req.query('host'), c.req.query('next'), pluginHosts(c.env));
  c.header('cache-control', 'no-store');
  if (!target) return c.text('Bad request', 400);
  const token = getCookie(c, 'sid');
  const user = token ? await directory(c, 'authenticate', token).then((r) => r.user, () => null) : null;
  if (!user) {
    const here = new URL(c.req.url);
    return c.redirect(`/?next=${encodeURIComponent(here.pathname + here.search)}`);
  }
  const key = await directory(c, 'createCrossHostHandoff', user.id);
  return c.redirect(`${target}&key=${key}`);
});

crossHostRoutes.post('/api/auth/cross-host/exchange', async (c: C) => {
  c.header('cache-control', 'no-store');
  if (!secretMatches(c.req.header('x-edge-secret'), c.env.EDGE_ORIGIN_SECRET)) return c.json({ error: 'unauthorized' }, 401);
  const body = (await c.req.json().catch(() => null)) as { key?: unknown } | null;
  const key = typeof body?.key === 'string' ? body.key : '';
  if (!KEY.test(key)) return c.json({ error: 'invalid_key' }, 400);
  const user = await directory(c, 'redeemCrossHostHandoff', key);
  return c.json({ user: { id: user.id, email: user.email, displayName: user.displayName, avatarUrl: user.avatarUrl } });
});
