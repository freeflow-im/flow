// Browser side of the PowerPoint export: loads the deck's images as data URLs and saves the file.
import { writePptx } from '../../../shared/pptxExport.ts';
import { titleBase } from '../../../shared/docNames.ts';
import type { Deck } from '../../../shared/deck.ts';

async function loadImage(src: string): Promise<string | null> {
  if (src.startsWith('data:')) return src;
  try {
    const res = await fetch(src, { credentials: 'same-origin' });
    if (!res.ok) return null;
    const blob = await res.blob();
    if (!blob.type.startsWith('image/')) return null;
    return await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null; // cross-origin images without CORS headers end up here
  }
}

/** Download the deck as <title>.pptx. Resolves with warnings about anything that could not be exported. */
export async function downloadPptx(deck: Deck, title: string): Promise<string[]> {
  title = titleBase(title);
  const { data, warnings } = await writePptx(deck, title, loadImage);
  const url = URL.createObjectURL(new Blob([data as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${title.replace(/[\\/:*?"<>|]+/g, '-')}.pptx`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return warnings;
}
