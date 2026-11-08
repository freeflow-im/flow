import { randomBytes } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { ApiError } from '../errors';
import { googleCallback, type CallbackDeps } from '../routes/calendar';
import { GOOGLE_SCOPE, STATE_TTL_MS, consentUrl, exchangeCode, googlePrincipal, openState, refreshAccess, returnUrl, sealState } from './google';

beforeAll(() => { process.env.FLOW_DATA_KEY ??= randomBytes(32).toString('base64'); });

const client = { clientId: 'cid.apps.googleusercontent.com', clientSecret: 'shh' };
const env = { WEB_URL_BASE: 'https://app.freeflow.im', GOOGLE_CLIENT_ID: client.clientId, GOOGLE_CLIENT_SECRET: client.clientSecret } as never;
const codeOf = (p: Promise<unknown>) => p.then(() => 'none', (e) => (e instanceof ApiError ? e.code : String(e)));
/** A fake token endpoint: answers by grant type, records what it was sent. */
function tokenEndpoint(answer: (body: URLSearchParams) => { status: number; json: unknown }) {
  const sent: URLSearchParams[] = [];
  const f = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = new URLSearchParams(String(init?.body ?? ''));
    sent.push(body);
    const a = answer(body);
    return new Response(JSON.stringify(a.json), { status: a.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { f, sent };
}

describe('the OAuth state', () => {
  it('comes back as it was sealed, and not after 10 minutes, changed, or as nonsense', () => {
    const now = Date.now();
    // The user id is long enough that the sealed base64 cannot hold it by chance (two characters once did, in CI).
    const userId = 'user-0123456789abcdef';
    const s = sealState({ accountId: 'a1', userId, returnTo: 'https://app.freeflow.im/calendar/' }, now);
    expect(s).not.toContain(userId);
    expect(s).not.toContain('freeflow');
    expect(openState(s, now + 1000)).toMatchObject({ accountId: 'a1', userId, returnTo: 'https://app.freeflow.im/calendar/' });
    expect(openState(s, now + STATE_TTL_MS + 1)).toBeNull();
    const [kid, blob] = s.split('.');
    const flipped = `${kid}.${blob!.slice(0, 20)}${blob![20] === 'A' ? 'B' : 'A'}${blob!.slice(21)}`;
    expect(openState(flipped, now)).toBeNull();
    expect(openState('nope', now)).toBeNull();
    expect(openState(`${kid}.`, now)).toBeNull();
    expect(sealState({ accountId: 'a1', userId: 'u1', returnTo: 'x' }, now)).not.toBe(s);
  });

  it('asks Google for offline access with consent, the calendar scope and the address', () => {
    const u = new URL(consentUrl(client.clientId, 'https://app.freeflow.im/v1/calendar/google/callback', 'st', 'ann@gmail.com'));
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(Object.fromEntries(u.searchParams)).toMatchObject({ client_id: client.clientId, response_type: 'code', access_type: 'offline', prompt: 'consent', scope: GOOGLE_SCOPE, state: 'st', login_hint: 'ann@gmail.com' });
    expect(GOOGLE_SCOPE.split(' ')).toEqual(['openid', 'email', 'https://www.googleapis.com/auth/calendar']);
    expect(googlePrincipal('ann@gmail.com')).toBe('https://apidata.googleusercontent.com/caldav/v2/ann%40gmail.com/user');
  });

  it('sends the browser back only to the suite, the Worker, or a localhost dev server in insecure mode', () => {
    const web = 'https://app.freeflow.im';
    expect(returnUrl('https://app.freeflow.im/calendar/?x=1', web, 'https://app.freeflow.im', false)).toBe('https://app.freeflow.im/calendar/');
    expect(returnUrl('https://evil.example/calendar/', web, 'https://app.freeflow.im', false)).toBe('https://app.freeflow.im/calendar/');
    expect(returnUrl('http://localhost:5186/calendar/', web, 'http://localhost:18799', false)).toBe('https://app.freeflow.im/calendar/');
    expect(returnUrl('http://localhost:5186/calendar/', web, 'http://localhost:18799', true)).toBe('http://localhost:5186/calendar/');
    expect(returnUrl(undefined, web, 'x', true)).toBe('https://app.freeflow.im/calendar/');
  });
});

describe('the token endpoint', () => {
  it('exchanges a code and refreshes an access token; a revoked grant is auth_failed', async () => {
    const { f, sent } = tokenEndpoint((b) => (b.get('refresh_token') === 'revoked' ? { status: 400, json: { error: 'invalid_grant' } } : { status: 200, json: { access_token: 'at', expires_in: 3599, refresh_token: b.get('code') ? 'rt' : undefined, id_token: 'idt', scope: GOOGLE_SCOPE } }));
    const t = await exchangeCode('c0de', client, 'https://cb', f, 1000);
    expect(t).toEqual({ accessToken: 'at', expiresAt: 1000 + 3_599_000, refreshToken: 'rt', idToken: 'idt', scope: GOOGLE_SCOPE });
    expect(Object.fromEntries(sent[0]!)).toEqual({ code: 'c0de', client_id: client.clientId, client_secret: 'shh', redirect_uri: 'https://cb', grant_type: 'authorization_code' });
    expect((await refreshAccess('rt', client, f)).accessToken).toBe('at');
    expect(sent[1]!.get('grant_type')).toBe('refresh_token');
    expect(await codeOf(refreshAccess('revoked', client, f))).toBe('auth_failed');
    const bad = tokenEndpoint(() => ({ status: 400, json: { error: 'invalid_grant' } }));
    expect(await codeOf(exchangeCode('used', client, 'https://cb', bad.f))).toBe('auth_failed');
  });
});

describe('the callback', () => {
  const ok: CallbackDeps = {
    exchange: async () => ({ accessToken: 'at', expiresAt: 1, refreshToken: 'rt', idToken: 'idt', scope: GOOGLE_SCOPE }),
    profile: async () => ({ email: 'ann@gmail.com', name: 'Ann' }),
    connect: async () => ({ id: 'acct-1' }),
  };
  const url = 'https://app.freeflow.im/v1/calendar/google/callback';
  const state = () => sealState({ accountId: 'a1', userId: 'u1', returnTo: 'https://app.freeflow.im/calendar/' });

  it('makes the account in the account\'s object and goes back with ?connected', async () => {
    let got: unknown;
    const to = await googleCallback({ code: 'c', state: state() }, env, url, { ...ok, connect: async (owner, grant) => { got = { owner, grant }; return { id: 'acct-1' }; } });
    expect(to).toBe('https://app.freeflow.im/calendar/?connected=acct-1');
    expect(got).toEqual({ owner: { accountId: 'a1', userId: 'u1' }, grant: { email: 'ann@gmail.com', displayName: 'Ann', refreshToken: 'rt', accessToken: 'at', expiresAt: 1 } });
  });

  it('goes back with ?error for a refusal, an expired state, a missing scope, and a failure', async () => {
    expect(await googleCallback({ error: 'access_denied', state: state() }, env, url, ok)).toBe('https://app.freeflow.im/calendar/?error=access_denied');
    expect(await googleCallback({ code: 'c', state: 'tampered.state' }, env, url, ok)).toBe('https://app.freeflow.im/calendar/?error=expired');
    expect(await googleCallback({ code: 'c', state: state() }, env, url, { ...ok, exchange: async () => ({ accessToken: 'at', expiresAt: 1, refreshToken: 'rt', idToken: 'idt', scope: 'openid email' }) })).toContain('error=scope_denied');
    expect(await googleCallback({ code: 'c', state: state() }, env, url, { ...ok, exchange: async () => ({ accessToken: 'at', expiresAt: 1, refreshToken: null, idToken: 'idt', scope: GOOGLE_SCOPE }) })).toContain('error=no_refresh_token');
    expect(await googleCallback({ code: 'c', state: state() }, env, url, { ...ok, connect: async () => { throw new ApiError(422, 'connect_failed', 'x'); } })).toContain('error=connect_failed');
    expect(await googleCallback({ code: 'c', state: state() }, { WEB_URL_BASE: 'https://app.freeflow.im' } as never, url, ok)).toContain('error=google_disabled');
  });
});
