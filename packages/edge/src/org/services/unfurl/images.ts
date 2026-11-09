// Phase 11 §6: the image proxy.
//
// We never hotlink. Every image referenced by a card is fetched here under the
// same SSRF guard as the page, validated by its actual bytes (not its declared
// content-type), and stored under a content-addressed key. Clients only ever
// see our own URLs, so a card can't leak a viewer's IP to a third-party CDN or
// execute anything.
//
// Cloudflare Images (lib/images.ts) re-encodes each image to WebP at the two
// sizes sharp made on Node, which also drops its metadata. Without the binding,
// or when it fails, the image is stored as it came, once, after its real size is
// read from its header; both URLs name it, and the clients scale it. A format
// whose size cannot be read that way (AVIF) is then left out.
//
// Every failure path returns null: §6 says an image problem must degrade the
// card to text-only, never fail the whole unfurl.
import { createHash } from 'node:crypto';
import { imageSize } from '@flow/docs/server/imageSize.ts';
import { imageInfo, toWebp } from '../../lib/images.js';
import { blobStore } from '../../storage/index.js';
import { guardedFetch } from './fetcher.js';

/** §6 fetch cap for images. */
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** §6 decompression-bomb guards. */
const MAX_AXIS_PX = 12_000;
const MAX_MEGAPIXELS = 100;

/** §6 output sizes, as on Node. */
const LARGE = { width: 1200, height: 630 };
const THUMB = { width: 128, height: 128 };

/** Stored as fetched (without the binding), so a smaller cap than the fetch's: every viewer downloads it. */
const MAX_STORED_BYTES = 3 * 1024 * 1024;

/** The stored key's extension and the type it is served with. */
export const UNFURL_IMAGE_TYPES = { jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' } as const;
const EXTENSION = { jpeg: 'jpg', png: 'png', gif: 'gif', webp: 'webp' } as const;

export interface ProxiedImage {
  url: string;
  thumbUrl: string;
  width: number;
  height: number;
}

/**
 * Real format from magic bytes. The declared content-type is attacker-
 * controlled, so it is deliberately ignored.
 *
 * SVG is rejected outright (§6): it is a script vector, not an image format.
 * It has no magic number, so "unrecognised" covers it — but we also refuse
 * anything that merely looks like XML/text, to be explicit about it.
 */
export function sniffImageFormat(bytes: Buffer): 'jpeg' | 'png' | 'gif' | 'webp' | 'avif' | null {
  if (bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) {
    return 'png';
  }
  if (bytes.subarray(0, 4).toString('latin1') === 'GIF8') return 'gif';
  if (bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') {
    return 'webp';
  }
  if (bytes.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = bytes.subarray(8, 12).toString('latin1');
    if (brand === 'avif' || brand === 'avis') return 'avif';
  }
  return null; // includes SVG and every other non-raster payload
}

/**
 * Fetch → validate → re-encode → store. Returns the URLs clients should use,
 * or null if anything at all went wrong.
 */
export async function proxyImage(imageUrl: string, deadline?: number): Promise<ProxiedImage | null> {
  try {
    const res = await guardedFetch(imageUrl, {
      accept: 'image/*',
      maxBytes: MAX_IMAGE_BYTES,
      ...(deadline !== undefined ? { deadline } : {}),
    });
    if (res.status < 200 || res.status >= 400) return null;

    const format = sniffImageFormat(res.bytes);
    if (!format) return null; // unrecognised, or SVG
    if (res.bytes.length >= MAX_IMAGE_BYTES) return null; // cut off by the cap

    // The binding reads every format we accept; the header reader all but AVIF.
    const size = (await imageInfo(res.bytes)) ?? (format === 'avif' ? null : (imageSize(res.bytes) as { width: number; height: number } | null));
    if (!size) return null;
    const { width, height } = size;
    if (width <= 0 || height <= 0) return null;
    if (width > MAX_AXIS_PX || height > MAX_AXIS_PX) return null;
    if ((width * height) / 1_000_000 > MAX_MEGAPIXELS) return null;

    // §6: keyed by content hash — the same image shared twice stores once.
    const hash = createHash('sha256').update(res.bytes).digest('hex').slice(0, 32);

    // `scale-down` is sharp's inside-without-enlargement; re-encoding drops EXIF/XMP/ICC (§6).
    const [large, thumb] = await Promise.all([
      toWebp(res.bytes, { ...LARGE, fit: 'scale-down' }, 82),
      toWebp(res.bytes, { ...THUMB, fit: 'cover' }, 80),
    ]);
    if (large && thumb) {
      await Promise.all([
        blobStore().put(`unfurl-images/${hash}-large.webp`, large.bytes),
        blobStore().put(`unfurl-images/${hash}-thumb.webp`, thumb.bytes),
      ]);
      // Report the dimensions of what we actually serve, not of the original.
      return { url: `/v1/unfurl-images/${hash}-large.webp`, thumbUrl: `/v1/unfurl-images/${hash}-thumb.webp`, width: large.width, height: large.height };
    }

    // No binding, or it failed: store the original, which every viewer then downloads.
    if (format === 'avif') return null;
    if (res.bytes.length >= MAX_STORED_BYTES) return null;
    const key = `${hash}-large.${EXTENSION[format]}`;
    await blobStore().put(`unfurl-images/${key}`, res.bytes);
    return { url: `/v1/unfurl-images/${key}`, thumbUrl: `/v1/unfurl-images/${key}`, width, height };
  } catch {
    return null; // §6: never fail the card over its image
  }
}

/**
 * §6 layout hint, refined once we know the image's real dimensions.
 *
 * The spec's rule is `twitter:card=summary_large_image`, or
 * `width >= 600 && aspect in [1.4, 2.2]`. That band is aimed at wide desktop
 * hero images, and it misclassifies most social media:
 *   - X post previews are ~1:1 (630×630) — aspect outside the band
 *   - TikTok / Reels thumbnails are 9:16 portrait (354×630) — likewise
 * Both would render as an 80px chip where Slack shows them full size.
 *
 * What the band was really protecting against is logos/icons and thin banner
 * strips. So judge that directly instead of by width alone: the image is
 * "media" when its long side is big, its short side isn't a sliver, and it
 * isn't an extreme strip. Orientation stops mattering, which is the point.
 */
const MEDIA_LONG_SIDE_PX = 600;
const MEDIA_SHORT_SIDE_PX = 200;
const MEDIA_MAX_ASPECT = 2.5; // beyond this it's a banner, not a picture

export function layoutFor(width: number, height: number, twitterLargeImage: boolean): 'thumbnail' | 'large_image' {
  if (twitterLargeImage) return 'large_image';
  if (height <= 0 || width <= 0) return 'thumbnail';
  const long = Math.max(width, height);
  const short = Math.min(width, height);
  const aspect = long / short; // orientation-independent
  if (long >= MEDIA_LONG_SIDE_PX && short >= MEDIA_SHORT_SIDE_PX && aspect <= MEDIA_MAX_ASPECT) {
    return 'large_image';
  }
  return 'thumbnail';
}

/** Keys we will serve — content hash + size, nothing user-controlled. */
export const UNFURL_IMAGE_KEY_RE = /^[0-9a-f]{32}-(large|thumb)\.(webp|jpg|png|gif)$/;
