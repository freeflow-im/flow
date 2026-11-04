import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

function readWidth(key: string, fallback: number, min: number, max: number): number {
  try {
    const v = Number(localStorage.getItem(key));
    return v ? clamp(v, min, max) : fallback;
  } catch {
    return fallback;
  }
}

/**
 * A panel's width the user drags from its right edge (or, for a panel on the right, `edge` 'left', its left one): kept
 * between `min` and `max`, remembered in localStorage under `key`, back to `initial` on a double-click (Docs' folder
 * panel works the same way).
 */
export function useResizableWidth(key: string, initial: number, min: number, max: number, edge: 'left' | 'right' = 'right') {
  const dir = edge === 'right' ? 1 : -1;
  const [width, setWidth] = useState(() => readWidth(key, initial, min, max));
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);

  const save = useCallback(
    (w: number) => {
      try {
        localStorage.setItem(key, String(w));
      } catch {
        // Not kept: the width still applies to this page.
      }
    },
    [key],
  );

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      e.preventDefault();
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      drag.current = { startX: e.clientX, startWidth: width };
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    },
    [width],
  );
  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      if (!drag.current) return;
      setWidth(clamp(drag.current.startWidth + dir * (e.clientX - drag.current.startX), min, max));
    },
    [min, max, dir],
  );
  const onPointerUp = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      if (!drag.current) return;
      const w = clamp(drag.current.startWidth + dir * (e.clientX - drag.current.startX), min, max);
      drag.current = null;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      setWidth(w);
      save(w);
    },
    [min, max, save, dir],
  );
  const onDoubleClick = useCallback(() => {
    setWidth(initial);
    save(initial);
  }, [initial, save]);

  return { width, handleProps: { onPointerDown, onPointerMove, onPointerUp, onDoubleClick } };
}
