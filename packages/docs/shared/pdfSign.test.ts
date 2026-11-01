import { describe, expect, it } from 'vitest';
import { degrees, PDFDict, PDFDocument, PDFName } from '@cantoo/pdf-lib';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { signPdf, TEXT_BASELINE } from './pdfSign.ts';

// A 1×1 black PNG.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

async function blankPdf(rotate = 0): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([600, 800]);
  if (rotate) page.setRotation(degrees(rotate));
  return doc.save();
}

/** The text on the first page with where pdf.js shows it: left and baseline, from the top left of the page as shown. */
async function shownText(bytes: Uint8Array): Promise<{ text: string; x: number; y: number }[]> {
  const pdf = await getDocument({ data: bytes, useSystemFonts: false }).promise;
  const page = await pdf.getPage(1);
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const items = content.items.flatMap((i) => ('str' in i && i.str ? [i] : []));
  return items.map((i) => {
    const [x, y] = viewport.convertToViewportPoint(i.transform[4], i.transform[5]);
    return { text: i.str, x: Math.round(x), y: Math.round(y) };
  });
}

describe('signPdf', () => {
  it('writes text where the editor showed it', async () => {
    const out = await signPdf(await blankPdf(), [{ type: 'text', page: 0, x: 100, y: 200, text: 'Scott Persinger', size: 12 }]);
    expect(await shownText(out)).toEqual([{ text: 'Scott Persinger', x: 100, y: Math.round(200 + 12 * TEXT_BASELINE) }]);
  });

  it('keeps text upright and in place on a rotated page', async () => {
    for (const rotate of [90, 180, 270]) {
      const out = await signPdf(await blankPdf(rotate), [{ type: 'text', page: 0, x: 50, y: 60, text: 'Oct 19, 2026', size: 10 }]);
      expect(await shownText(out)).toEqual([{ text: 'Oct 19, 2026', x: 50, y: Math.round(60 + 10 * TEXT_BASELINE) }]);
    }
  });

  it('draws a signature picture and leaves the pages as they were', async () => {
    const out = await signPdf(await blankPdf(), [
      { type: 'image', page: 0, x: 10, y: 20, width: 150, height: 50, src: PNG },
      { type: 'image', page: 0, x: 10, y: 300, width: 150, height: 50, src: PNG },
    ]);
    const doc = await PDFDocument.load(out);
    expect(doc.getPageCount()).toBe(1);
    expect(doc.getPage(0).getSize()).toEqual({ width: 600, height: 800 });
    // One picture, drawn twice.
    const xobjects = doc.getPage(0).node.Resources()!.lookup(PDFName.of('XObject'), PDFDict);
    expect(new Set(xobjects.values().map(String)).size).toBe(1);
  });

  it('refuses a mark on a page the PDF does not have', async () => {
    await expect(signPdf(await blankPdf(), [{ type: 'text', page: 3, x: 0, y: 0, text: 'x', size: 12 }])).rejects.toThrow(/no page 4/);
  });

  it('writes characters the standard font lacks as question marks rather than failing', async () => {
    const out = await signPdf(await blankPdf(), [{ type: 'text', page: 0, x: 10, y: 10, text: 'José — 東京', size: 12 }]);
    expect((await shownText(out)).map((t) => t.text).join('')).toBe('José — ??');
  });
});
