// A stored file open in ChatGPT: a player for a video, the pages of a PDF, a web page in a sandboxed frame. The file is not edited, and the
// model has no tools that read it; it is here so everything in the library can be opened where it is listed.
// The bytes come from the plugin server through a link that carries its own token (the iframe has no
// cookies), in ranges, so a video can seek and a long PDF starts with its first pages.
import { useEffect, useRef, useState } from 'react';
import { HtmlPreview } from '../../client/src/components/HtmlPreview.tsx';
import { ImageFileEditor } from '../../client/src/image/ImageFileEditor.tsx';
import { EDITABLE_IMAGE_TYPES, HTML_TYPE } from '../../shared/types.ts';
import type { Host } from './host.ts';
import { createPicture, loadPicture, replacePicture } from './imageStore.ts';

/** Sent on the window, with the file's id, when a stored picture was saved over (by the editor or the model). */
export const PICTURE_CHANGED_EVENT = 'plugin-picture-changed';

interface StoredFileSummary {
  id: string;
  title: string;
  type?: string;
  size?: number;
}

/** Pages drawn at once; the rest follow as the reader scrolls. */
const PAGE_BATCH = 5;

export function FileViewer({ host, id, onBack }: { host: Host; id: string; onBack(): void }) {
  const [state, setState] = useState<{ file: StoredFileSummary; url: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  // A picture opens to be looked at; Edit opens the image editor on it. Each save over it shows the new version.
  const [editing, setEditing] = useState(false);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const changed = (e: Event) => (e as CustomEvent<string>).detail === id && setVersion((v) => v + 1);
    window.addEventListener(PICTURE_CHANGED_EVENT, changed);
    return () => window.removeEventListener(PICTURE_CHANGED_EVENT, changed);
  }, [id]);

  useEffect(() => {
    let stop = false;
    host
      .call<{ file: StoredFileSummary; url: string }>('file_link', { id })
      .then((r) => !stop && setState(r))
      .catch((e: Error) => !stop && setError(e.message));
    return () => {
      stop = true;
    };
  }, [host, id]);

  if (error) {
    return (
      <div className="page-error">
        <p>{error}</p>
        <button className="btn primary" onClick={onBack}>
          All files
        </button>
      </div>
    );
  }
  if (!state) return <div className="page-loading">Loading file…</div>;
  const { file, url } = state;
  const link = host.appLink({ kind: 'file', id });
  return (
    <div className="workbench docs-plugin file-viewer">
      <header className="wb-header">
        <button className="wb-back" title="All files" onClick={onBack}>
          ←
        </button>
        <div className="wb-titles">
          <div className="wb-title-row">
            <span className="wb-title file-viewer-title">{file.title}</span>
          </div>
        </div>
        <div className="wb-user wb-ask">
          {file.type && EDITABLE_IMAGE_TYPES.includes(file.type) && !editing && (
            <button className="btn" title="Crop, rotate, adjust and draw on the picture" onClick={() => setEditing(true)}>
              Edit
            </button>
          )}
          {link && (
            <button className="btn" title="Open in the full app in a new tab" onClick={() => void host.openLink(link)}>
              Open ↗
            </button>
          )}
        </div>
      </header>
      <main className="file-viewer-body">
        {file.type?.startsWith('video/') ? (
          // The browser's own player; it asks the server for the parts of the file it needs.
          <video className="file-preview-video" src={url} controls playsInline />
        ) : file.type === 'application/pdf' ? (
          <PdfPages url={url} />
        ) : file.type === HTML_TYPE ? (
          // The link carries its own token, so the page's text is fetched without credentials.
          <HtmlPreview url={url} title={file.title} credentials="omit" />
        ) : file.type && EDITABLE_IMAGE_TYPES.includes(file.type) && editing ? (
          <ImageFileEditor
            key={version}
            file={{ id, filename: file.title, type: file.type }}
            store={{
              load: async () => (await loadPicture(host, id)).data,
              replace: async (image) => {
                await replacePicture(host, id, file.title, image);
                setVersion((v) => v + 1);
                setEditing(false);
              },
              // The server opens the new file, and the app follows it there.
              create: async (name, image) => void (await createPicture(host, name, image)),
            }}
            onClose={() => setEditing(false)}
          />
        ) : file.type?.startsWith('image/') ? (
          // A picture that was saved over is asked for by a new address, so the copy the browser kept is not shown.
          <img key={version} className="file-preview-image" src={version ? `${url}&v=${version}` : url} alt={file.title} />
        ) : (
          <div className="file-info">
            <h2>{file.title}</h2>
            <p className="muted">This type of file can’t be shown here.{link ? ' Open it in the full app to download it.' : ''}</p>
          </div>
        )}
      </main>
    </div>
  );
}

type PdfDocument = Awaited<ReturnType<typeof import('pdfjs-dist')['getDocument']>['promise']>;

/**
 * PDF.js, set up to work on the page's own thread: the app is one inlined script on an opaque origin, where a
 * worker script cannot be loaded, and a browser's built-in PDF viewer does not run inside a sandboxed frame.
 */
async function loadPdfJs(): Promise<typeof import('pdfjs-dist')> {
  // @ts-expect-error The worker build has no type declarations; only its presence on globalThis matters.
  const [pdfjs, worker] = await Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs')]);
  (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker ??= worker;
  return pdfjs;
}

/** The pages of a PDF, one under the other at the width of the viewer; more are drawn as the reader nears the end. */
function PdfPages({ url }: { url: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [doc, setDoc] = useState<PdfDocument | null>(null);
  const [shown, setShown] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const drawn = useRef(0);

  useEffect(() => {
    let stop = false;
    let task: { destroy(): Promise<void> } | null = null;
    loadPdfJs()
      .then((pdfjs) => {
        const t = pdfjs.getDocument({ url });
        task = t;
        return t.promise;
      })
      .then((d) => {
        if (stop) return;
        setDoc(d);
        setShown(Math.min(PAGE_BATCH, d.numPages));
      })
      .catch((e: Error) => !stop && setError(`This PDF could not be shown (${e.message}).`));
    return () => {
      stop = true;
      void task?.destroy();
    };
  }, [url]);

  // Draw the pages not drawn yet, each on its own canvas, sharp on dense screens.
  useEffect(() => {
    const host = ref.current;
    if (!doc || !host) return;
    let stop = false;
    void (async () => {
      const width = Math.max(200, Math.min(host.clientWidth - 32, 1000));
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      while (!stop && drawn.current < shown) {
        const n = ++drawn.current;
        const page = await doc.getPage(n);
        if (stop) return;
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: (width / base.width) * ratio });
        const canvas = document.createElement('canvas');
        canvas.className = 'pdf-page';
        canvas.width = Math.round(viewport.width);
        canvas.height = Math.round(viewport.height);
        canvas.style.width = `${width}px`;
        canvas.setAttribute('aria-label', `Page ${n}`);
        host.insertBefore(canvas, host.querySelector('.pdf-more'));
        await page.render({ canvas, canvasContext: canvas.getContext('2d')!, viewport }).promise;
      }
    })().catch((e: Error) => !stop && setError(`This PDF could not be shown (${e.message}).`));
    return () => {
      stop = true;
    };
  }, [doc, shown]);

  // Near the bottom: the next batch.
  const more = !!doc && shown < doc.numPages;
  useEffect(() => {
    const marker = ref.current?.querySelector('.pdf-more');
    if (!marker || !doc || !more) return;
    const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setShown((n) => Math.min(doc.numPages, n + PAGE_BATCH)), { root: ref.current, rootMargin: '600px' });
    io.observe(marker);
    return () => io.disconnect();
  }, [doc, more, shown]);

  if (error) return <div className="form-error">{error}</div>;
  return (
    <div className="pdf-pages" ref={ref}>
      {!doc && <div className="muted">Loading PDF…</div>}
      <div className="pdf-more" aria-hidden="true" />
    </div>
  );
}
