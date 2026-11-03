// Cloudflare Images (the `IMAGES` binding in wrangler.toml): resizing and re-encoding where Node had sharp. Re-encoding
// also drops an image's metadata (EXIF, XMP, ICC), as sharp did. Without the binding, or when a call fails (a format it
// cannot read, the free plan's monthly allowance spent), each helper returns null and the caller keeps the image as it
// came. Pricing and limits: docs at developers.cloudflare.com/images/transform-images/bindings/.
let images: ImagesBinding | undefined;
export const setImagesEnv = (env: { IMAGES?: ImagesBinding }) => { images = env.IMAGES; };

/** The binding takes 20 MB at most. */
const MAX_INPUT_BYTES = 20 * 1024 * 1024;

export interface ImageSize { width: number; height: number; format: string }
export interface Transformed { bytes: Buffer; width: number; height: number; contentType: string }

const stream = (data: Uint8Array) => new Response(data as Uint8Array<ArrayBuffer>).body!;

/** An image's size and format, read by the binding (not billed). Null without one, or for SVG and anything not an image. */
export async function imageInfo(data: Uint8Array): Promise<ImageSize | null> {
  if (!images || data.length > MAX_INPUT_BYTES) return null;
  try {
    const info = await images.info(stream(data));
    return 'width' in info && info.width > 0 && info.height > 0 ? { width: info.width, height: info.height, format: info.format } : null;
  } catch {
    return null;
  }
}

/** Resize and re-encode to WebP, first frame only (as sharp did by default); the size reported is the output's. */
export async function toWebp(data: Uint8Array, transform: ImageTransform, quality: number): Promise<Transformed | null> {
  if (!images || data.length > MAX_INPUT_BYTES) return null;
  try {
    const out = await images.input(stream(data)).transform(transform).output({ format: 'image/webp', quality, anim: false });
    const bytes = Buffer.from(await new Response(out.image()).arrayBuffer());
    const size = await imageInfo(bytes);
    if (!size || bytes.length === 0) return null;
    return { bytes, width: size.width, height: size.height, contentType: out.contentType() };
  } catch (err) {
    console.warn(`[images] transform failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
