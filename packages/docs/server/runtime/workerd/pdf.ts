// PDF -> Markdown on Workers. LiteParse and Tesseract do not load here (cloudflare-spikes.md), so pdf.js reads the text
// and pdfText.ts lays it out as Markdown (headings, lists, links), leaving out running headers and footers. The pages
// where pdf.js finds no text (scans) go to the PdfOcr container (pdfOcr.ts), which reads them with LiteParse and
// Tesseract; when it cannot be reached, the user is told. Pictures in the PDF are left out.
import { PdfReadError, readPdfText } from './pdfText.ts';
import { MAX_OCR_PAGES, OcrUnavailable, ocrPages as readWithOcr, PdfOcrError } from './pdfOcr.ts';
import { isPdf, joinPages, MAX_PAGES, MAX_PDF_BYTES, PdfError, type PdfMarkdown } from '../../pdfMarkdownTypes.ts';

/** Time spent reading one PDF's pages; the rest are left out, with a warning (a request has 30 s of CPU). */
const TEXT_TIME_MS = 20_000;

/** Nothing to stop: pdf.js runs in this thread and keeps nothing between PDFs. Kept for its callers. */
export async function closePdfReaders(): Promise<void> {}

/** The PDF's text as Markdown, read once; the cache is server/pdfMarkdown.ts'. */
export async function convertPdf(bytes: Buffer): Promise<PdfMarkdown> {
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
