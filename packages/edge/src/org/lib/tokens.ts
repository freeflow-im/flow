import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Random 32-byte token, base64url-encoded (returned to the client once). */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Random 16-byte token for the one case where the token lives in a URL a human
 * shares by hand (workspace join links, #85). 22 base64url characters instead
 * of 43, which keeps the whole link on one line in a chat client. 128 bits is
 * still far past guessing; the endpoints that take it are rate-limited.
 */
export function newLinkToken(): string {
  return randomBytes(16).toString('base64url');
}

/** sha256 of the raw token — the only thing we store. */
export function hashToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

export function tokensEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
