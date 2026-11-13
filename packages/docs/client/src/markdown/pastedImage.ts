// A picture pasted or dropped into a Markdown document is stored as a file beside the document and written into
// the text as `<img src="relative path" alt="name" width="…">` (imgTags.ts), which the preview reads from the
// document's folder (imagePaths.ts), as on GitHub.
import { pastedFile } from '../pastedFile.ts';
import { imgTag } from './imgTags.ts';

const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp|svg\+xml|avif)$/;

/** The picture in a paste or a drop, named as the file list names a pasted one; null when there is none. */
export function imageIn(data: Pick<DataTransfer, 'files' | 'getData'> | null, now = new Date()): File | null {
  if (!data) return null;
  const file = Array.from(data.files).find((f) => IMAGE_TYPES.test(f.type));
  if (!file) return null;
  return pastedFile({ files: [file], getData: () => '' }, now);
}

/** A file name as a relative link: escaped where Markdown or a URL would read it otherwise. */
export function relativeLink(name: string): string {
  return name
    .split('/')
    .map((p) => encodeURIComponent(p).replace(/[()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join('/');
}

/** A picture stored beside the document: its relative address, its name, and the width to show it at. */
export interface StoredImage {
  src: string;
  alt: string;
  width?: number;
}

/** The picture stored as `filename`, shown at `width` (its size on the screen it was taken on). */
export function storedImage(filename: string, width?: number): StoredImage {
  return { src: relativeLink(filename), alt: filename.replace(/\.[^.]+$/, ''), ...(width && { width }) };
}

/** The Markdown written for a stored picture: an `<img>` tag, which can say its size (imgTags.ts). */
export function imageMarkdown(image: StoredImage): string {
  return imgTag(image);
}

/** The width to show a picture at: its pixels over the screen's, so a screenshot from a sharp screen shows at the size it was. */
export async function displayWidth(file: Blob, pixelRatio = window.devicePixelRatio || 1): Promise<number | undefined> {
  try {
    const bmp = await createImageBitmap(file);
    const width = Math.round(bmp.width / Math.max(1, pixelRatio));
    bmp.close();
    return width || undefined;
  } catch {
    return undefined;
  }
}
