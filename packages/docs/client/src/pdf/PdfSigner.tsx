// Signing a PDF on its page: the pages drawn by pdf.js, with the user's signature, lines of text and dates put on
// them where they click, moved by dragging and sized by their corner. Save writes them into the PDF
// (shared/pdfSign.ts) over the file, keeping the version before; Save a copy makes a new file next to it.
// Where the bytes come from and go is the page's business (`store`), as for the image editor.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
import { signPdf, TEXT_BASELINE, TEXT_FONT_CSS, TEXT_LINE_HEIGHT, type PdfMark } from '../../../shared/pdfSign.ts';
import { ConfirmModal } from '../components/Modal.tsx';
import { SignMenu, today, useSignatures, type Signature } from '../components/SignMenu.tsx';

export interface SignedPdfStore {
  /** The PDF's bytes as they are. */
  load(): Promise<ArrayBuffer>;
  /** Save the signed PDF over the one opened. */
  replace(pdf: Blob): Promise<void>;
  /** Save the signed PDF as a new file with this name, next to the file. */
  create(name: string, pdf: Blob): Promise<void>;
}

type Mark = PdfMark & { id: string };
type Tool = 'signature' | 'text' | 'date';

/** Size of a page as it is shown, in points. */
interface PageSize {
  width: number;
  height: number;
}

const DEFAULT_TEXT_SIZE = 12;
/** A signature is put on the page this wide (in points), or less when that would make it too tall. */
const SIGNATURE_WIDTH = 150;
const SIGNATURE_MAX_HEIGHT = 50;
/** Room around the pages, in pixels. */
const GUTTER = 48;

let nextId = 0;
const newId = () => `m${++nextId}`;

/** The name of a signed copy: `Contract.pdf` → `Contract-signed.pdf`. */
export function signedCopyName(filename: string): string {
  const base = filename.replace(/\.pdf$/i, '').replace(/-signed$/, '');
  return `${base}-signed.pdf`;
}

async function loadPdfjs() {
  const pdfjs = await import('pdfjs-dist');
  if (!pdfjs.GlobalWorkerOptions.workerSrc) pdfjs.GlobalWorkerOptions.workerSrc = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  return pdfjs;
}

export function PdfSigner({ file, store, onClose }: { file: { id: string; filename: string }; store: SignedPdfStore; onClose(): void }) {
  const [bytes, setBytes] = useState<ArrayBuffer | null>(null);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [pages, setPages] = useState<PageSize[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [marks, setMarks] = useState<Mark[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool | null>(null);
  const sigs = useSignatures();
  /** The signature the Sign tool puts on the page. */
  const [signature, setSignature] = useState<Signature | null>(null);
  const [busy, setBusy] = useState<'save' | 'copy' | null>(null);
  const [confirmClose, setConfirmClose] = useState(false);
  const [width, setWidth] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const storeRef = useRef(store);
  storeRef.current = store;

  // The PDF, read once: its bytes are kept for writing, and pdf.js gets its own copy to draw from.
  useEffect(() => {
    let stale = false;
    let task: { destroy(): Promise<void> } | null = null;
    (async () => {
      const data = await storeRef.current.load();
      const pdfjs = await loadPdfjs();
      if (stale) return;
      const loading = pdfjs.getDocument({ data: data.slice(0) });
      task = loading;
      const pdf = await loading.promise;
      const sizes: PageSize[] = [];
      for (let n = 1; n <= pdf.numPages; n++) {
        const v = (await pdf.getPage(n)).getViewport({ scale: 1 });
        sizes.push({ width: v.width, height: v.height });
      }
      if (stale) return;
      setBytes(data);
      setDoc(pdf);
      setPages(sizes);
    })().catch((e: Error) => !stale && setError(e.message || 'This PDF could not be read.'));
    return () => {
      stale = true;
      void task?.destroy();
    };
  }, [file.id]);

  // Pages fit the width of the view, up to a little larger than life.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const widest = Math.max(1, ...pages.map((p) => p.width));
  const scale = width ? Math.max(0.3, Math.min(1.5, (width - GUTTER) / widest)) : 1;

  const update = useCallback((id: string, change: Partial<Mark>) => setMarks((ms) => ms.map((m) => (m.id === id ? ({ ...m, ...change } as Mark) : m))), []);
  const remove = useCallback((id: string) => {
    setMarks((ms) => ms.filter((m) => m.id !== id));
    setSelected((s) => (s === id ? null : s));
    setEditing((s) => (s === id ? null : s));
  }, []);

  // Delete removes the selected mark; Escape puts the tool down or lets go of the mark.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (editing || (e.target as HTMLElement | null)?.closest('input, textarea, .modal')) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && selected) {
        e.preventDefault();
        remove(selected);
      } else if (e.key === 'Escape') {
        setTool(null);
        setSelected(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, editing, remove]);

  /** Put the tool's mark on a page where it was clicked (in points): the click is where its line sits. */
  const place = (page: number, x: number, y: number) => {
    if (!tool) {
      setSelected(null);
      setEditing(null);
      return;
    }
    const size = pages[page];
    const id = newId();
    if (tool === 'signature') {
      if (!signature) return;
      let w = SIGNATURE_WIDTH;
      let h = (w * signature.height) / signature.width;
      if (h > SIGNATURE_MAX_HEIGHT) {
        h = SIGNATURE_MAX_HEIGHT;
        w = (h * signature.width) / signature.height;
      }
      // The ink's bottom dips a little below the line, as a pen's does.
      const mx = Math.max(0, Math.min(size.width - w, x));
      const my = Math.max(0, Math.min(size.height - h, y - h * 0.85));
      setMarks((ms) => [...ms, { id, type: 'image', page, x: mx, y: my, width: w, height: h, src: signature.image }]);
      setSelected(id);
    } else {
      const s = DEFAULT_TEXT_SIZE;
      const mx = Math.max(0, Math.min(size.width - s, x));
      const my = Math.max(0, Math.min(size.height - s * TEXT_LINE_HEIGHT, y - s * TEXT_BASELINE));
      setMarks((ms) => [...ms, { id, type: 'text', page, x: mx, y: my, size: s, text: tool === 'date' ? today() : '' }]);
      setSelected(id);
      if (tool === 'text') setEditing(id);
    }
    setTool(null);
  };

  const pickTool = (t: Tool) => {
    setEditing(null);
    setTool(tool === t ? null : t);
  };

  /** Sign with this signature: the next click on a page puts it there. */
  const signWith = (sig: Signature) => {
    setEditing(null);
    setSignature(sig);
    setTool('signature');
  };

  const forgotSignature = (sig: Signature) => {
    if (signature?.id === sig.id) {
      setSignature(null);
      if (tool === 'signature') setTool(null);
    }
  };

  const save = async (what: 'save' | 'copy') => {
    if (!bytes || busy) return;
    setBusy(what);
    setError(null);
    setEditing(null);
    try {
      const out = await signPdf(bytes.slice(0), marks.map(({ id: _, ...m }) => m as PdfMark));
      const blob = new Blob([out as Uint8Array<ArrayBuffer>], { type: 'application/pdf' });
      if (what === 'save') await store.replace(blob);
      else await store.create(signedCopyName(file.filename), blob);
      setBusy(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  };

  const close = () => (marks.length ? setConfirmClose(true) : onClose());

  const hint = tool === 'signature' ? 'Click where your signature goes.' : tool === 'text' ? 'Click where the text goes, then type it.' : tool === 'date' ? "Click where today's date goes." : 'Add your signature, text or a date, then drag it into place. Double-click text to change it.';

  return (
    <div className="pdf-signer">
      <div className="html-editor-bar pdf-signer-bar">
        <SignMenu sigs={sigs} current={signature?.id} active={tool === 'signature'} disabled={!doc} title="Put one of your signatures on the page" onPick={signWith} onForgot={forgotSignature} onError={setError} />
        <button className={`btn${tool === 'text' ? ' active' : ''}`} disabled={!doc} onClick={() => pickTool('text')} title="Write a line of text on the page">
          Text
        </button>
        <button className={`btn${tool === 'date' ? ' active' : ''}`} disabled={!doc} onClick={() => pickTool('date')} title="Write today's date on the page">
          Date
        </button>
        <span className="muted pdf-signer-hint">{error ? <span className="form-error">{error}</span> : hint}</span>
        <span className="html-editor-space" />
        <button className="btn" disabled={busy !== null} onClick={close}>
          Close
        </button>
        <button className="btn" disabled={!marks.length || busy !== null} onClick={() => void save('copy')} title="Keep this PDF as it is and save the signed one as a new file next to it">
          {busy === 'copy' ? 'Saving…' : 'Save a copy'}
        </button>
        <button className="btn primary" disabled={!marks.length || busy !== null} onClick={() => void save('save')} title="Save the signed PDF in place of this one; the version before is kept">
          {busy === 'save' ? 'Saving…' : 'Save'}
        </button>
      </div>
      <div ref={scroller} className={`pdf-signer-pages${tool ? ' placing' : ''}`}>
        {!doc && !error && <div className="muted">Loading…</div>}
        {doc &&
          pages.map((size, i) => (
            <PdfPage key={i} doc={doc} index={i} size={size} scale={scale} onPlace={(x, y) => place(i, x, y)}>
              {marks
                .filter((m) => m.page === i)
                .map((m) => (
                  <MarkView
                    key={m.id}
                    mark={m}
                    page={size}
                    scale={scale}
                    selected={selected === m.id}
                    editing={editing === m.id}
                    onSelect={() => (setSelected(m.id), setTool(null))}
                    onEdit={() => m.type === 'text' && setEditing(m.id)}
                    onChange={(c) => update(m.id, c)}
                    onDone={() => {
                      setEditing(null);
                      if (m.type === 'text' && !m.text.trim()) remove(m.id);
                    }}
                    onRemove={() => remove(m.id)}
                  />
                ))}
            </PdfPage>
          ))}
      </div>
      {confirmClose && <ConfirmModal title="Close without saving?" message="What you put on this PDF has not been saved." confirmText="Discard changes" danger onConfirm={onClose} onClose={() => setConfirmClose(false)} />}
    </div>
  );
}

/** One page, drawn when it comes into view, with its marks over it. */
function PdfPage({ doc, index, size, scale, onPlace, children }: { doc: PDFDocumentProxy; index: number; size: PageSize; scale: number; onPlace(x: number, y: number): void; children: React.ReactNode }) {
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

  const click = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget) return;
    const r = e.currentTarget.getBoundingClientRect();
    onPlace((e.clientX - r.left) / scale, (e.clientY - r.top) / scale);
  };

  return (
    <div ref={box} className="pdf-signer-page" style={{ width: size.width * scale, height: size.height * scale }}>
      <canvas ref={canvas} className="pdf-signer-canvas" />
      <div className="pdf-signer-overlay" onClick={click} aria-label={`Page ${index + 1}`}>
        {children}
      </div>
    </div>
  );
}

/** A mark on a page: dragged to move, sized by its corner, a text one typed in. */
function MarkView({
  mark,
  page,
  scale,
  selected,
  editing,
  onSelect,
  onEdit,
  onChange,
  onDone,
  onRemove,
}: {
  mark: Mark;
  page: PageSize;
  scale: number;
  selected: boolean;
  editing: boolean;
  onSelect(): void;
  onEdit(): void;
  onChange(change: Partial<Mark>): void;
  onDone(): void;
  onRemove(): void;
}) {
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) input.current?.focus();
  }, [editing]);

  const width = mark.type === 'image' ? mark.width : null;
  const height = mark.type === 'image' ? mark.height : mark.size * TEXT_LINE_HEIGHT;

  /** Follow the pointer from where it went down, until it comes up. */
  const track = (e: ReactPointerEvent, move: (dx: number, dy: number) => void) => {
    e.stopPropagation();
    e.preventDefault();
    const sx = e.clientX;
    const sy = e.clientY;
    const onMove = (ev: PointerEvent) => move((ev.clientX - sx) / scale, (ev.clientY - sy) / scale);
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const drag = (e: ReactPointerEvent) => {
    if (editing || e.button !== 0) return;
    onSelect();
    const { x, y } = mark;
    const w = width ?? (e.currentTarget as HTMLElement).offsetWidth / scale;
    track(e, (dx, dy) => onChange({ x: Math.max(0, Math.min(page.width - w, x + dx)), y: Math.max(0, Math.min(page.height - height, y + dy)) }));
  };

  // A signature keeps its shape; text grows and shrinks its letters.
  const resize = (e: ReactPointerEvent) => {
    if (mark.type === 'image') {
      const { width: w, height: h } = mark;
      track(e, (dx) => {
        const nw = Math.max(20, Math.min(page.width - mark.x, w + dx));
        const nh = (nw * h) / w;
        if (mark.y + nh <= page.height) onChange({ width: nw, height: nh });
      });
    } else {
      const s = mark.size;
      track(e, (_dx, dy) => onChange({ size: Math.round(Math.max(6, Math.min(72, s + dy / TEXT_LINE_HEIGHT)) * 2) / 2 }));
    }
  };

  const style: React.CSSProperties = { left: mark.x * scale, top: mark.y * scale };
  return (
    <div
      className={`pdf-mark pdf-mark-${mark.type}${selected ? ' selected' : ''}${editing ? ' editing' : ''}`}
      style={style}
      onPointerDown={drag}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => (e.stopPropagation(), onEdit())}
    >
      {mark.type === 'image' ? (
        <img src={mark.src} alt="Signature" draggable={false} style={{ width: mark.width * scale, height: mark.height * scale }} />
      ) : (
        <span className="pdf-mark-text" style={{ fontSize: mark.size * scale, lineHeight: TEXT_LINE_HEIGHT, fontFamily: TEXT_FONT_CSS }}>
          {editing ? (
            <input
              ref={input}
              value={mark.text}
              placeholder="Type here"
              style={{ width: `${Math.max(6, mark.text.length + 1)}ch` }}
              onChange={(e) => onChange({ text: e.target.value })}
              onBlur={onDone}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === 'Escape') {
                  e.preventDefault();
                  e.currentTarget.blur();
                }
              }}
            />
          ) : (
            mark.text || ' '
          )}
        </span>
      )}
      {selected && !editing && (
        <>
          <span className="pdf-mark-handle" onPointerDown={resize} title={mark.type === 'image' ? 'Drag to resize' : 'Drag to change the text size'} />
          <button className="pdf-mark-remove" onPointerDown={(e) => e.stopPropagation()} onClick={onRemove} title="Remove" aria-label="Remove">
            ×
          </button>
        </>
      )}
    </div>
  );
}
