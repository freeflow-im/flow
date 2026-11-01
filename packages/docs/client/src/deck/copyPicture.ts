// Copying a picture on a slide puts it on the system clipboard too (as PNG, the one picture type browsers write),
// so it can be pasted into other apps. Its crop is applied; its clip shape, opacity and duotone are not.
import type { ImageElement } from '../../../shared/deck.ts';

/** The picture as a PNG, cut to the element's crop. */
export async function picturePng(el: Pick<ImageElement, 'src' | 'crop'>): Promise<Blob> {
  const res = await fetch(el.src);
  if (!res.ok) throw new Error(`The picture could not be read (${res.status}).`);
  const blob = await res.blob();
  if (!el.crop && blob.type === 'image/png') return blob;
  const bitmap = await createImageBitmap(blob);
  const { l, t, r, b } = el.crop ?? { l: 0, t: 0, r: 0, b: 0 };
  const w = Math.max(1, Math.round(bitmap.width * (1 - l - r)));
  const h = Math.max(1, Math.round(bitmap.height * (1 - t - b)));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  // A negative crop is a margin: the picture is drawn inside the larger canvas, the rest left clear.
  canvas.getContext('2d')!.drawImage(bitmap, -l * bitmap.width, -t * bitmap.height);
  bitmap.close();
  return new Promise((resolve, reject) => canvas.toBlob((png) => (png ? resolve(png) : reject(new Error('The picture could not be copied.'))), 'image/png'));
}

/**
 * Put the picture on the system clipboard. Called from the copy itself (a key or a menu): the clipboard is
 * written at once with the PNG still to come, which keeps the user's gesture that allows the write.
 */
export function copyPicture(el: ImageElement): Promise<void> {
  if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) return Promise.reject(new Error('This browser cannot copy pictures.'));
  return navigator.clipboard.write([new ClipboardItem({ 'image/png': picturePng(el) })]);
}
