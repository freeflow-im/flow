// GET /v1/public/avatars/:key (routes/org.ts): a kept picture, to anyone holding its signed link (avatarLinks.ts), with
// no sign-in; a wrong or missing signature, or a file that is not a picture, is not found.
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { orgRoutes } from './org';
import { ApiError } from '../errors';
import { publicPictureUrl } from '../avatarLinks';

const SECRET = 'c2VjcmV0LWtleS1mb3ItdGVzdHMtb25seS0xMjM0NTY=';
const KEY = '01a206fd-d420-76f5-824a-c1ebb91132a1-1795412000000.png';
const SVG_KEY = '01a206fd-d420-76f5-824a-c1ebb91132a1-1795412000001.svg';
const OLD_KEY = '019f7d15-4106-7c1a-9f8e-64bae430b447-1784510046641.webp';
const BIN_KEY = '019f7d15-4106-7c1a-9f8e-64bae430b447-1784510046642.webp';
const WEBP = String.fromCharCode(0x52, 0x49, 0x46, 0x46, 0xf4, 0xd4, 0, 0, 0x57, 0x45, 0x42, 0x50) + 'VP8 data';

const stored: Record<string, { body: string; type: string }> = {
  [`avatars/${KEY}`]: { body: 'PNGDATA', type: 'image/png' },
  [`avatars/${SVG_KEY}`]: { body: '<svg/>', type: 'image/svg+xml' },
  // From before the move to R2: stored as application/octet-stream.
  [`avatars/${OLD_KEY}`]: { body: WEBP, type: 'application/octet-stream' },
  [`avatars/${BIN_KEY}`]: { body: 'not a picture', type: 'application/octet-stream' },
};
const env = {
  FLOW_DATA_KEY: SECRET,
  BLOBS: { get: async (k: string) => (stored[k] ? { arrayBuffer: async () => Uint8Array.from(stored[k]!.body, (ch) => ch.charCodeAt(0)).buffer, httpMetadata: { contentType: stored[k]!.type } } : null) },
};
// As the Worker mounts it: an ApiError answers with its status (index.ts onError).
const app = new Hono().route('/', orgRoutes as never).onError((err, c) => c.json({ error: err.message }, (err instanceof ApiError ? err.statusCode : 500) as never));
const get = (path: string) => app.request(path, {}, env as never);
const linkOf = (key: string) => new URL(publicPictureUrl(`/v1/avatars/${key}`, { origin: 'https://app.test', secret: SECRET })!).pathname
  + new URL(publicPictureUrl(`/v1/avatars/${key}`, { origin: 'https://app.test', secret: SECRET })!).search;

describe('public picture links', () => {
  it('serves the picture to anyone with the signed link, cacheable', async () => {
    const res = await get(linkOf(KEY));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toContain('public');
    expect(await res.text()).toBe('PNGDATA');
  });

  it('serves an older picture stored without an image type by what its bytes are', async () => {
    const res = await get(linkOf(OLD_KEY));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/webp');
    expect((await get(linkOf(BIN_KEY))).status).toBe(404);
  });

  it('refuses a missing or wrong signature, and a file that is not a picture', async () => {
    expect((await get(`/v1/public/avatars/${KEY}`)).status).toBe(404);
    expect((await get(`/v1/public/avatars/${KEY}?s=AAAA`)).status).toBe(404);
    expect((await get(linkOf(SVG_KEY))).status).toBe(404);
  });
});
