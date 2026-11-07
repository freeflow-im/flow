// FreeFlow Calendar's API, /v1/calendar/* (docs/specs/calendar.md §3, §4): the caller is authenticated here, then the
// request goes to the Calendar object of their account in the organization named (src/calendar/object.ts, platform.md
// §3.6). Answered here: the provider presets, and Google's OAuth start and callback (the callback has no session: the
// sealed state names the account). Each
// request logs one timing line here, not in the object (as Mail's: a line logged in an object reaches `wrangler tail` late).
import { Hono, type Context } from 'hono';
import type { Calendar, GoogleGrant } from '../calendar/object';
import { consentUrl, exchangeCode, openState, returnUrl, sealState, type GoogleClient, type Tokens } from '../calendar/google';
import { TIMING_HEADER, providerFor, timingLine } from '../calendar/rules';
import { googleProfile } from '../oauth';
import { ApiError, unauthorized } from '../errors';
import { resolveAccountCaller, resolveCaller, type AuthEnv } from './auth';

export interface CalendarRouteEnv extends AuthEnv {
  CALENDAR: DurableObjectNamespace<Calendar>;
  CALENDAR_ALLOW_INSECURE?: string;
  /** Google's OAuth client secret (GOOGLE_CLIENT_ID is the sign-in's): Google Calendar. A secret. */
  GOOGLE_CLIENT_SECRET?: string;
  /** Overrides the callback's address (`<Worker origin>/v1/calendar/google/callback`): local dev, where the Worker is localhost:18799. */
  GOOGLE_REDIRECT_URL?: string;
}

export const calendarRoutes = new Hono<{ Bindings: CalendarRouteEnv }>();

async function userId(c: Context<{ Bindings: CalendarRouteEnv }>): Promise<string> {
  const who = await resolveCaller(c);
  if (!who.user) throw unauthorized('missing bearer token');
  return who.user.id;
}

calendarRoutes.get('/v1/calendar/providers', async (c) => {
  await userId(c);
  c.header('Cache-Control', 'no-store');
  return c.json(providerFor(c.req.query('email') ?? ''));
});

const googleClient = (env: CalendarRouteEnv): GoogleClient | null => (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET ? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } : null);
const redirectUri = (env: CalendarRouteEnv, url: string) => env.GOOGLE_REDIRECT_URL || `${new URL(url).origin}/v1/calendar/google/callback`;
const withParam = (to: string, key: string, value: string) => { const u = new URL(to); u.searchParams.set(key, value); return u.href; };

/** `GET /v1/calendar/google/start?return=<url>&email=` → `{ url }`: Google's consent page, with the sealed state. */
calendarRoutes.get('/v1/calendar/google/start', async (c) => {
  const started = Date.now();
  const who = await resolveAccountCaller(c, 'Calendar');
  const client = googleClient(c.env);
  if (!client) throw new ApiError(503, 'google_disabled', 'Google Calendar is not configured on this server');
  const returnTo = returnUrl(c.req.query('return'), c.env.WEB_URL_BASE, new URL(c.req.url).origin, c.env.CALENDAR_ALLOW_INSECURE === '1');
  c.header('Cache-Control', 'no-store');
  console.log(timingLine('GET', c.req.url, 200, Date.now() - started, null));
  return c.json({ url: consentUrl(client.clientId, redirectUri(c.env, c.req.url), sealState({ accountId: who.account.id, userId: who.user.id, returnTo }), c.req.query('email') || undefined) });
});

export interface CallbackDeps {
  exchange(code: string, client: GoogleClient, redirectUri: string): Promise<Tokens>;
  profile(idToken: string, audience: string): Promise<{ email: string; name?: string }>;
  connect(owner: { accountId: string; userId: string }, grant: GoogleGrant): Promise<{ id: string }>;
}

/**
 * The callback's work, apart from Hono so it tests alone: where to send the browser. A state that was changed or has
 * expired goes to Calendar with `?error=expired`; Google's refusal (`access_denied`) passes through; a consent without the
 * calendar scope (Google lets a person untick it) is `scope_denied`; otherwise the account is made in the Calendar object of the account the state names
 * and the browser goes back with `?connected=<id>`.
 */
export async function googleCallback(query: { code?: string; state?: string; error?: string }, env: CalendarRouteEnv, url: string, deps: CallbackDeps): Promise<string> {
  const fallback = `${env.WEB_URL_BASE.replace(/\/$/, '')}/calendar/`;
  const state = query.state ? openState(query.state) : null;
  if (!state) return withParam(fallback, 'error', 'expired');
  if (query.error) return withParam(state.returnTo, 'error', /^[a-z_]{1,40}$/.test(query.error) ? query.error : 'access_denied');
  const client = googleClient(env);
  if (!client || !query.code) return withParam(state.returnTo, 'error', client ? 'access_denied' : 'google_disabled');
  try {
    const tokens = await deps.exchange(query.code, client, redirectUri(env, url));
    if (!tokens.scope.split(' ').includes('https://www.googleapis.com/auth/calendar')) return withParam(state.returnTo, 'error', 'scope_denied');
    if (!tokens.refreshToken || !tokens.idToken) return withParam(state.returnTo, 'error', 'no_refresh_token');
    const who = await deps.profile(tokens.idToken, client.clientId);
    const { id } = await deps.connect({ accountId: state.accountId, userId: state.userId }, { email: who.email, displayName: who.name ?? '', refreshToken: tokens.refreshToken, accessToken: tokens.accessToken, expiresAt: tokens.expiresAt });
    return withParam(state.returnTo, 'connected', id);
  } catch (err) {
    return withParam(state.returnTo, 'error', err instanceof ApiError && /^[a-z_]{1,40}$/.test(err.code) ? err.code : 'server_error');
  }
}

calendarRoutes.get('/v1/calendar/google/callback', async (c) => {
  const started = Date.now();
  const to = await googleCallback({ code: c.req.query('code'), state: c.req.query('state'), error: c.req.query('error') }, c.env, c.req.url, {
    exchange: (code, client, uri) => exchangeCode(code, client, uri),
    profile: (idToken, audience) => googleProfile(idToken, audience),
    connect: (owner, grant) => c.env.CALENDAR.get(c.env.CALENDAR.idFromName(owner.accountId)).connectGoogle(grant, owner),
  });
  console.log(timingLine('GET', c.req.url, 302, Date.now() - started, null));
  return c.redirect(to, 302);
});

calendarRoutes.all('/v1/calendar/*', async (c) => {
  const start = Date.now();
  let status = 500, timing: string | null = null;
  try {
    const who = await resolveAccountCaller(c, 'Calendar');
    const res = await c.env.CALENDAR.get(c.env.CALENDAR.idFromName(who.account.id)).handle(c.req.raw, who);
    status = res.status;
    timing = res.headers.get(TIMING_HEADER);
    const out = new Response(res.body, res);
    if (c.env.CALENDAR_ALLOW_INSECURE !== '1') out.headers.delete(TIMING_HEADER);
    return out;
  } catch (err) {
    if (err instanceof ApiError) status = err.statusCode;
    throw err;
  } finally {
    console.log(timingLine(c.req.method, c.req.url, status, Date.now() - start, timing));
  }
});
