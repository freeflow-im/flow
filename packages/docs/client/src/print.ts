// Download as PDF (docs/web-and-pdf.md). The server makes the PDF with a headless browser that opens the file's
// page with `?print=pdf` (server/pdf.ts): the page lays itself out as Print does, without asking to print, and
// says when it is drawn by setting `window.__printReady`.
import { ApiError } from './api.ts';

/** This page is being made into a PDF by the server. */
export function printingPdf(): boolean {
  return typeof location !== 'undefined' && new URLSearchParams(location.search).get('print') === 'pdf';
}

/** What still has to arrive before a page is drawn: diagrams being drawn, a page loading, anything marked. */
const PENDING = '.md-mermaid-wait, .page-loading, [data-print-pending]';

const frame = () => new Promise<void>((resolve) => {
  // A hidden window may not draw frames; don't wait on one for long.
  const t = setTimeout(resolve, 100);
  requestAnimationFrame(() => {
    clearTimeout(t);
    resolve();
  });
});

/** Say the page is drawn, once its fonts, pictures and diagrams are in (or after `timeoutMs`, as it is then). */
export async function signalPrintReady(timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  // Pictures out of view would wait to load until scrolled to, which a printed page never is.
  document.querySelectorAll<HTMLImageElement>('img[loading="lazy"]').forEach((img) => (img.loading = 'eager'));
  while (Date.now() < deadline) {
    await document.fonts.ready;
    const waiting =
      document.querySelector(PENDING) ||
      [...document.images].some((img) => !img.complete) ||
      [...document.querySelectorAll('video')].some((v) => v.readyState < 2 && !v.error && v.preload !== 'none');
    if (!waiting) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await frame();
  await frame();
  (window as { __printReady?: boolean }).__printReady = true;
}

/** Fetch the PDF of a file (a document, presentation, Markdown file or stored web page) and save it. */
export async function downloadPdf(id: string): Promise<void> {
  const res = await fetch(`/api/files/${encodeURIComponent(id)}/export?format=pdf&locale=${encodeURIComponent(navigator.language)}`, { credentials: 'same-origin' });
  if (!res.ok) {
    const { error } = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(res.status, error ?? `The PDF could not be made (${res.status}).`);
  }
  const name = /filename\*=UTF-8''([^;]+)/.exec(res.headers.get('content-disposition') ?? '')?.[1];
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = name ? decodeURIComponent(name) : 'document.pdf';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
