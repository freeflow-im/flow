// PDF -> Markdown on Node, with LiteParse (github.com/run-llama/liteparse): PDFium reads the text with its fonts and
// positions, and LiteParse lays it out as Markdown (headings, lists, tables, links), leaving out running headers
// and footers. A page that is a picture of text (a scan) is read with Tesseract OCR, in a second pass over only
// those pages. Parsing runs in worker processes with a deadline, so a damaged or hostile PDF can neither hang nor
// crash the server. Pictures in the PDF are left out.
import type { LiteParse, LiteParseConfig, ParsedPage, PoolOptions } from '@llamaindex/liteparse';
import { isPdf, joinPages, MAX_PAGES, MAX_PDF_BYTES, PdfError, type PdfMarkdown } from '../../pdfMarkdownTypes.ts';

/** Pages read with OCR from one PDF (each takes a second or two). */
const MAX_OCR_PAGES = 50;
const TEXT_TIMEOUT_MS = 60_000;
const OCR_TIMEOUT_MS = 180_000;

const COMMON: Partial<LiteParseConfig> = { outputFormat: 'markdown', imageMode: 'off', maxPages: MAX_PAGES, continueOnPageError: true, quiet: true };

// Loaded when first needed: the native module is large, and a server that never reads a PDF does not need it.
let textParser: Promise<LiteParse> | null = null;
const newParser = async (config: Partial<LiteParseConfig> & PoolOptions): Promise<LiteParse> => new (await import('@llamaindex/liteparse')).LiteParse({ ...COMMON, ...config });

/** Stop the reading processes (the server is stopping); the next PDF starts them again. */
export async function closePdfReaders(): Promise<void> {
  const parser = textParser;
  textParser = null;
  const p = parser && (await parser.catch(() => null));
  // A worker still starting is not stopped by close.
  await p?.warmUp().catch(() => {});
  p?.close();
}

/** Letters and digits on a page, not counting the empty code block a page with no text is given. */
const textLength = (markdown: string) => (markdown.replace(/^```.*$/gm, '').match(/[\p{L}\p{N}]/gu) ?? []).length;

async function parse(parser: LiteParse, bytes: Buffer): Promise<{ pages: ParsedPage[]; totalPages: number }> {
  try {
    return await parser.parse(bytes);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (/password/i.test(message)) throw new PdfError('This PDF is password-protected, so it cannot be read.');
    if (e instanceof Error && e.name === 'ParseTimeoutError') throw new PdfError('This PDF took too long to read.', { cause: e });
    throw new PdfError('This PDF could not be read. It may be damaged.', { cause: e });
  }
}

/** The PDF's text as Markdown, read once; the cache is server/pdfMarkdown.ts'. */
export async function convertPdf(bytes: Buffer): Promise<PdfMarkdown> {
  if (!isPdf(bytes)) throw new PdfError('This file is not a valid PDF.');
  if (bytes.length > MAX_PDF_BYTES) throw new PdfError(`This PDF is too large to read (${MAX_PDF_BYTES / 1024 / 1024} MB maximum).`);
  textParser ??= newParser({ ocrEnabled: false, includeComplexity: true, poolSize: 1, parseTimeoutMs: TEXT_TIMEOUT_MS });
  const first = await parse(await textParser, bytes);
  const text = new Map(first.pages.map((p) => [p.pageNum, p.markdown]));
  const warnings: string[] = [];
  if (first.totalPages > first.pages.length) warnings.push(`Only the first ${first.pages.length} of ${first.totalPages} pages were read.`);

  // Pages with (almost) no text that look like pictures of it.
  const scans = first.pages.filter((p) => textLength(p.markdown) < 20 && (p.complexity?.needsOcr ?? true)).map((p) => p.pageNum);
  const ocrPages: number[] = [];
  if (scans.length) {
    const reading = scans.slice(0, MAX_OCR_PAGES);
    if (scans.length > reading.length) warnings.push(`Only ${reading.length} of the ${scans.length} scanned pages were read with OCR.`);
    const ocr = await newParser({ ocrEnabled: true, targetPages: reading.join(','), poolSize: 1, parseTimeoutMs: OCR_TIMEOUT_MS });
    try {
      for (const p of (await parse(ocr, bytes)).pages) {
        if (textLength(p.markdown) <= textLength(text.get(p.pageNum) ?? '')) continue;
        text.set(p.pageNum, p.markdown);
        ocrPages.push(p.pageNum);
      }
    } catch (e) {
      if (!(e instanceof PdfError)) throw e;
      // Tesseract's language model is fetched on first use (into $TESSDATA_PREFIX, or a per-user cache);
      // without it no scan can be read, which is worth saying plainly rather than as a damaged file.
      const cause = e.cause instanceof Error ? e.cause.message : '';
      if (/tessdata|traineddata/i.test(cause)) warnings.push(`${reading.length === 1 ? 'Page' : 'Pages'} ${reading.join(', ')} ${reading.length === 1 ? 'is a scan and' : 'are scans and'} could not be read: the OCR model is unavailable.`);
      else warnings.push('The scanned pages could not be read with OCR.');
    } finally {
      ocr.close();
    }
  }
  const pages = [...text.entries()].sort((a, b) => a[0] - b[0]).map(([, md]) => (textLength(md) ? md : ''));
  if (ocrPages.length) warnings.push(`${ocrPages.length === 1 ? 'Page' : 'Pages'} ${ocrPages.join(', ')} ${ocrPages.length === 1 ? 'is a scan and was' : 'are scans and were'} read with OCR, which can get words wrong.`);
  return { markdown: joinPages(pages), pageCount: first.totalPages, ocrPages, warnings };
}
