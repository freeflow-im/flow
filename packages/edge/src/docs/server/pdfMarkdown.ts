// @ts-nocheck: copied from packages/docs, where it is typechecked under that package's settings (cloudflare-spikes.md).
// PDF -> Markdown. On Node (packages/docs) this is LiteParse, with Tesseract OCR for scanned pages; neither loads on
// Workers (cloudflare-spikes.md), so here pdf.js reads the text and runtime/pdfText.ts lays it out as Markdown (headings,
// lists, links), leaving out running headers and footers. The pages where pdf.js finds no text (scans) go to the PdfOcr
// container (runtime/pdfOcr.ts), which reads them with LiteParse and Tesseract; when it cannot be reached, the user is
// told. Pictures in the PDF are left out.
import { createHash } from 'node:crypto';
import { readFile } from '../runtime/fsp.ts';
import { PdfReadError, readPdfText } from '../runtime/pdfText.ts';
import { MAX_OCR_PAGES, OcrUnavailable, ocrPages as readWithOcr, PdfOcrError } from '../runtime/pdfOcr.ts';
import type { FileStore } from './files.ts';
import type { SheetStore } from './sheets.ts';
import { scopeOfMeta, type ViewerArg } from './scope.ts';
import { newMarkdownDoc } from '../shared/markdown.ts';
import type { SheetMeta, StoredFile } from '../shared/types.ts';

/** The largest PDF that is read or imported. */
export const MAX_PDF_BYTES = 50 * 1024 * 1024;
/** Pages read from one PDF; the rest are left out, with a warning. */
const MAX_PAGES = 1000;
/** Time spent reading one PDF's pages; the rest are left out, with a warning (a request has 30 s of CPU). */
const TEXT_TIME_MS = 20_000;

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

/** Nothing to stop: pdf.js runs in this thread and keeps nothing between PDFs. Kept for its callers. */
export async function closePdfReaders(): Promise<void> {}

/** Pages one after another. A paragraph cut by a page break is put back together. */
export function joinPages(pages: string[]): string {
  let out = '';
  for (const page of pages.map((p) => p.trim()).filter(Boolean)) {
    const continues = out && /[\p{L},]$/u.test(out) && !/\n(#|\||[-*+] |\d+[.)] )[^\n]*$/.test(`\n${out.slice(out.lastIndexOf('\n') + 1)}`) && /^\p{Ll}/u.test(page);
    out = out ? `${out}${continues ? ' ' : '\n\n'}${page}` : page;
  }
  return out;
}

async function convert(bytes: Buffer): Promise<PdfMarkdown> {
  if (!isPdf(bytes)) throw new PdfError('This file is not a valid PDF.');
  if (bytes.length > MAX_PDF_BYTES) throw new PdfError(`This PDF is too large to read (${MAX_PDF_BYTES / 1024 / 1024} MB maximum).`);
  let read;
  try {
    read = await readPdfText(bytes, { maxPages: MAX_PAGES, deadline: Date.now() + TEXT_TIME_MS });
  } catch (e) {
    if (e instanceof PdfReadError && e.reason === 'password') throw new PdfError('This PDF is password-protected, so it cannot be read.');
    if (e instanceof PdfReadError) throw new PdfError('This PDF could not be read. It may be damaged.');
    throw e;
  }
  const warnings: string[] = [];
  if (read.totalPages > read.pages.length) warnings.push(`Only the first ${read.pages.length} of ${read.totalPages} pages were read.`);
  // Pages with no text: scans, read with OCR in the container. pdf.js stays the fast path for everything else.
  const pages = [...read.pages];
  const empty = read.emptyPages;
  const ocrPages: number[] = [];
  let ocrUnavailable: string | undefined;
  if (empty.length) {
    const reading = empty.slice(0, MAX_OCR_PAGES);
    if (empty.length > reading.length) warnings.push(`Only ${reading.length} of the ${empty.length} pages with no text were read with OCR.`);
    try {
      const ocr = await readWithOcr(bytes, reading);
      for (const p of ocr.pages) {
        if (!reading.includes(p.page) || !/[\p{L}\p{N}]/u.test(p.markdown)) continue;
        pages[p.page - 1] = p.markdown;
        ocrPages.push(p.page);
      }
      warnings.push(...ocr.warnings);
    } catch (e) {
      if (e instanceof OcrUnavailable) ocrUnavailable = e.message === 'OCR is not available here' ? 'none' : e.message;
      else if (e instanceof PdfOcrError) warnings.push(`The pages with no text could not be read with OCR: ${e.message}`);
      else throw e;
    }
    const left = empty.filter((p) => !ocrPages.includes(p));
    if (left.length && left.length < read.pages.length) {
      const why = ocrUnavailable === 'none' ? ' A scanned page needs OCR, which is not available here.' : ocrUnavailable ? ` If ${left.length === 1 ? 'it is a scan' : 'they are scans'}, the OCR service could not read ${left.length === 1 ? 'it' : 'them'} just now: ${ocrUnavailable}. Try again in a minute.` : '';
      warnings.push(`${left.length === 1 ? 'Page' : 'Pages'} ${left.join(', ')} ${left.length === 1 ? 'has' : 'have'} no text that can be read, so ${left.length === 1 ? 'it was' : 'they were'} left out.${why}`);
    }
  }
  ocrPages.sort((a, b) => a - b);
  return { markdown: joinPages(pages), pageCount: read.totalPages, ocrPages, warnings, ...(ocrUnavailable ? { ocrUnavailable } : {}) };
}

// The last few conversions, by content: reading a long PDF in parts converts it once.
const recent = new Map<string, Promise<PdfMarkdown>>();
const RECENT = 4;

/** The PDF's text as Markdown. Throws PdfError for a file that is not a PDF, is locked, or cannot be read. */
export function pdfToMarkdown(bytes: Buffer): Promise<PdfMarkdown> {
  const key = createHash('sha256').update(bytes).digest('hex');
  let made = recent.get(key);
  if (!made) {
    made = convert(bytes);
    // A failure is not kept, and neither is a result OCR could not finish: the next try may reach it.
    made.then((m) => { if (m.ocrUnavailable && recent.get(key) === made) recent.delete(key); }, () => recent.delete(key));
    recent.set(key, made);
    if (recent.size > RECENT) recent.delete(recent.keys().next().value!);
  }
  return made;
}

/**
 * A Markdown file of a stored PDF's text, made beside it: in the same folder, named after it. Null when the
 * user has no such file; PdfError when it is not a PDF or has no text that can be read.
 */
export async function pdfToMarkdownFile(stores: { sheets: SheetStore; files: FileStore }, userId: ViewerArg, fileId: string): Promise<{ sheet: SheetMeta; pdf: StoredFile; pageCount: number; ocrPages: number[]; warnings: string[] } | null> {
  const f = stores.files.get(userId, fileId);
  if (!f) return null;
  if (f.meta.type !== 'application/pdf') throw new PdfError(`${f.meta.filename} is not a PDF.`);
  const made = await pdfToMarkdown(await readFile(f.file));
  if (!made.markdown.trim()) {
    const why = !made.ocrUnavailable ? '' : made.ocrUnavailable === 'none' ? ' If it is a scan, it needs OCR, which is not available here.' : ` If it is a scan, the OCR service could not read it just now: ${made.ocrUnavailable}. Try again in a minute.`;
    throw new PdfError(`No text could be read from ${f.meta.filename}.${why}`);
  }
  const title = f.meta.filename.replace(/\.pdf$/i, '') || 'Document';
  // Beside it: in its folder and its root (server/scope.ts).
  const sheet = await stores.sheets.createMarkdown(scopeOfMeta(f.meta, userId), title, newMarkdownDoc(`${made.markdown}\n`), f.meta.folder ?? '');
  return { sheet, pdf: f.meta, pageCount: made.pageCount, ocrPages: made.ocrPages, warnings: made.warnings };
}
