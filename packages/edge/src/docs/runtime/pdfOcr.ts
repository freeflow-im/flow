// OCR of scanned pages, in the PdfOcr container (src/pdfOcr.ts, containers/pdf-ocr/server.mjs). pdf.js reads a PDF's
// text in the Worker (pdfText.ts); the pages where it finds none are sent here.
/** Set by the Docs object from its environment: the PDF_OCR Durable Object namespace, or null where there is none. */
let binding: DurableObjectNamespace | null = null;
export const setOcrBinding = (b: DurableObjectNamespace | null) => { binding = b; };

/** Instances the requests are spread over (wrangler.toml's max_instances); each reads one PDF at a time. */
export const OCR_INSTANCES = 3;
/** Pages read with OCR from one PDF, as on Node (packages/docs/server/pdfMarkdown.ts). */
export const MAX_OCR_PAGES = 50;
/** Time for one PDF's OCR, including a cold start (the container's own deadline is 150 s). */
const OCR_TIMEOUT_MS = 170_000;

/** OCR could not be done: no container here, it did not start, was busy, or took too long. `message` says which, as
 * the end of a sentence about the OCR service ("it is busy"). */
export class OcrUnavailable extends Error {}

export interface OcrResult {
  /** The pages that OCR found text on, with that text as Markdown. */
  pages: { page: number; markdown: string }[];
  warnings: string[];
}

/** The given pages (1-based) of the PDF read with OCR. Throws OcrUnavailable, or PdfOcrError for a PDF it refused. */
export async function ocrPages(bytes: Uint8Array, pages: number[], opts: { timeoutMs?: number } = {}): Promise<OcrResult> {
  if (!binding) throw new OcrUnavailable('OCR is not available here');
  // A random instance of a few, like @cloudflare/containers' getRandom: no state is kept between PDFs.
  const stub = binding.get(binding.idFromName(`pdf-ocr-${Math.floor(Math.random() * OCR_INSTANCES)}`));
  const timeoutMs = opts.timeoutMs ?? OCR_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new OcrUnavailable('it took too long')), timeoutMs); });
  let res: Response;
  try {
    const req = new Request(`http://pdf-ocr/ocr?pages=${pages.join(',')}`, { method: 'POST', body: bytes as Uint8Array<ArrayBuffer>, headers: { 'content-type': 'application/pdf' } });
    res = await Promise.race([stub.fetch(req), late]);
    const text = await Promise.race([res.text(), late]);
    let body: { pages?: OcrResult['pages']; warnings?: string[]; error?: string } | null = null;
    try { body = JSON.parse(text); } catch { /* the Container class's own answer, in plain text */ }
    if (res.ok && body?.pages) return { pages: body.pages, warnings: body.warnings ?? [] };
    // The server's own refusals (a locked or damaged PDF) say so in `error`; anything else is the container not being there.
    if ((res.status === 400 || res.status === 413) && body?.error) throw new PdfOcrError(body.error);
    console.error(`pdf-ocr: ${res.status} ${text.slice(0, 300)}`);
    throw new OcrUnavailable(res.status === 504 ? 'it took too long' : res.status === 503 || res.status === 429 ? 'it is busy' : 'it could not be started');
  } catch (e) {
    if (e instanceof OcrUnavailable || e instanceof PdfOcrError) throw e;
    console.error('pdf-ocr:', e);
    throw new OcrUnavailable('it could not be reached');
  } finally {
    clearTimeout(timer);
  }
}

/** The container read the PDF and refused it (password, damaged). */
export class PdfOcrError extends Error {}
