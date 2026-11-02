// Mini-app identity tokens (docs/design/MINI_APPS.md — "The token").
//
//   flow_token = base64url(payloadJson) + "." + base64url(hmacSha256(secret, payloadJson))
//
// One fixed algorithm, no `alg` header to attack, verifiable in a few lines in
// any language — the guard that verifies these ships in the agent bridge and
// never calls Flow. `v` exists so the format can evolve. The signature covers
// the exact payload *bytes* that travel, so a verifier must HMAC the decoded
// segment rather than a re-serialisation of the parsed object.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** exp − iat. A door key, not a session: it exists to get one browser through
 * the guard once. */
export const APP_TOKEN_TTL_SECONDS = 300;

export interface AppTokenPayload {
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

export function signAppToken(secret: Buffer, payload: AppTokenPayload): string {
  const json = Buffer.from(JSON.stringify(payload), 'utf8');
  const mac = createHmac('sha256', secret).update(json).digest();
  return `${json.toString('base64url')}.${mac.toString('base64url')}`;
}

/** Mint a token for `identity` against an app artifact's secret. `now` is
 * injectable for tests. */
export function mintAppToken(
  secret: Buffer,
  identity: Omit<AppTokenPayload, 'v' | 'iat' | 'exp' | 'jti'>,
  now: Date = new Date(),
): { token: string; payload: AppTokenPayload; expiresAt: Date } {
  const iat = Math.floor(now.getTime() / 1000);
  const payload: AppTokenPayload = {
    v: 1,
    ...identity,
    iat,
    exp: iat + APP_TOKEN_TTL_SECONDS,
    jti: randomBytes(16).toString('base64url'),
  };
  return { token: signAppToken(secret, payload), payload, expiresAt: new Date(payload.exp * 1000) };
}

/**
 * The reference verifier — what the guard reimplements offline. Returns the
 * payload, or null if the token is malformed, signed by another secret, or
 * expired. Replay (`jti`) is the verifier's business, not this function's.
 */
export function verifyAppToken(secret: Buffer, token: string, now: Date = new Date()): AppTokenPayload | null {
  const dot = token.indexOf('.');
  if (dot <= 0 || token.indexOf('.', dot + 1) !== -1) return null;
  const json = Buffer.from(token.slice(0, dot), 'base64url');
  const given = Buffer.from(token.slice(dot + 1), 'base64url');
  const expected = createHmac('sha256', secret).update(json).digest();
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  let payload: AppTokenPayload;
  try {
    payload = JSON.parse(json.toString('utf8')) as AppTokenPayload;
  } catch {
    return null;
  }
  if (payload.v !== 1) return null;
  if (typeof payload.exp !== 'number' || payload.exp * 1000 <= now.getTime()) return null;
  return payload;
}
