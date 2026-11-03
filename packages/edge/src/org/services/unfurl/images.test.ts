// Preview images on Cloudflare Images (lib/images.ts), with the binding mocked: resized and re-encoded to WebP at the
// server's two sizes, and stored as fetched when the binding is absent or fails.
import http from 'node:http';
import zlib from 'node:zlib';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setImagesEnv } from '../../lib/images.js';
import sharp from '../../lib/sharp.js';
import { setStorageEnv } from '../../storage/index.js';
import { proxyImage } from './images.js';

function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const b = Buffer.alloc(12 + data.length);
    b.writeUInt32BE(data.length, 0);
    b.write(type, 4, 'latin1');
    data.copy(b, 8);
    b.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type, 'latin1'), data])), 8 + data.length);
    return b;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.alloc(height * (width + 1)))), chunk('IEND', Buffer.alloc(0))]);
}

// The mock's output: "RIFF....WEBP" (so it sniffs as WebP) and the size it was made at.
const fakeWebp = (w: number, h: number) => Buffer.concat([Buffer.from('RIFF\0\0\0\0WEBP', 'latin1'), Buffer.from(JSON.stringify({ w, h }))]);
const read = async (s: ReadableStream<Uint8Array>) => Buffer.from(await new Response(s).arrayBuffer());

/** Sizes as Cloudflare Images computes them for the fits used here. */
function fitted(w: number, h: number, t: ImageTransform): { w: number; h: number } {
  const tw = t.width ?? w, th = t.height ?? h;
  if (t.fit === 'cover') return { w: tw, h: th };
  const scale = Math.min(tw / w, th / h, t.fit === 'scale-down' ? 1 : Infinity);
  return { w: Math.round(w * scale), h: Math.round(h * scale) };
}

function mockImages(opts: { fail?: boolean } = {}) {
  const calls: { transform: ImageTransform; output: ImageOutputOptions }[] = [];
  const sizeOf = (b: Buffer) => (b.subarray(0, 12).toString('latin1') === 'RIFF\0\0\0\0WEBP' ? (JSON.parse(b.subarray(12).toString()) as { w: number; h: number }) : { w: b.readUInt32BE(16), h: b.readUInt32BE(20) });
  const binding = {
    async info(stream: ReadableStream<Uint8Array>) {
      const { w, h } = sizeOf(await read(stream));
      return { format: 'image/png', fileSize: 0, width: w, height: h };
    },
    input(stream: ReadableStream<Uint8Array>) {
      let t: ImageTransform = {};
      const handle = {
        transform(next: ImageTransform) { t = next; return handle; },
        async output(output: ImageOutputOptions) {
          if (opts.fail) throw new Error('9422: transformation limit reached');
          calls.push({ transform: t, output });
          const { w, h } = sizeOf(await read(stream));
          const out = fitted(w, h, t);
          return { contentType: () => output.format, image: () => new Response(fakeWebp(out.w, out.h)).body!, response: () => new Response() };
        },
      };
      return handle;
    },
  };
  return { binding: binding as unknown as ImagesBinding, calls };
}

const blobs = new Map<string, Buffer>();
const BLOBS = {
  async put(key: string, data: Uint8Array) { blobs.set(key, Buffer.from(data)); },
  async get(key: string) { const b = blobs.get(key); return b ? { arrayBuffer: async () => b } : null; },
} as unknown as R2Bucket;

let server: http.Server;
let base = '';
const big = png(2400, 1260);
const small = png(300, 200);
beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.setHeader('content-type', 'image/png');
    res.end(req.url === '/big.png' ? big : small);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
  process.env.FLOW_UNFURL_ALLOW_HOSTS = 'localhost';
  setStorageEnv({ BLOBS });
});
afterAll(() => { delete process.env.FLOW_UNFURL_ALLOW_HOSTS; setImagesEnv({}); server.close(); });
beforeEach(() => blobs.clear());

describe('proxyImage with Cloudflare Images', () => {
  it('stores WebP at 1200×630 inside and a 128×128 cover thumbnail, and reports the served size', async () => {
    const { binding, calls } = mockImages();
    setImagesEnv({ IMAGES: binding });
    const img = await proxyImage(`${base}/big.png`);
    expect(img).toMatchObject({ width: 1200, height: 630 });
    expect(img!.url).toMatch(/^\/v1\/unfurl-images\/[0-9a-f]{32}-large\.webp$/);
    expect(img!.thumbUrl).toMatch(/^\/v1\/unfurl-images\/[0-9a-f]{32}-thumb\.webp$/);
    expect(calls.map((c) => c.transform)).toEqual([{ width: 1200, height: 630, fit: 'scale-down' }, { width: 128, height: 128, fit: 'cover' }]);
    expect(calls.every((c) => c.output.format === 'image/webp' && c.output.anim === false)).toBe(true);
    // What is stored is the binding's re-encoding, never the original bytes (which may carry EXIF).
    expect(blobs.get(img!.url.replace('/v1/', ''))).toEqual(fakeWebp(1200, 630));
    expect(blobs.get(img!.thumbUrl.replace('/v1/', ''))).toEqual(fakeWebp(128, 128));
    expect([...blobs.values()].some((b) => b.equals(big))).toBe(false);
  });

  it('never enlarges a small picture', async () => {
    setImagesEnv({ IMAGES: mockImages().binding });
    expect(await proxyImage(`${base}/small.png`)).toMatchObject({ width: 300, height: 200 });
  });

  it('stores the image as fetched without the binding', async () => {
    setImagesEnv({});
    const img = await proxyImage(`${base}/big.png`);
    expect(img).toMatchObject({ width: 2400, height: 1260 });
    expect(img!.url).toMatch(/-large\.png$/);
    expect(img!.thumbUrl).toBe(img!.url);
    expect(blobs.get(img!.url.replace('/v1/', ''))).toEqual(big);
  });

  it('stores the image as fetched when the binding fails', async () => {
    setImagesEnv({ IMAGES: mockImages({ fail: true }).binding });
    const img = await proxyImage(`${base}/big.png`);
    expect(img).toMatchObject({ width: 2400, height: 1260 });
    expect(img!.url).toMatch(/-large\.png$/);
    expect(blobs.size).toBe(1);
  });
});

describe('the sharp stand-in (attachment thumbnails, avatars)', () => {
  it('resizes on the binding: inside without enlargement is scale-down, and metadata comes from info', async () => {
    const { binding, calls } = mockImages();
    setImagesEnv({ IMAGES: binding });
    expect(await sharp(big).metadata()).toMatchObject({ width: 2400, height: 1260 });
    const thumb = await sharp(big).resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true }).webp({ quality: 80 }).toBuffer();
    expect(thumb).toEqual(fakeWebp(512, 269));
    expect(calls[0]).toEqual({ transform: { width: 512, height: 512, fit: 'scale-down' }, output: { format: 'image/webp', quality: 80, anim: false } });
  });
  it('passes the image through without the binding, or when it fails', async () => {
    setImagesEnv({});
    expect(await sharp(big).resize({ width: 64, height: 64, fit: 'cover' }).webp().toBuffer()).toEqual(big);
    expect(await sharp(big).metadata()).toEqual({});
    setImagesEnv({ IMAGES: mockImages({ fail: true }).binding });
    expect(await sharp(big).resize({ width: 64, height: 64, fit: 'cover' }).webp().toBuffer()).toEqual(big);
  });
});
