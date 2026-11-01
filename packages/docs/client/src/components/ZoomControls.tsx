// Zoom out / in buttons that sit over the corner of an editing canvas, with the current size between them.
// Clicking the size goes back to fitting the canvas to its window.
import { useEffect, type RefObject } from 'react';
import { MAX_ZOOM, MIN_ZOOM, stepZoom, wheelZoom } from '../zoom.ts';

export interface ZoomActions {
  /** Absent when there is no further to go. */
  onOut?: () => void;
  onIn?: () => void;
  /** Absent when the canvas is already fitted. */
  onFit?: () => void;
}

export function ZoomControls({ percent, onOut, onIn, onFit }: { /** The size shown, of the real thing. */ percent: number } & ZoomActions) {
  return (
    // Presses here must not reach the canvas underneath (which would clear its selection).
    <div className="zoom-controls" onMouseDown={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
      <button type="button" title="Zoom out" aria-label="Zoom out" disabled={!onOut} onClick={onOut}>
        −
      </button>
      <button type="button" className="zoom-level" title="Fit to the window" disabled={!onFit} onClick={onFit}>
        {Math.round(percent)}%
      </button>
      <button type="button" title="Zoom in" aria-label="Zoom in" disabled={!onIn} onClick={onIn}>
        +
      </button>
    </div>
  );
}

/** The actions for a zoom kept as a multiple of the fitted size (1 fits). */
export function fitZoomActions(zoom: number, setZoom: (zoom: number) => void): ZoomActions {
  return {
    ...(zoom > MIN_ZOOM ? { onOut: () => setZoom(stepZoom(zoom, -1)) } : {}),
    ...(zoom < MAX_ZOOM ? { onIn: () => setZoom(stepZoom(zoom, 1)) } : {}),
    ...(zoom !== 1 ? { onFit: () => setZoom(1) } : {}),
  };
}

/** A pinch on a trackpad (which arrives as Ctrl + wheel) or Ctrl/Cmd + wheel over the element zooms instead of scrolling. */
export function useWheelZoom(ref: RefObject<HTMLElement | null>, setZoom: (update: (zoom: number) => number) => void): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      setZoom((z) => wheelZoom(z, e.deltaY));
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, [ref, setZoom]);
}
