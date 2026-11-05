// Google Calendar through its CalDAV endpoint with an OAuth credential (docs/specs/calendar.md §2.2, ruled 2026-11-04):
// the authorization-code flow's pieces (the state, the consent URL, the code exchange, the refresh), with no route or
// object in them so they test alone. routes/calendar.ts runs the flow; the Calendar object holds the refresh token
// (sealed with FLOW_DATA_KEY, as a password is) and refreshes access tokens as the driver needs them.
import { decryptBlob, encryptBlob } from '../org/crypto/index';
import { authFailed, calendarError } from './rules';

/** Google's CalDAV v2 endpoint; a person's principal is `<base><email>/user`. */
export const GOOGLE_CALDAV = 'https://apidata.googleusercontent.com/caldav/v2/';
export const googlePrincipal = (email: string) => `${GOOGLE_CALDAV}${encodeURIComponent(email)}/user`;
export const GOOGLE_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN = 'https://oauth2.googleapis.com/token';
/** The calendar (read and write), and who the person is (the id_token's email). Google calls the first sensitive. */
export const GOOGLE_SCOPE = 'openid email https://www.googleapis.com/auth/calendar';
/** How long a consent may take, from start to callback. */
export const STATE_TTL_MS = 10 * 60_000;

export interface GoogleClient { clientId: string; clientSecret: string }
export interface OAuthState { userId: string; nonce: string; returnTo: string; exp: number }

const b64url = (b: Buffer) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

/** The state carried through Google's consent: sealed (AES-GCM, so it can be neither read nor changed), and short-lived. */
export function sealState(s: Omit<OAuthState, 'exp' | 'nonce'>, now = Date.now()): string {
  const state: OAuthState = { ...s, nonce: crypto.randomUUID(), exp: now + STATE_TTL_MS };
  const { blob, encKeyId } = encryptBlob(Buffer.from(JSON.stringify(state), 'utf8'));
  return `${b64url(Buffer.from(encKeyId, 'utf8'))}.${b64url(blob)}`;
}

/** The state back, or null for one that was changed, sealed with another key, or has expired. */
export function openState(token: string, now = Date.now()): OAuthState | null {
  const [kid, blob] = token.split('.');
  if (!kid || !blob) return null;
  try {
    const s = JSON.parse(decryptBlob(fromB64url(blob), fromB64url(kid).toString('utf8')).toString('utf8')) as OAuthState;
    if (typeof s.userId !== 'string' || typeof s.returnTo !== 'string' || typeof s.exp !== 'number' || s.exp < now) return null;
    return s;
  } catch {
    return null;
  }
}

/** Google's consent page: offline access with `prompt=consent`, so every connection returns a refresh token. */
export function consentUrl(clientId: string, redirectUri: string, state: string, loginHint?: string): string {
  const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: GOOGLE_SCOPE, access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state });
  if (loginHint) q.set('login_hint', loginHint);
  return `${GOOGLE_AUTH}?${q}`;
}

export interface Tokens { accessToken: string; expiresAt: number; refreshToken: string | null; idToken: string | null; scope: string }

async function tokenRequest(body: Record<string, string>, f: typeof fetch): Promise<Response> {
  try {
    return await f(GOOGLE_TOKEN, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString(), signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    throw calendarError(422, 'connect_failed', `Could not reach Google: ${(err as Error).message || 'no answer'}`);
  }
}
function tokensOf(j: Record<string, unknown>, now: number): Tokens {
  return {
    accessToken: String(j.access_token ?? ''), expiresAt: now + (Number(j.expires_in) || 3600) * 1000,
    refreshToken: typeof j.refresh_token === 'string' ? j.refresh_token : null, idToken: typeof j.id_token === 'string' ? j.id_token : null, scope: String(j.scope ?? ''),
  };
}

/** The authorization code for tokens. A refusal is `auth_failed` (the code expired or was used); never the tokens in a message. */
export async function exchangeCode(code: string, client: GoogleClient, redirectUri: string, f: typeof fetch = fetch, now = Date.now()): Promise<Tokens> {
  const res = await tokenRequest({ code, client_id: client.clientId, client_secret: client.clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' }, f);
  const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || !j.access_token) throw authFailed(`Google did not accept the sign-in (${String(j.error ?? res.status)})`);
  return tokensOf(j, now);
}

/** A new access token from the refresh token. Google saying `invalid_grant` (revoked, expired, password changed) is `auth_failed`. */
export async function refreshAccess(refreshToken: string, client: GoogleClient, f: typeof fetch = fetch, now = Date.now()): Promise<Tokens> {
  const res = await tokenRequest({ refresh_token: refreshToken, client_id: client.clientId, client_secret: client.clientSecret, grant_type: 'refresh_token' }, f);
  const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.status === 400 || res.status === 401) throw authFailed('Google no longer gives FreeFlow access to this calendar; reconnect it');
  if (!res.ok || !j.access_token) throw calendarError(422, 'connect_failed', `Google did not answer the refresh (${res.status})`);
  return tokensOf(j, now);
}

/**
 * Where the callback may send the browser back to: the suite's own web origin, the Worker's, or (local dev, with
 * CALENDAR_ALLOW_INSECURE=1) a localhost dev server. Anything else falls back to `<WEB_URL_BASE>/calendar`.
 */
export function returnUrl(asked: string | undefined, webBase: string, workerOrigin: string, allowInsecure: boolean): string {
  const fallback = `${webBase.replace(/\/$/, '')}/calendar/`;
  if (!asked) return fallback;
  let u: URL;
  try {
    u = new URL(asked);
  } catch {
    return fallback;
  }
  const allowed = new Set([new URL(webBase).origin, workerOrigin]);
  const local = allowInsecure && u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
  return allowed.has(u.origin) || local ? `${u.origin}${u.pathname}` : fallback;
}
