// The global scratchpad (Taskboard task 16): a button beside the bell in every app's bar that opens the user's
// "Global Scratchpad" whiteboard (at the top of Docs' My files, made on first use) in a popup over the page, to jot a
// note or drop a picture without leaving it. The popup is Docs' /docs/scratchpad page in a frame (Docs'
// pages/ScratchpadPage.tsx); it moves by its title bar and resizes from its corner, and remembers both in this browser.
// The frame is loaded, hidden, once the page around it has settled (PRELOAD_MS, then an idle moment), so the first
// click opens on a board that is already there; it is kept while closed, so it opens again at once and nothing typed
// is lost to a close. Loaded ahead of a click (?preload) the page only finds the scratchpad; a user who has none yet
// gets one when the popup first opens, which the bar tells the frame (SCRATCHPAD_OPENED).
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import './scratchpad.css';

export const SCRATCHPAD_PATH = '/docs/scratchpad';
/** Posted to the frame each time the popup opens (Docs' pages/ScratchpadPage.tsx). */
export const SCRATCHPAD_OPENED = 'flow.scratchpad.opened';
/** How long after the page loads the hidden frame starts loading, out of the way of the page's own first requests. */
export const PRELOAD_MS = 2500;
const KEY = 'flow.scratchpad';
const MIN_W = 360;
const MIN_H = 260;
/** Below the bar (56px) and a little in from the edges. */
const TOP = 64;
const EDGE = 16;

export interface ScratchpadRect { x: number; y: number; w: number; h: number }

/** A size and place on this screen: at least the minimum, at most the window, with the title bar always reachable. */
export function fitRect(r: ScratchpadRect, view: { w: number; h: number }): ScratchpadRect {
  const w = Math.round(Math.max(MIN_W, Math.min(r.w, view.w - 2 * EDGE)));
  const h = Math.round(Math.max(MIN_H, Math.min(r.h, view.h - TOP - EDGE)));
  const x = Math.round(Math.max(0, Math.min(r.x, view.w - w)));
  const y = Math.round(Math.max(0, Math.min(r.y, view.h - 40)));
  return { x, y, w, h };
}

/** Where it opens the first time: the top right, under the bar's buttons. */
export function defaultRect(view: { w: number; h: number }): ScratchpadRect {
  const w = Math.min(760, view.w - 2 * EDGE);
  const h = Math.min(540, view.h - TOP - EDGE);
  return fitRect({ x: view.w - w - EDGE, y: TOP, w, h }, view);
}

const viewSize = () => ({ w: window.innerWidth, h: window.innerHeight });

function readRect(): ScratchpadRect {
  try {
    const v = JSON.parse(window.localStorage.getItem(KEY) ?? 'null') as Partial<ScratchpadRect> | null;
    if (v && [v.x, v.y, v.w, v.h].every((n) => typeof n === 'number' && Number.isFinite(n))) return fitRect(v as ScratchpadRect, viewSize());
  } catch {
    // Nothing remembered.
  }
  return defaultRect(viewSize());
}

function writeRect(r: ScratchpadRect): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(r));
  } catch {
    // Not remembered, that's all.
  }
}

export const ScratchpadIcon = () => (
  <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
    <path d="M5 4h10l4 4v12H5z" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
    <path d="M8.5 15.5l5.8-5.8 1.6 1.6-5.8 5.8H8.5z" fill="currentColor" />
  </svg>
);

/** The bar's button and the popup it opens. */
export function Scratchpad() {
  const [open, setOpen] = useState(false);
  // The frame's address, once it is made: ahead of a click (preloaded), or by the first click; then kept.
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let idle: number | undefined;
    const timer = window.setTimeout(() => {
      const preload = () => setSrc((s) => s ?? `${SCRATCHPAD_PATH}?preload`);
      if (typeof window.requestIdleCallback === 'function') idle = window.requestIdleCallback(preload, { timeout: 3000 });
      else preload();
    }, PRELOAD_MS);
    return () => {
      window.clearTimeout(timer);
      if (idle !== undefined) window.cancelIdleCallback?.(idle);
    };
  }, []);
  const toggle = () => {
    setSrc((s) => s ?? SCRATCHPAD_PATH);
    setOpen((o) => !o);
  };
  return (
    <>
      <button type="button" className="sb-icon-btn sb-scratchpad" aria-label="Scratchpad" aria-pressed={open} title="Scratchpad" data-testid="suite-scratchpad" onClick={toggle}>
        <ScratchpadIcon />
      </button>
      {src && createPortal(<ScratchpadPopup src={src} open={open} onClose={() => setOpen(false)} />, document.body)}
    </>
  );
}

function ScratchpadPopup({ src, open, onClose }: { src: string; open: boolean; onClose(): void }) {
  const [rect, setRect] = useState(readRect);
  const frame = useRef<HTMLIFrameElement>(null);
  // Opened, the keyboard goes to the board (a ⌘V picture lands there at once), and a preloaded page that found no
  // scratchpad makes it now. A page still loading listens once it has loaded, so it is told again then.
  useEffect(() => {
    if (!open) return;
    const win = frame.current?.contentWindow;
    win?.focus();
    const tell = () => frame.current?.contentWindow?.postMessage(SCRATCHPAD_OPENED, window.location.origin);
    tell();
    const el = frame.current;
    el?.addEventListener('load', tell);
    return () => el?.removeEventListener('load', tell);
  }, [open]);
  // While dragging or resizing, a sheet over the frame keeps the pointer's moves in this page.
  const [moving, setMoving] = useState(false);
  const start = useRef<{ px: number; py: number; r: ScratchpadRect; mode: 'move' | 'size' } | null>(null);

  useEffect(() => {
    const onResize = () => setRect((r) => fitRect(r, viewSize()));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const down = (mode: 'move' | 'size') => (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest('button')) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = { px: e.clientX, py: e.clientY, r: rect, mode };
    setMoving(true);
  };
  const move = useCallback((e: ReactPointerEvent<HTMLElement>) => {
    const s = start.current;
    if (!s) return;
    const dx = e.clientX - s.px;
    const dy = e.clientY - s.py;
    const next = s.mode === 'move' ? { ...s.r, x: s.r.x + dx, y: s.r.y + dy } : { ...s.r, w: s.r.w + dx, h: s.r.h + dy };
    setRect(fitRect(next, viewSize()));
  }, []);
  const up = (e: ReactPointerEvent<HTMLElement>) => {
    if (!start.current) return;
    start.current = null;
    setMoving(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    setRect((r) => {
      writeRect(r);
      return r;
    });
  };

  return (
    <div
      className="sb-scratchpad-popup"
      role="dialog"
      aria-label="Global Scratchpad"
      data-testid="suite-scratchpad-popup"
      hidden={!open}
      style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}
    >
      <div className="sb-scratchpad-head" onPointerDown={down('move')} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
        <span className="sb-scratchpad-title">Global Scratchpad</span>
        <button type="button" className="sb-scratchpad-close" aria-label="Close scratchpad" title="Close (esc)" onClick={onClose}>
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      <iframe ref={frame} className="sb-scratchpad-frame" title="Global Scratchpad" src={src} />
      {moving && <div className="sb-scratchpad-sheet" />}
      <div className="sb-scratchpad-grip" aria-hidden="true" onPointerDown={down('size')} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />
    </div>
  );
}
