// A PDF shown read-only with pdf.js: its pages one under another, each drawn when it comes into view, as wide as the
// view allows. Unlike the browser's own viewer it works where the file is served with a CSP sandbox (a preview's PDF,
// pages/PreviewPage.tsx), and nothing in the PDF runs.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';

async function loadPdfjs() {
  const pdfjs = await import('pdfjs-dist');
  if (!pdfjs.GlobalWorkerOptions.workerSrc) pdfjs.GlobalWorkerOptions.workerSrc = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  return pdfjs;
}

interface PageSize {
  width: number;
  height: number;
}

/** Room around the pages, in pixels. */
const GUTTER = 32;

export function PdfView({ url, title }: { url: string; title: string }) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [pages, setPages] = useState<PageSize[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [width, setWidth] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let stale = false;
    let task: { destroy(): Promise<void> } | null = null;
    (async () => {
      const res = await fetch(url, { credentials: 'same-origin' });
      if (!res.ok) throw new Error(((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? `This PDF could not be loaded (${res.status}).`);
      const data = await res.arrayBuffer();
      const pdfjs = await loadPdfjs();
      if (stale) return;
      // No scripts, forms or links are run: pdf.js only draws the pages.
      const loading = pdfjs.getDocument({ data, enableXfa: false });
      task = loading;
      const pdf = await loading.promise;
      const sizes: PageSize[] = [];
      for (let n = 1; n <= pdf.numPages; n++) {
        const v = (await pdf.getPage(n)).getViewport({ scale: 1 });
        sizes.push({ width: v.width, height: v.height });
      }
      if (stale) return;
      setDoc(pdf);
      setPages(sizes);
    })().catch((e: Error) => !stale && setError(e.message || 'This PDF could not be read.'));
    return () => {
      stale = true;
      void task?.destroy();
    };
  }, [url]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const widest = Math.max(1, ...pages.map((p) => p.width));
  const scale = width ? Math.max(0.2, Math.min(1.5, (width - GUTTER) / widest)) : 1;

  return (
    <div className="pdf-view" ref={scroller} aria-label={title}>
      {error ? (
        <div className="pdf-view-message">{error}</div>
      ) : !doc ? (
        <div className="pdf-view-message">Opening “{title}”…</div>
      ) : (
        pages.map((size, i) => <PdfViewPage key={i} doc={doc} index={i} size={size} scale={scale} />)
      )}
    </div>
  );
}

function PdfViewPage({ doc, index, size, scale }: { doc: PDFDocumentProxy; index: number; size: PageSize; scale: number }) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setVisible(true), { rootMargin: '600px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    const el = canvas.current;
    if (!visible || !el) return;
    let task: RenderTask | null = null;
    let stale = false;
    void doc.getPage(index + 1).then((page) => {
      if (stale) return;
      const ratio = Math.min(3, window.devicePixelRatio || 1);
      const viewport = page.getViewport({ scale: scale * ratio });
      el.width = Math.round(viewport.width);
      el.height = Math.round(viewport.height);
      task = page.render({ canvas: el, viewport });
      task.promise.catch(() => {});
    });
    return () => {
      stale = true;
      task?.cancel();
    };
  }, [doc, index, scale, visible]);

  return (
    <div ref={box} className="pdf-view-page" style={{ width: size.width * scale, height: size.height * scale }} aria-label={`Page ${index + 1}`}>
      <canvas ref={canvas} />
    </div>
  );
}
