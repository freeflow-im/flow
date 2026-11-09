// What a PDF read as Markdown is, shared by server/pdfMarkdown.ts and the two readers behind `#runtime/pdf` (LiteParse on
// Node, pdf.js and the OCR container on Workers), which import it without importing each other.

/** The largest PDF that is read or imported. */
export const MAX_PDF_BYTES = 50 * 1024 * 1024;
/** Pages read from one PDF; the rest are left out, with a warning. */
export const MAX_PAGES = 1000;

export const isPdf = (buf: Buffer): boolean => buf.subarray(0, 1024).includes('%PDF-');

/** A PDF that cannot be read, with what to tell the user. */
export class PdfError extends Error {}

export interface PdfMarkdown {
  markdown: string;
  /** Pages in the PDF. */
  pageCount: number;
  /** Pages read with OCR (1-based): their text may have mistakes. */
  ocrPages: number[];
  warnings: string[];
  /** Why OCR of the scanned pages could not be done, when it could not: 'none' where there is no OCR, else why ("it is busy"). */
  ocrUnavailable?: string;
}

/** Pages one after another. A paragraph cut by a page break is put back together. */
export function joinPages(pages: string[]): string {
  let out = '';
  for (const page of pages.map((p) => p.trim()).filter(Boolean)) {
    const continues = out && /[\p{L},]$/u.test(out) && !/\n(#|\||[-*+] |\d+[.)] )[^\n]*$/.test(`\n${out.slice(out.lastIndexOf('\n') + 1)}`) && /^\p{Ll}/u.test(page);
    out = out ? `${out}${continues ? ' ' : '\n\n'}${page}` : page;
  }
  return out;
}
