// Mini-app identity tokens, the verifying half (docs/design/MINI_APPS.md).
//
//   flow_token = base64url(payloadJson) + "." + base64url(hmacSha256(secret, payloadJson))
//
// This is deliberately a standalone reimplementation of the server's
// `packages/server/src/lib/appToken.ts` rather than a shared import: the guard
// runs on the agent's machine, next to the app, and its whole promise is that
// verification is *offline* — no Flow calls, no server code, a few lines any
// language could rewrite. `verifyAppToken` here and `signAppToken` there are
// pinned together by app-token.test.ts, which signs with the documented recipe
// and verifies with this.
//
// The signature covers the exact payload *bytes* that travelled, so we HMAC the
// decoded segment, never a re-serialisation of the parsed object — key order
// and JSON spacing would otherwise silently break tokens.
import { createHmac, timingSafeEqual } from 'node:crypto';

/** exp − iat, as minted by the server. Also the ceiling on how long a burned
 * `jti` has to be remembered. */
export const APP_TOKEN_TTL_SECONDS = 300;

/** Version 1: an app artifact's viewer, in a channel. */
export interface ArtifactTokenPayload {
  v: 1;
  artifactId: string;
  channelId: string;
  workspaceId: string;
  userId: string;
  displayName: string;
  isAgent: boolean;
  iat: number; // unix seconds
  exp: number; // iat + APP_TOKEN_TTL_SECONDS
  jti: string; // single-use nonce; the guard remembers it until exp
}

/** Version 2: an installed app's viewer, from its tab (docs/specs/user-apps.md §6.2): the app and the viewer's account,
 * no artifact or channel. The secret is the install's. */
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

export type AppTokenPayload = ArtifactTokenPayload | UserAppTokenPayload;

/** The secret as it reaches the agent: base64url of 32 random bytes, straight
 * from `create_artifact`. Decoded once at startup so a typo fails loudly there
 * rather than as a mystery 401 later. */
export function decodeAppSecret(secret: string): Buffer {
  const raw = Buffer.from(secret.trim(), 'base64url');
  if (raw.length === 0) throw new Error('app secret is empty or not base64url');
  return raw;
}

function isPayload(p: unknown): p is AppTokenPayload {
  if (typeof p !== 'object' || p === null) return false;
  const o = p as Record<string, unknown>;
  const which =
    (o.v === 1 && typeof o.artifactId === 'string' && typeof o.channelId === 'string') ||
    (o.v === 2 && typeof o.app === 'string' && typeof o.accountId === 'string');
  return (
    which &&
    typeof o.workspaceId === 'string' &&
    typeof o.userId === 'string' &&
    typeof o.displayName === 'string' &&
    typeof o.isAgent === 'boolean' &&
    typeof o.iat === 'number' &&
    typeof o.exp === 'number' &&
    typeof o.jti === 'string' &&
    o.jti.length > 0
  );
}

/**
 * Verify one token against one secret. Returns the payload, or null when the
 * token is malformed, signed by a different secret, or expired. Replay is the
 * caller's business (see `JtiStore`) — this function is pure.
 */
export function verifyAppToken(secret: Buffer, token: string, now: Date = new Date()): AppTokenPayload | null {
  const dot = token.indexOf('.');
  if (dot <= 0 || token.indexOf('.', dot + 1) !== -1) return null;
  const json = Buffer.from(token.slice(0, dot), 'base64url');
  const given = Buffer.from(token.slice(dot + 1), 'base64url');
  if (json.length === 0 || given.length === 0) return null;
  const expected = createHmac('sha256', secret).update(json).digest();
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(json.toString('utf8'));
  } catch {
    return null;
  }
  if (!isPayload(payload)) return null;
  if (payload.exp * 1000 <= now.getTime()) return null;
  return payload;
}

/**
 * Verify against every secret the guard was given. One app can be pinned in
 * several channels — a second artifact, a second secret (MINI_APPS.md risk #5)
 * — and a rotation means running with old and new for the overlap. Cost is one
 * HMAC per secret, and the list is a handful long.
 */
export function verifyAppTokenAny(secrets: Buffer[], token: string, now: Date = new Date()): AppTokenPayload | null {
  for (const s of secrets) {
    const payload = verifyAppToken(s, token, now);
    if (payload) return payload;
  }
  return null;
}

/**
 * Seen `jti`s, remembered until their token would have expired anyway. A token
 * is a door key: it opens the guard once and is then dead. Memory is bounded by
 * the 5-minute window — the sweep on every `burn` keeps it that way without a
 * timer to leak.
 */
export class JtiStore {
  private seen = new Map<string, number>(); // jti → exp (unix seconds)

  /** Record `jti` as used. Returns false if it had already been burned — that
   * is a replay, and the caller must reject. */
  burn(jti: string, expSeconds: number, now: Date = new Date()): boolean {
    const nowSeconds = Math.floor(now.getTime() / 1000);
    for (const [k, exp] of this.seen) if (exp <= nowSeconds) this.seen.delete(k);
    if (this.seen.has(jti)) return false;
    this.seen.set(jti, expSeconds);
    return true;
  }

  get size(): number {
    return this.seen.size;
  }
}
