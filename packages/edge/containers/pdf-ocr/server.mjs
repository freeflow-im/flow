// The Worker's OCR for scanned PDFs (packages/edge/src/pdfOcr.ts starts it; src/docs/runtime/pdfOcr.ts calls it). It runs
// the conversion of packages/docs/server/pdfMarkdown.ts: LiteParse, with Tesseract for pages that are pictures of text.
//
//   GET  /ping                 200 once it listens (the Container class's start check).
//   POST /ocr?pages=1,3        The PDF as the body. Reads the listed pages (1-based) with OCR; without `pages`, the whole
//                              PDF the way the Node server does: its text, and OCR for the pages that are scans.
//                              200 { markdown, pages: [{ page, markdown }], pageCount, ocrPages, warnings }
//                              400 { error } a PDF that cannot be read, 413 too large, 503 busy, 504 too slow.
//
// One PDF at a time, in a LiteParse worker process with a deadline, so a hostile PDF can neither hang nor crash the server.
import http from 'node:http';
import { LiteParse } from '@llamaindex/liteparse';

const PORT = Number(process.env.PORT ?? 8080);
/** The Worker's own limit (src/docs/server/pdfMarkdown.ts). */
const MAX_PDF_BYTES = 50 * 1024 * 1024;
const MAX_PAGES = 1000;
/** Pages read with OCR from one PDF (each takes a second or two on a full vCPU). */
const MAX_OCR_PAGES = 50;
const TEXT_TIMEOUT_MS = 60_000;
const OCR_TIMEOUT_MS = Number(process.env.OCR_TIMEOUT_MS ?? 150_000);
/** PDFs waiting behind the one being read; more than this is a 503, and the Worker tries again later. */
const MAX_WAITING = 4;
const TESSDATA = process.env.TESSDATA_PREFIX ?? '/app/tessdata';

const COMMON = { outputFormat: 'markdown', imageMode: 'off', maxPages: MAX_PAGES, continueOnPageError: true, quiet: true, ocrLanguage: 'eng', tessdataPath: TESSDATA };

class PdfError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/** Letters and digits on a page, not counting the empty code block a page with no text is given. */
const textLength = (markdown) => (markdown.replace(/^```.*$/gm, '').match(/[\p{L}\p{N}]/gu) ?? []).length;

/** Pages one after another. A paragraph cut by a page break is put back together (as pdfMarkdown.ts does). */
function joinPages(pages) {
  let out = '';
  for (const page of pages.map((p) => p.trim()).filter(Boolean)) {
    const continues = out && /[\p{L},]$/u.test(out) && !/\n(#|\||[-*+] |\d+[.)] )[^\n]*$/.test(`\n${out.slice(out.lastIndexOf('\n') + 1)}`) && /^\p{Ll}/u.test(page);
    out = out ? `${out}${continues ? ' ' : '\n\n'}${page}` : page;
  }
  return out;
}

async function parse(config, bytes) {
  const parser = new LiteParse({ ...COMMON, ...config, poolSize: 1 });
  try {
    return await parser.parse(bytes);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (/password/i.test(message)) throw new PdfError('This PDF is password-protected, so it cannot be read.');
    if (e instanceof Error && e.name === 'ParseTimeoutError') throw new PdfError('This PDF took too long to read.', 504);
    throw new PdfError('This PDF could not be read. It may be damaged.');
  } finally {
    parser.close();
  }
}

/** OCR of the given pages; with none given, the whole conversion: text first, then OCR of the pages that are scans. */
async function convert(bytes, wanted) {
  const warnings = [];
  const text = new Map();
  let pageCount = 0;
  let scans = wanted;
  if (!scans) {
    const first = await parse({ ocrEnabled: false, includeComplexity: true, parseTimeoutMs: TEXT_TIMEOUT_MS }, bytes);
    pageCount = first.totalPages;
    for (const p of first.pages) text.set(p.pageNum, p.markdown);
    if (first.totalPages > first.pages.length) warnings.push(`Only the first ${first.pages.length} of ${first.totalPages} pages were read.`);
    scans = first.pages.filter((p) => textLength(p.markdown) < 20 && (p.complexity?.needsOcr ?? true)).map((p) => p.pageNum);
  }
  const reading = scans.slice(0, MAX_OCR_PAGES);
  if (scans.length > reading.length) warnings.push(`Only ${reading.length} of the ${scans.length} scanned pages were read with OCR.`);
  const ocrPages = [];
  if (reading.length) {
    const ocr = await parse({ ocrEnabled: true, targetPages: reading.join(','), parseTimeoutMs: OCR_TIMEOUT_MS }, bytes);
    pageCount ||= ocr.totalPages;
    for (const p of ocr.pages) {
      if (!reading.includes(p.pageNum) || textLength(p.markdown) <= textLength(text.get(p.pageNum) ?? '')) continue;
      text.set(p.pageNum, p.markdown);
      ocrPages.push(p.pageNum);
    }
  }
  if (ocrPages.length) warnings.push(`${ocrPages.length === 1 ? 'Page' : 'Pages'} ${ocrPages.join(', ')} ${ocrPages.length === 1 ? 'is a scan and was' : 'are scans and were'} read with OCR, which can get words wrong.`);
  const pages = [...text.entries()].sort((a, b) => a[0] - b[0]).map(([page, md]) => ({ page, markdown: textLength(md) ? md.trim() : '' }));
  return { markdown: joinPages(pages.map((p) => p.markdown)), pages: wanted ? pages.filter((p) => ocrPages.includes(p.page)) : pages, pageCount, ocrPages, warnings };
}

/** `1,3,5` as page numbers; null for none given. */
function pagesOf(value) {
  if (value == null || value === '') return null;
  const pages = value.split(',').map((s) => Number(s.trim()));
  if (pages.some((n) => !Number.isInteger(n) || n < 1 || n > MAX_PAGES)) throw new PdfError('`pages` is a list of page numbers, like 1,3,5.');
  return [...new Set(pages)].sort((a, b) => a - b);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] ?? 0);
    if (declared > MAX_PDF_BYTES) return reject(new PdfError(`This PDF is too large to read (${MAX_PDF_BYTES / 1024 / 1024} MB maximum).`, 413));
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_PDF_BYTES) {
        reject(new PdfError(`This PDF is too large to read (${MAX_PDF_BYTES / 1024 / 1024} MB maximum).`, 413));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

let queue = Promise.resolve();
let waiting = 0;
/** One PDF at a time: OCR takes the whole CPU, and LiteParse's pool here is one process. */
function oneAtATime(fn) {
  if (waiting > MAX_WAITING) throw new PdfError('Busy reading other PDFs; try again shortly.', 503);
  waiting++;
  const run = queue.then(fn, fn);
  queue = run.catch(() => {}).finally(() => { waiting--; });
  return run;
}

const send = (res, status, body) => {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(json) });
  res.end(json);
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://container');
  try {
    if (req.method === 'GET' && (url.pathname === '/ping' || url.pathname === '/')) return send(res, 200, { ok: true });
    if (req.method !== 'POST' || url.pathname !== '/ocr') return send(res, 404, { error: 'Not found.' });
    const wanted = pagesOf(url.searchParams.get('pages'));
    const bytes = await readBody(req);
    if (!bytes.subarray(0, 1024).includes('%PDF-')) throw new PdfError('This file is not a valid PDF.');
    const started = Date.now();
    const made = await oneAtATime(() => convert(bytes, wanted));
    console.log(JSON.stringify({ event: 'ocr', bytes: bytes.length, pages: made.pageCount, ocrPages: made.ocrPages.length, ms: Date.now() - started }));
    send(res, 200, made);
  } catch (e) {
    if (e instanceof PdfError) return send(res, e.status, { error: e.message });
    console.error(e);
    send(res, 500, { error: 'The PDF could not be read with OCR.' });
  }
});
server.requestTimeout = OCR_TIMEOUT_MS + TEXT_TIMEOUT_MS + 30_000;
server.listen(PORT, () => console.log(`pdf-ocr listening on ${PORT}`));
const stop = () => server.close(() => process.exit(0));
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
