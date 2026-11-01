// Export a deck as a PDF: each slide is drawn by renderSlideImage (the same renderer as render_slide and present
// mode), encoded as a JPEG and placed on its own 960x540 point page.
import { SLIDE_H, SLIDE_W, type Deck } from '../../../shared/deck.ts';
import { renderSlideImage } from './renderSlide.ts';

export interface PdfPage {
  jpeg: Uint8Array;
  /** Pixel size of the picture. */
  width: number;
  height: number;
}

const enc = new TextEncoder();

/** A PDF with one full-page JPEG per page, each page SLIDE_W x SLIDE_H points. */
export function buildPdf(pages: PdfPage[]): Blob {
  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (p: Uint8Array | string) => {
    const b = typeof p === 'string' ? enc.encode(p) : p;
    parts.push(b);
    length += b.length;
  };
  const object = (n: number, body: string | (() => void)) => {
    offsets[n] = length;
    push(`${n} 0 obj\n`);
    if (typeof body === 'string') push(body);
    else body();
    push('\nendobj\n');
  };
  push('%PDF-1.4\n');
  // Objects: 1 catalog, 2 page tree, then per page: page, content, image.
  object(1, '<< /Type /Catalog /Pages 2 0 R >>');
  object(2, `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, k) => `${3 + 3 * k} 0 R`).join(' ')}] >>`);
  pages.forEach((p, k) => {
    const page = 3 + 3 * k;
    object(page, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${SLIDE_W} ${SLIDE_H}] /Resources << /XObject << /Im0 ${page + 2} 0 R >> >> /Contents ${page + 1} 0 R >>`);
    const content = `q ${SLIDE_W} 0 0 ${SLIDE_H} 0 0 cm /Im0 Do Q`;
    object(page + 1, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    object(page + 2, () => {
      push(`<< /Type /XObject /Subtype /Image /Width ${p.width} /Height ${p.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`);
      push(p.jpeg);
      push('\nendstream');
    });
  });
  const count = 3 + 3 * pages.length;
  const xref = length;
  push(`xref\n0 ${count}\n0000000000 65535 f \n`);
  for (let n = 1; n < count; n++) push(`${String(offsets[n]).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return new Blob(parts as BlobPart[], { type: 'application/pdf' });
}

/** Render every slide at 2x and assemble the PDF. */
export async function deckToPdf(deck: Deck): Promise<Blob> {
  const pages: PdfPage[] = [];
  for (const slide of deck.slides) {
    const r = await renderSlideImage(slide, deck.theme, 2);
    const bitmap = await createImageBitmap(r.blob);
    const canvas = document.createElement('canvas');
    canvas.width = r.width;
    canvas.height = r.height;
    const g = canvas.getContext('2d')!;
    g.fillStyle = '#fff';
    g.fillRect(0, 0, r.width, r.height);
    g.drawImage(bitmap, 0, 0);
    const jpeg = await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('A slide could not be encoded.'))), 'image/jpeg', 0.92));
    pages.push({ jpeg: new Uint8Array(await jpeg.arrayBuffer()), width: r.width, height: r.height });
  }
  return buildPdf(pages);
}
