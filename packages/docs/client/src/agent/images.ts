// Images pasted or dropped into the chat: downscale and re-encode in the browser so a screenshot stays
// well under the API's size limit and the model gets a readable but not huge image.
import { IMAGE_MEDIA_TYPES, type AgentImage } from '../../../shared/agent/protocol.ts';

/** Longest side the model needs; larger images only cost tokens. */
const MAX_SIDE = 1568;
/** Above this many bytes an image is re-encoded even when it is small enough in pixels. */
const MAX_BYTES = 1_500_000;

export interface PreparedImage extends AgentImage {
  /** For showing a thumbnail. */
  dataUrl: string;
}

export function isImageFile(file: File): boolean {
  return IMAGE_MEDIA_TYPES.has(file.type);
}

/** Image files among the items of a paste or drop. */
export function imageFiles(data: DataTransfer | null): File[] {
  if (!data) return [];
  const files: File[] = [];
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind !== 'file') continue;
    const f = item.getAsFile();
    if (f && isImageFile(f)) files.push(f);
  }
  if (!files.length) for (const f of Array.from(data.files ?? [])) if (isImageFile(f)) files.push(f);
  return files;
}

export async function prepareImage(file: File): Promise<PreparedImage> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size <= MAX_BYTES && file.type !== 'image/gif') {
    bitmap.close();
    const dataUrl = await readAsDataUrl(file);
    return { mediaType: file.type as AgentImage['mediaType'], data: dataUrl.slice(dataUrl.indexOf(',') + 1), dataUrl };
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d')!;
  // Screenshots are mostly text on a light ground; a white backdrop keeps transparent PNGs readable as JPEG.
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  // PNG keeps UI text crisp; fall back to JPEG when the PNG would still be big.
  let dataUrl = canvas.toDataURL('image/png');
  let mediaType: AgentImage['mediaType'] = 'image/png';
  if (dataUrl.length > MAX_BYTES * 1.37) {
    dataUrl = canvas.toDataURL('image/jpeg', 0.9);
    mediaType = 'image/jpeg';
  }
  return { mediaType, data: dataUrl.slice(dataUrl.indexOf(',') + 1), dataUrl };
}

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error('Could not read the image.'));
    r.readAsDataURL(file);
  });
}
