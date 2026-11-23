// Signed requests between the suite and an external user app (docs/specs/user-apps.md §5, §5.1), with the install's
// secret. Both directions use one header, Stripe's shape, which any language checks in a few lines:
//
//   x-freeflow-signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
//
// The registry signs each tool call it sends to the app's server; the app signs each event it sends to the suite. A
// signature older or newer than five minutes is refused, so a captured request cannot be replayed later.
//
// The screen's door key is the app artifact's token (MINI_APPS.md) at version 2: it names the app instead of an
// artifact and a channel, and carries the viewer's account. The bridge's guard checks both versions.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { APP_TOKEN_TTL_SECONDS, signAppToken, type AppTokenPayload } from './appToken';

export const SIGNATURE_HEADER = 'x-freeflow-signature';
/** How far a signature's time may be from now. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

const mac = (secret: Buffer, t: number, body: string): string => createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');

/** The header for a body sent now. */
export function signBody(secret: Buffer, body: string, now: Date = new Date()): string {
  const t = Math.floor(now.getTime() / 1000);
  return `t=${t},v1=${mac(secret, t, body)}`;
}

/** Whether `header` signs `body` with `secret`, within the tolerance. */
export function verifyBody(secret: Buffer, header: string | null | undefined, body: string, now: Date = new Date()): boolean {
  if (!header) return false;
  const parts = new Map(header.split(',').map((p) => { const i = p.indexOf('='); return [p.slice(0, i).trim(), p.slice(i + 1).trim()] as const; }));
  const t = Number(parts.get('t'));
  const given = parts.get('v1');
  if (!Number.isInteger(t) || !given || !/^[0-9a-f]{64}$/.test(given)) return false;
  if (Math.abs(now.getTime() / 1000 - t) > SIGNATURE_TOLERANCE_SECONDS) return false;
  const a = Buffer.from(given, 'hex');
  const b = Buffer.from(mac(secret, t, body), 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The screen's door key for a user app (§6.2): version 2 of the app artifact token. */
export interface UserAppTokenPayload {
  v: 2;
  app: string;
  workspaceId: string;
  userId: string;
  accountId: string;
  displayName: string;
  isAgent: boolean;
  iat: number;
  exp: number;
  jti: string;
}

export function mintUserAppToken(
  secret: Buffer,
  identity: Omit<UserAppTokenPayload, 'v' | 'iat' | 'exp' | 'jti'>,
  now: Date = new Date(),
): { token: string; expiresAt: Date } {
  const iat = Math.floor(now.getTime() / 1000);
  const payload: UserAppTokenPayload = { v: 2, ...identity, iat, exp: iat + APP_TOKEN_TTL_SECONDS, jti: randomBytes(16).toString('base64url') };
  // signAppToken signs any payload's bytes; its type names version 1 only.
  return { token: signAppToken(secret, payload as unknown as AppTokenPayload), expiresAt: new Date(payload.exp * 1000) };
}

/** Checks a screen's v2 door key against the install's secret: its payload, or null (malformed, another secret, expired). */
export function verifyUserAppToken(secret: Buffer, token: string, now: Date = new Date()): UserAppTokenPayload | null {
  const dot = token.indexOf('.');
  if (dot <= 0 || token.indexOf('.', dot + 1) !== -1) return null;
  const json = Buffer.from(token.slice(0, dot), 'base64url');
  const given = Buffer.from(token.slice(dot + 1), 'base64url');
  const expected = createHmac('sha256', secret).update(json).digest();
  if (!json.length || given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let p: UserAppTokenPayload;
  try { p = JSON.parse(json.toString('utf8')) as UserAppTokenPayload; } catch { return null; }
  if (p.v !== 2 || typeof p.app !== 'string' || typeof p.accountId !== 'string' || typeof p.jti !== 'string' || !p.jti) return null;
  return typeof p.exp === 'number' && p.exp * 1000 > now.getTime() ? p : null;
}

/** A hosted app screen's session (§6.2): who is looking, until when. Kept in a cookie on the app's host, signed. */
export interface AppSession { accountId: string; userId: string; displayName: string; isAgent: boolean; exp: number }

/** How long a screen session lasts; the membership and scopes are checked again on every request anyway. */
export const APP_SESSION_SECONDS = 8 * 60 * 60;

export function signAppSession(secret: Buffer, s: AppSession): string {
  const json = Buffer.from(JSON.stringify(s), 'utf8');
  return `${json.toString('base64url')}.${createHmac('sha256', secret).update(Buffer.concat([Buffer.from('session:'), json])).digest('base64url')}`;
}

export function verifyAppSession(secret: Buffer, cookie: string, now: Date = new Date()): AppSession | null {
  const dot = cookie.indexOf('.');
  if (dot <= 0) return null;
  const json = Buffer.from(cookie.slice(0, dot), 'base64url');
  const given = Buffer.from(cookie.slice(dot + 1), 'base64url');
  const expected = createHmac('sha256', secret).update(Buffer.concat([Buffer.from('session:'), json])).digest();
  if (!json.length || given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let s: AppSession;
  try { s = JSON.parse(json.toString('utf8')) as AppSession; } catch { return null; }
  return typeof s.exp === 'number' && s.exp * 1000 > now.getTime() && typeof s.accountId === 'string' ? s : null;
}

/**
 * A hosted app's ticket for one caller (§6.3): who called it, for a short while. The host hands one with each tool call
 * and each screen request; the app hands it back to SUITE to act as that caller. It cannot make one up: it is signed
 * with the install's secret, which the app never holds.
 */
export interface AppTicket { app: string; org: string; accountId: string; userId: string; via: string | null; invokedBy: string | null; exp: number }

/** How long a ticket lasts: one request's work, with room for a slow one. */
export const APP_TICKET_SECONDS = 120;

export function signAppTicket(secret: Buffer, t: Omit<AppTicket, 'exp'>, now: Date = new Date()): string {
  const json = Buffer.from(JSON.stringify({ ...t, exp: Math.floor(now.getTime() / 1000) + APP_TICKET_SECONDS }), 'utf8');
  return `${json.toString('base64url')}.${createHmac('sha256', secret).update(Buffer.concat([Buffer.from('ticket:'), json])).digest('base64url')}`;
}

export function verifyAppTicket(secret: Buffer, ticket: string, now: Date = new Date()): AppTicket | null {
  if (typeof ticket !== 'string') return null;
  const dot = ticket.indexOf('.');
  if (dot <= 0) return null;
  const json = Buffer.from(ticket.slice(0, dot), 'base64url');
  const given = Buffer.from(ticket.slice(dot + 1), 'base64url');
  const expected = createHmac('sha256', secret).update(Buffer.concat([Buffer.from('ticket:'), json])).digest();
  if (!json.length || given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let t: AppTicket;
  try { t = JSON.parse(json.toString('utf8')) as AppTicket; } catch { return null; }
  return typeof t.exp === 'number' && t.exp * 1000 > now.getTime() && typeof t.accountId === 'string' ? t : null;
}

/**
 * A hosted app's upload address (§8.1): one POST, for a few minutes, to one of the app's own routes, as the caller who
 * asked for it. The app asks with the caller's ticket (ctx.files.uploadUrl); the host redeems it on the app's own host,
 * where the bearer has no session, and hands the bytes to that route with the caller as the viewer. Signed with the
 * install's (or the draft's) secret, apart from tickets and sessions by its own prefix.
 */
export interface AppUpload {
  app: string; org: string; dev: string | null;
  accountId: string; userId: string; via: string | null; invokedBy: string | null;
  displayName: string; isAgent: boolean; scopes: string[];
  /** The app's route, with its query: `/api/tasks/42/images?name=shot.png`. */
  path: string;
  jti: string; exp: number;
}

/** How long an upload address works. */
export const APP_UPLOAD_SECONDS = 300;

export function signAppUpload(secret: Buffer, u: Omit<AppUpload, 'exp' | 'jti'>, now: Date = new Date()): { token: string; exp: number } {
  const exp = Math.floor(now.getTime() / 1000) + APP_UPLOAD_SECONDS;
  const json = Buffer.from(JSON.stringify({ ...u, jti: randomBytes(12).toString('base64url'), exp }), 'utf8');
  return { token: `${json.toString('base64url')}.${createHmac('sha256', secret).update(Buffer.concat([Buffer.from('upload:'), json])).digest('base64url')}`, exp };
}

/** The upload's payload, or null: malformed, another secret, or expired. Whether it was used already is the caller's to check. */
export function verifyAppUpload(secret: Buffer, token: string, now: Date = new Date()): AppUpload | null {
  if (typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const json = Buffer.from(token.slice(0, dot), 'base64url');
  const given = Buffer.from(token.slice(dot + 1), 'base64url');
  const expected = createHmac('sha256', secret).update(Buffer.concat([Buffer.from('upload:'), json])).digest();
  if (!json.length || given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let u: AppUpload;
  try { u = JSON.parse(json.toString('utf8')) as AppUpload; } catch { return null; }
  if (typeof u.accountId !== 'string' || typeof u.path !== 'string' || typeof u.jti !== 'string' || !Array.isArray(u.scopes)) return null;
  return typeof u.exp === 'number' && u.exp * 1000 > now.getTime() ? u : null;
}

/** The token's app and organization, unverified: only to find which secret to check it with. */
export function peekAppUpload(token: string): { app: string; org: string; dev: string | null } | null {
  try {
    const u = JSON.parse(Buffer.from(token.slice(0, token.indexOf('.')), 'base64url').toString('utf8')) as Partial<AppUpload>;
    return typeof u.app === 'string' && typeof u.org === 'string' ? { app: u.app, org: u.org, dev: typeof u.dev === 'string' ? u.dev : null } : null;
  } catch {
    return null;
  }
}
