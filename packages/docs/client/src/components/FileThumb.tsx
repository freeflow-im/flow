// The picture of a file in the thumbnail view of the file list. Images show themselves, videos a frame,
// PDFs their first page, and documents, spreadsheets and presentations a small rendering of how they
// start (shared/preview.ts). Nothing is fetched until the card scrolls near the view, and then a few at a time
// (thumbQueue.ts): the browser's few connections to the server are shared with the pages' event streams.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { SLIDE_H, SLIDE_W } from '../../../shared/deck.ts';
import type { FilePreview } from '../../../shared/preview.ts';
import { videoTypeOf } from '../../../shared/types.ts';
import { api } from '../api.ts';
import { SlideView } from '../deck/SlideView.tsx';
import { kindIcon, type LibraryItem } from './FileLibrary.tsx';
import { schedule } from './thumbQueue.ts';

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
const previews = new Map<string, FilePreview>();
const previewKey = (item: LibraryItem) => `${item.id}@${item.updatedAt}`;

/** The first page of a PDF, drawn by pdf.js (loaded only when a PDF needs drawing); stops at `signal`. */
async function drawPdf(url: string, canvas: HTMLCanvasElement, width: number, signal: AbortSignal): Promise<void> {
  const pdfjs = await import('pdfjs-dist');
  if (!pdfjs.GlobalWorkerOptions.workerSrc) pdfjs.GlobalWorkerOptions.workerSrc = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  if (signal.aborted) return;
  // Only the parts of the file the first page needs (the server answers Range requests), not the whole of it.
  const task = pdfjs.getDocument({ url, withCredentials: true, disableAutoFetch: true, disableStream: true });
  const stop = () => void task.destroy();
  signal.addEventListener('abort', stop);
  try {
    const doc = await task.promise;
    const page = await doc.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: (width * Math.min(2, window.devicePixelRatio || 1)) / base.width });
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    await page.render({ canvas, viewport }).promise;
  } finally {
    signal.removeEventListener('abort', stop);
    void task.destroy();
  }
}

function PdfThumb({ url, fallback }: { url: string; fallback: ReactNode }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<'drawing' | 'done' | 'failed'>('drawing');
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    return schedule((signal) =>
      drawPdf(url, canvas, 260, signal).then(
        () => !signal.aborted && setState('done'),
        () => !signal.aborted && setState('failed'),
      ),
    );
  }, [url]);
  if (state === 'failed') return <>{fallback}</>;
  return <canvas ref={ref} className="thumb-page" style={{ visibility: state === 'done' ? 'visible' : 'hidden' }} />;
}

/** A frame of a video: the element gets its source when its turn comes, and the lane is free once a frame is up. */
function VideoThumb({ url, onError }: { url: string; onError(): void }) {
  const [src, setSrc] = useState<string | null>(null);
  const settle = useRef<(() => void) | null>(null);
  useEffect(
    () =>
      schedule(
        (signal) =>
          new Promise<void>((done) => {
            setSrc(url);
            // Settled by the element below (a frame, or an error), or when the card goes; a stuck one frees the lane in 15 s.
            const timer = setTimeout(done, 15_000);
            settle.current = () => (clearTimeout(timer), done());
            signal.addEventListener('abort', () => settle.current?.());
          }),
      ),
    [url],
  );
  if (!src) return null;
  // A little way in, since many videos open on a black frame; only the start of the file is fetched.
  return <video className="thumb-image" src={`${src}#t=1`} preload="metadata" muted playsInline onLoadedData={() => settle.current?.()} onError={() => (settle.current?.(), onError())} />;
}

function DocThumb({ item, fallback }: { item: LibraryItem; fallback: ReactNode }) {
  const [preview, setPreview] = useState<FilePreview | null>(() => previews.get(previewKey(item)) ?? null);
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const key = previewKey(item);
    const known = previews.get(key);
    if (known) {
      setPreview(known);
      return;
    }
    return schedule((signal) =>
      api.preview(item.id, signal).then(
        (r) => {
          previews.set(key, r.preview);
          if (!signal.aborted) setPreview(r.preview);
        },
        () => !signal.aborted && setPreview({ kind: 'empty' }),
      ),
    );
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
    else if (videoTypeOf(item.title)) body = <VideoThumb url={url} onError={() => setBroken(true)} />;
    else if (/\.pdf$/i.test(item.title)) body = <PdfThumb url={url} fallback={icon} />;
  }
  return (
    <div ref={ref} className="file-thumb">
      {body}
    </div>
  );
}
