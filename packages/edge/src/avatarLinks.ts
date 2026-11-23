// Public links to profile pictures, for services that load a picture without signing in (RealtimeKit draws a meeting
// participant's picture from the address it is given: org/services/meetings.ts, meetingAgents.ts). A picture the suite
// keeps (`/v1/avatars/<key>`) needs a session, so it gets a signed link, `/v1/public/avatars/<key>?s=<sig>`, which
// routes/org.ts serves to anyone holding it. The signature is an HMAC of the key under a secret derived from
// FLOW_DATA_KEY, so a link cannot be made for a key without it. A link shows one picture only, and a new upload gets a
// new key, so it does not expire. An agent's preset picture (`/agent-avatars/<name>.svg`) is a public file already: it
// only needs the suite's origin. An outside https address is used as it is.
import { createHmac, timingSafeEqual } from 'node:crypto';

export const PUBLIC_AVATAR_PATH = '/v1/public/avatars/';
/** A picture the suite keeps: `<user id>-<ms>.<ext>` (routes/org.ts), the older ones `.webp`. */
export const AVATAR_KEY = /^[0-9a-f-]{36}-\d+(?:\.[a-z]{1,5})?$/;
const SUITE_AVATAR = /^\/v1\/avatars\/([0-9a-f-]{36}-\d+(?:\.[a-z]{1,5})?)$/;
const PRESET = /^\/agent-avatars\/[a-z0-9-]{1,40}\.svg$/;

const signatureOf = (secret: string, key: string) => createHmac('sha256', `avatar-link:${secret}`).update(key).digest('base64url');

/** Whether `sig` is the signature of `key`. */
export function checkAvatarSignature(secret: string | undefined, key: string, sig: string | undefined): boolean {
  if (!secret || !sig || !AVATAR_KEY.test(key)) return false;
  const want = Buffer.from(signatureOf(secret, key));
  const got = Buffer.from(sig);
  return want.length === got.length && timingSafeEqual(want, got);
}

/**
 * A picture's address that works without signing in, or null when there is none: a kept picture as a signed link (when
 * `secret` is known), a preset with the suite's origin, an outside https address as it is.
 */
export function publicPictureUrl(avatarUrl: string | null | undefined, p: { origin: string; secret: string | undefined }): string | null {
  if (!avatarUrl) return null;
  if (/^https:\/\//.test(avatarUrl)) return avatarUrl;
  const origin = p.origin.replace(/\/+$/, '');
  if (!/^https?:\/\//.test(origin)) return null;
  if (PRESET.test(avatarUrl)) return `${origin}${avatarUrl}`;
  const key = SUITE_AVATAR.exec(avatarUrl)?.[1];
  if (!key || !p.secret) return null;
  return `${origin}${PUBLIC_AVATAR_PATH}${key}?s=${signatureOf(p.secret, key)}`;
}

/**
 * A picture's type from its first bytes, for a file stored without an image type (pictures from before the move to R2
 * were kept as application/octet-stream): PNG, JPEG, GIF or WebP, else null.
 */
export function imageTypeOf(head: Uint8Array): string | null {
  const at = (i: number, ...bytes: number[]) => bytes.every((b, j) => head[i + j] === b);
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return 'image/png';
  if (at(0, 0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
  return null;
}
