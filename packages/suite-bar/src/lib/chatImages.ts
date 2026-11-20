// Images pasted, dropped or picked into the suite's assistant panel (AssistantChat.tsx): downscaled and re-encoded in the
// browser, as Docs' panel does (packages/docs/client/src/agent/images.ts), so a screenshot stays well under the model's
// size limit and is still readable. Sent with the turn as POST /api/agent/turn's `images`.

/** One image as a turn carries it: its type and base64 bytes (no data: prefix), and a data: URL for its thumbnail. */
export interface ChatImage { mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; data: string; dataUrl: string }

export const CHAT_IMAGE_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
/** At most this many images in one message (Docs' MAX_IMAGES_PER_MESSAGE). */
export const MAX_CHAT_IMAGES = 4;
/** Longest side the model needs; larger images only cost tokens. */
const MAX_SIDE = 1568;
/** Above this many bytes an image is re-encoded even when it is small enough in pixels. */
const MAX_BYTES = 1_500_000;

/** The image files among a paste's or a drop's items. */
export function imageFiles(data: DataTransfer | null): File[] {
  if (!data) return [];
  const files: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== 'file') continue;
    const f = item.getAsFile();
    if (f && CHAT_IMAGE_TYPES.has(f.type)) files.push(f);
  }
  if (!files.length) for (const f of Array.from(data.files ?? [])) if (CHAT_IMAGE_TYPES.has(f.type)) files.push(f);
  return files;
}

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error('Could not read the image.'));
    r.readAsDataURL(file);
  });
}

const parts = (dataUrl: string, mediaType: ChatImage['mediaType']): ChatImage => ({ mediaType, data: dataUrl.slice(dataUrl.indexOf(',') + 1), dataUrl });

/** An image file ready to send: as it is when small enough, else scaled down to PNG, or JPEG when the PNG is still big. */
export async function prepareChatImage(file: File): Promise<ChatImage> {
  const type = file.type as ChatImage['mediaType'];
  if (typeof createImageBitmap !== 'function') return parts(await readAsDataUrl(file), type);
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size <= MAX_BYTES && type !== 'image/gif') {
    bitmap.close();
    return parts(await readAsDataUrl(file), type);
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d')!;
  // Screenshots are mostly text on a light ground: a white backdrop keeps a transparent PNG readable as JPEG.
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const png = canvas.toDataURL('image/png');
  return png.length > MAX_BYTES * 1.37 ? parts(canvas.toDataURL('image/jpeg', 0.9), 'image/jpeg') : parts(png, 'image/png');
}
