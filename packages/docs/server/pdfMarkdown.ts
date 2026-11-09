// PDF -> Markdown: the reader is the runtime's (`#runtime/pdf`: LiteParse with Tesseract OCR on Node, pdf.js with the OCR
// container on Workers); this module keeps the last few conversions and makes the Markdown file beside a stored PDF.
import { createHash } from 'node:crypto';
import { readFile } from '#runtime/fsp';
import { closePdfReaders, convertPdf } from '#runtime/pdf';
import type { FileStore } from './files.ts';
import type { SheetStore } from './sheets.ts';
import { scopeOfMeta, type ViewerArg } from './scope.ts';
import { newMarkdownDoc } from '../shared/markdown.ts';
import type { SheetMeta, StoredFile } from '../shared/types.ts';
import { PdfError, type PdfMarkdown } from './pdfMarkdownTypes.ts';

export { isPdf, joinPages, MAX_PDF_BYTES, PdfError, type PdfMarkdown } from './pdfMarkdownTypes.ts';
/** Stop the reading processes (the server is stopping); the next PDF starts them again. */
export { closePdfReaders };

// The last few conversions, by content: reading a long PDF in parts converts it once.
const recent = new Map<string, Promise<PdfMarkdown>>();
const RECENT = 4;

/** The PDF's text as Markdown. Throws PdfError for a file that is not a PDF, is locked, or cannot be read. */
export function pdfToMarkdown(bytes: Buffer): Promise<PdfMarkdown> {
  const key = createHash('sha256').update(bytes).digest('hex');
  let made = recent.get(key);
  if (!made) {
    made = convertPdf(bytes);
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
