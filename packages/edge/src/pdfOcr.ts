// The Cloudflare Container that reads scanned PDFs: LiteParse with Tesseract (containers/pdf-ocr), which cannot run in
// workerd (cloudflare-spikes.md). Each instance is this Durable Object with a Linux container behind it, started on its
// first request and put to sleep when idle; wrangler.toml's [[containers]] names the image and the instance type. The
// Docs object calls it through src/docs/runtime/pdfOcr.ts. The container's code is not in the Worker's bundle.
import { Container } from '@cloudflare/containers';

export class PdfOcr extends Container {
  defaultPort = 8080;
  /** Kept awake a little after a PDF, for the next part of the same document or the next scan; asleep, it costs nothing. */
  sleepAfter = '1m';
  /** The OCR model is in the image; a PDF being read has no reason to reach anything. */
  enableInternet = false;
}
