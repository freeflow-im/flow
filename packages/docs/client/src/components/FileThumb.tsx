// The picture of a file in the thumbnail view of the file list. Images show themselves, videos a frame,
// PDFs their first page, and documents, spreadsheets and presentations a small rendering of how they
// start (shared/preview.ts). Nothing is fetched until the card scrolls into view.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { SLIDE_H, SLIDE_W } from '../../../shared/deck.ts';
import type { FilePreview } from '../../../shared/preview.ts';
import { videoTypeOf } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { SlideView } from '../deck/SlideView.tsx';
import { kindIcon, type LibraryItem } from './FileLibrary.tsx';

/** True once the element has come near the visible part of the page. */
function useSeen<T extends Element>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setSeen(true), { rootMargin: '300px' });
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);
  return [ref, seen];
}

// Previews already fetched, by file and the time it was last changed.
const previews = new Map<string, Promise<FilePreview>>();
function previewOf(item: LibraryItem): Promise<FilePreview> {
  const key = `${item.id}@${item.updatedAt}`;
  let p = previews.get(key);
  if (!p) {
    p = api.preview(item.id).then((r) => r.preview);
    previews.set(key, p);
    p.catch(() => previews.delete(key));
  }
  return p;
}

/** The first page of a PDF, drawn by pdf.js (loaded only when a PDF needs drawing). */
async function drawPdf(url: string, canvas: HTMLCanvasElement, width: number): Promise<void> {
  const pdfjs = await import('pdfjs-dist');
  if (!pdfjs.GlobalWorkerOptions.workerSrc) pdfjs.GlobalWorkerOptions.workerSrc = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  const task = pdfjs.getDocument({ url, withCredentials: true });
  const doc = await task.promise;
  try {
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: (width * Math.min(2, window.devicePixelRatio || 1)) / base.width });
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    await page.render({ canvas, viewport }).promise;
  } finally {
    void task.destroy();
  }
}

function PdfThumb({ url, fallback }: { url: string; fallback: ReactNode }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<'drawing' | 'done' | 'failed'>('drawing');
  useEffect(() => {
    let stale = false;
    if (ref.current) {
      drawPdf(url, ref.current, 260).then(
        () => !stale && setState('done'),
        () => !stale && setState('failed'),
      );
    }
    return () => {
      stale = true;
    };
  }, [url]);
  if (state === 'failed') return <>{fallback}</>;
  return <canvas ref={ref} className="thumb-page" style={{ visibility: state === 'done' ? 'visible' : 'hidden' }} />;
}

function DocThumb({ item, fallback }: { item: LibraryItem; fallback: ReactNode }) {
  const [preview, setPreview] = useState<FilePreview | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    let stale = false;
    previewOf(item).then(
      (p) => !stale && setPreview(p),
      () => !stale && setPreview({ kind: 'empty' }),
    );
    return () => {
      stale = true;
    };
  }, [item.id, item.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (box.current) setWidth(box.current.clientWidth);
  }, [preview]);
  if (!preview) return null;
  if (preview.kind === 'text') return <div className={`thumb-text${item.kind === 'markdown' ? ' mono' : ''}`}>{preview.text}</div>;
  if (preview.kind === 'grid') {
    return (
      <table className="thumb-grid">
        <tbody>
          {preview.rows.map((row, r) => (
            <tr key={r}>
              {row.map((v, c) => (
                <td key={c}>{v}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  if (preview.kind === 'slide') {
    return (
      <div ref={box} className="thumb-slide" style={{ aspectRatio: `${SLIDE_W} / ${SLIDE_H}` }}>
        {width > 0 && <SlideView slide={preview.slide} theme={preview.theme} scale={width / SLIDE_W} />}
      </div>
    );
  }
  return <>{fallback}</>;
}

/** The thumbnail of one file. */
export function FileThumb({ item }: { item: LibraryItem }) {
  const [ref, seen] = useSeen<HTMLDivElement>();
  const [broken, setBroken] = useState(false);
  const icon = <span className="thumb-icon">{kindIcon(item, 44)}</span>;
  const url = `/api/files/${item.id}`;
  let body: ReactNode = icon;
  if (seen && !broken) {
    if (item.kind !== 'file') body = <DocThumb item={item} fallback={icon} />;
    else if (/\.(png|jpe?g|gif|webp)$/i.test(item.title)) body = <img className="thumb-image" src={url} alt="" loading="lazy" decoding="async" draggable={false} onError={() => setBroken(true)} />;
    // A little way in, since many videos open on a black frame; only the start of the file is fetched.
    else if (videoTypeOf(item.title)) body = <video className="thumb-image" src={`${url}#t=1`} preload="metadata" muted playsInline onError={() => setBroken(true)} />;
    else if (/\.pdf$/i.test(item.title)) body = <PdfThumb url={url} fallback={icon} />;
  }
  return (
    <div ref={ref} className="file-thumb">
      {body}
    </div>
  );
}
