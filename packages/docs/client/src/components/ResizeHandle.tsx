// A vertical drag handle on the inner edge of a side panel, and the hook holding that panel's width.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';
import { clampWidth, KEY_STEP, loadWidth, saveWidth, type PanelSpec } from '../panelSize.ts';

type Limits = Parameters<typeof clampWidth>[2];

export interface PanelWidth {
  width: number;
  spec: PanelSpec;
  /** Largest width allowed right now. */
  max(): number;
  /** Set the width (clamped); `persist` remembers it for next time. */
  set(w: number, persist: boolean): void;
}

/**
 * The width of a resizable panel, loaded from and saved to localStorage. `limits` gives the current room
 * (see clampWidth); the width is re-clamped when the window or the `observe`d container changes size.
 */
export function usePanelWidth(spec: PanelSpec, limits: () => Limits = () => ({}), observe?: RefObject<HTMLElement | null>): PanelWidth {
  const [width, setWidth] = useState(() => loadWidth(spec));
  const limitsRef = useRef(limits);
  limitsRef.current = limits;
  const clamp = useCallback((w: number) => clampWidth(w, spec, limitsRef.current()), [spec]);

  useEffect(() => {
    const refit = () => setWidth((w) => clamp(w));
    refit();
    window.addEventListener('resize', refit);
    const el = observe?.current;
    const ro = el ? new ResizeObserver(refit) : null;
    if (el) ro!.observe(el);
    return () => {
      window.removeEventListener('resize', refit);
      ro?.disconnect();
    };
  }, [clamp, observe]);

  return {
    width,
    spec,
    max: () => clamp(Infinity),
    set: (w, persist) => {
      const c = clamp(w);
      setWidth(c);
      if (persist) saveWidth(spec, c);
    },
  };
}

/**
 * `side` is where the panel is relative to the handle: "left" for a panel on the left of the screen (the
 * handle is on its right edge, dragging right widens it), "right" for a panel on the right.
 */
export function ResizeHandle({ panel, side, label, className = '' }: { panel: PanelWidth; side: 'left' | 'right'; label: string; className?: string }) {
  const drag = useRef<{ x: number; w: number; last: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const dir = side === 'left' ? 1 : -1;

  const end = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    setDragging(false);
    document.body.style.userSelect = '';
    document.body.style.cursor = '';
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    panel.set(d.last, true);
  };

  useEffect(
    () => () => {
      // Unmounted mid-drag: don't leave the page unselectable.
      if (drag.current) {
        document.body.style.userSelect = '';
        document.body.style.cursor = '';
      }
    },
    [],
  );

  return (
    <div
      className={`resize-handle${dragging ? ' dragging' : ''} ${className}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={panel.width}
      aria-valuemin={panel.spec.min}
      aria-valuemax={panel.max()}
      tabIndex={0}
      title="Drag to resize, double-click to reset"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        drag.current = { x: e.clientX, w: panel.width, last: panel.width };
        setDragging(true);
        document.body.style.userSelect = 'none';
        document.body.style.cursor = 'col-resize';
      }}
      onPointerMove={(e) => {
        const d = drag.current;
        if (!d) return;
        d.last = d.w + dir * (e.clientX - d.x);
        panel.set(d.last, false);
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={() => panel.set(panel.spec.def, true)}
      onKeyDown={(e: KeyboardEvent) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        e.stopPropagation();
        panel.set(panel.width + (e.key === 'ArrowRight' ? dir : -dir) * KEY_STEP, true);
      }}
    />
  );
}
