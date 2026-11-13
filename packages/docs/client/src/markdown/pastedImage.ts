// A picture pasted or dropped into a Markdown document is stored as a file beside the document and written into
// the text as `![name](relative path)`, which the preview reads from the document's folder (imagePaths.ts), as on GitHub.
import { pastedFile } from '../pastedFile.ts';

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

/** The Markdown of a picture stored as `filename` beside the document. */
export function imageMarkdown(filename: string): string {
  const alt = filename.replace(/\.[^.]+$/, '').replace(/[[\]\\]/g, '');
  return `![${alt}](${relativeLink(filename)})`;
}
