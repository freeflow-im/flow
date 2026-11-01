// Signing a PDF: pictures (a signature) and lines of text put on its pages, written into the page content so
// they print and stay where they were put. The editor (client/src/pdf/PdfSigner.tsx) places them; this writes
// them, in the browser or on the server.
//
// A mark's position is in PDF points from the top left of the page as it is shown, that is after the page's
// own rotation, which is how the editor and anyone reading the page think of it.
import { degrees, PDFDocument, rgb, StandardFonts, type PDFPage } from '@cantoo/pdf-lib';

export interface PdfImageMark {
  type: 'image';
  /** The page, from 0. */
  page: number;
  /** The picture's top left corner and its size, in points. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** A PNG or JPEG picture as a data: address. */
  src: string;
}

export interface PdfTextMark {
  type: 'text';
  page: number;
  /** The text's left edge and the top of its line, in points. */
  x: number;
  y: number;
  /** One line. */
  text: string;
  /** In points. */
  size: number;
}

export type PdfMark = PdfImageMark | PdfTextMark;

/** The height of a line of text as the editor shows it (CSS line-height), in font sizes. */
export const TEXT_LINE_HEIGHT = 1.2;
/** Where the baseline is in that line, from its top, in font sizes: Helvetica's (and Arial's) ascent and half the leading. */
export const TEXT_BASELINE = 0.946;
/** Helvetica in the PDF; Arial has the same metrics, so the editor shows what is written. */
export const TEXT_FONT_CSS = 'Helvetica, Arial, sans-serif';

/** Characters the PDF's standard fonts cannot write (WinAnsi), replaced so a typed name never fails a save. */
function writable(text: string): string {
  return text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[^ -~ -ÿ–—•…€]/g, '?');
}

/** A point on the page as shown (from its top left, after rotation) in the page's own coordinates. */
function toPdf(page: PDFPage, dx: number, dy: number): { x: number; y: number } {
  const box = page.getCropBox();
  switch (rotationOf(page)) {
    case 90:
      return { x: box.x + dy, y: box.y + dx };
    case 180:
      return { x: box.x + box.width - dx, y: box.y + dy };
    case 270:
      return { x: box.x + box.width - dy, y: box.y + box.height - dx };
    default:
      return { x: box.x + dx, y: box.y + box.height - dy };
  }
}

function rotationOf(page: PDFPage): 0 | 90 | 180 | 270 {
  return ((((page.getRotation().angle % 360) + 360) % 360) as 0 | 90 | 180 | 270);
}

/** The page's size as it is shown, in points. */
export function shownSize(page: PDFPage): { width: number; height: number } {
  const box = page.getCropBox();
  return rotationOf(page) % 180 ? { width: box.height, height: box.width } : { width: box.width, height: box.height };
}

/** Open a PDF for writing. One locked only against changes (an owner password) opens; one that needs a password to read does not. */
export async function loadPdf(bytes: Uint8Array | ArrayBuffer): Promise<PDFDocument> {
  try {
    return await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (e) {
    if (!/encrypt/i.test(String((e as Error)?.message))) throw e;
    try {
      return await PDFDocument.load(bytes, { password: '', updateMetadata: false });
    } catch {
      throw new Error('This PDF is locked with a password, so it cannot be signed here.');
    }
  }
}

/** The PDF with the marks written on its pages. */
export async function signPdf(bytes: Uint8Array | ArrayBuffer, marks: PdfMark[]): Promise<Uint8Array> {
  const doc = await loadPdf(bytes);
  const pages = doc.getPages();
  const font = marks.some((m) => m.type === 'text') ? await doc.embedFont(StandardFonts.Helvetica) : null;
  const images = new Map<string, Awaited<ReturnType<PDFDocument['embedPng']>>>();
  for (const mark of marks) {
    const page = pages[mark.page];
    if (!page) throw new Error(`The PDF has no page ${mark.page + 1}.`);
    const rotate = degrees(rotationOf(page));
    if (mark.type === 'image') {
      let image = images.get(mark.src);
      if (!image) {
        const m = /^data:image\/(png|jpeg);base64,(.*)$/s.exec(mark.src);
        if (!m) throw new Error('A signature must be a PNG or JPEG picture.');
        const data = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
        image = m[1] === 'png' ? await doc.embedPng(data) : await doc.embedJpg(data);
        images.set(mark.src, image);
      }
      // Pictures are drawn from their bottom left corner, turned with the page so they show upright.
      page.drawImage(image, { ...toPdf(page, mark.x, mark.y + mark.height), width: mark.width, height: mark.height, rotate });
    } else {
      const text = writable(mark.text);
      if (!text.trim()) continue;
      page.drawText(text, { ...toPdf(page, mark.x, mark.y + mark.size * TEXT_BASELINE), size: mark.size, font: font!, color: rgb(0, 0, 0), rotate });
    }
  }
  return doc.save({ useObjectStreams: false });
}
