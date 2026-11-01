// What is pasted on the file list becomes a file, as a dropped one does: a picture is stored as a picture, and
// text becomes a Markdown document.

const IMAGE_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

const pad = (n: number) => String(n).padStart(2, '0');
const stamp = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} at ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`;

/** A name for pasted text: its first line, without Markdown's marks, cut to a comfortable length. */
function textName(text: string): string {
  const line = (text.split('\n').find((l) => l.trim()) ?? '')
    .replace(/^\s*(#{1,6}|[-*+>]|\d+[.)])\s+/, '')
    .replace(/[*_`~[\]<>]/g, '')
    .replace(/[\\/:\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!line) return 'Pasted text';
  return line.length > 60 ? `${line.slice(0, 60).replace(/\s+\S*$/, '') || line.slice(0, 60)}…` : line;
}

/**
 * The file to import for a paste, or null when the clipboard holds nothing to keep. A copied file comes as it
 * is; a copied picture (a screenshot, "Copy image") has no name of its own and is named by when it was pasted.
 */
export function pastedFile(data: { files: ArrayLike<File>; getData(format: string): string } | null, now = new Date()): File | null {
  if (!data) return null;
  const file = data.files[0];
  if (file) {
    const ext = IMAGE_EXT[file.type];
    // Browsers call a copied picture "image.png" whatever it was.
    if (ext && /^image\.[a-z]+$/i.test(file.name)) return new File([file], `Pasted image ${stamp(now)}.${ext}`, { type: file.type });
    return file;
  }
  const text = data.getData('text/plain').replace(/\r\n?/g, '\n');
  if (!text.trim()) return null;
  return new File([text], `${textName(text)}.md`, { type: 'text/markdown' });
}
