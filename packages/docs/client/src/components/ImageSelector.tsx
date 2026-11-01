// A stored picture in its preview page: fitted to the window, zoomable, and with a box the user can drag on it
// to point the assistant at a part of the picture. A click, or Escape, clears the box.
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ImageRegion } from '../../../shared/agent/protocol.ts';
import { regionBox, regionFromDrag } from '../imageRegion.ts';
import { fitZoomActions, useWheelZoom, ZoomControls } from './ZoomControls.tsx';

/** Space kept around the picture. */
const PAD = 16;

export function ImageSelector({ url, alt, region, onChange }: { url: string; alt: string; region: ImageRegion | null; onChange(region: ImageRegion | null): void }) {
  const frame = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  /** The room there is, and the picture's own size once it has loaded. */
  const [room, setRoom] = useState({ w: 0, h: 0 });
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  /** 1 fits the picture to the window (a small picture is not blown up). */
  const [zoom, setZoom] = useState(1);
  const [drag, setDrag] = useState<{ from: { x: number; y: number }; to: { x: number; y: number } } | null>(null);

  // The frame is measured rather than the scrolling area inside it, whose size changes with its scrollbars.
  useLayoutEffect(() => {
    const el = frame.current;
    if (!el) return;
    const update = () => setRoom({ w: el.clientWidth, h: el.clientHeight });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useWheelZoom(frame, setZoom);
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onChange(null);
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onChange]);

  const fit = natural && room.w && room.h ? Math.min(1, Math.max(0.01, (room.w - 2 * PAD) / natural.w), Math.max(0.01, (room.h - 2 * PAD) / natural.h)) : 0;
  const scale = fit * zoom;
  // The picture fills the stage exactly, so a point on the stage is a point on the picture.
  const drawn = natural && scale ? { left: 0, top: 0, width: natural.w * scale, height: natural.h * scale } : null;

  const point = (e: React.PointerEvent) => {
    const b = stage.current!.getBoundingClientRect();
    return { x: e.clientX - b.left, y: e.clientY - b.top };
  };
  const dragged = drag && drawn && natural ? regionFromDrag(drag.from, drag.to, drawn, natural.w, natural.h) : null;
  const shown = drag ? dragged : region;
  const box = shown && drawn ? regionBox(shown, drawn) : null;

  return (
    <div ref={frame} className="image-select-frame">
      <div className="image-select">
        <div
          ref={stage}
          className="image-select-stage"
          style={drawn ? { width: drawn.width, height: drawn.height } : { visibility: 'hidden' }}
          title="Drag to select part of the picture for the assistant"
          onPointerDown={(e) => {
            if (e.button !== 0 || !drawn) return;
            e.currentTarget.setPointerCapture(e.pointerId);
            setDrag({ from: point(e), to: point(e) });
          }}
          onPointerMove={(e) => drag && setDrag({ from: drag.from, to: point(e) })}
          onPointerUp={() => {
            if (!drag) return;
            onChange(dragged);
            setDrag(null);
          }}
          onPointerCancel={() => setDrag(null)}
        >
          <img className="file-preview-image" src={url} alt={alt} draggable={false} onLoad={(e) => setNatural({ w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })} />
          {box && shown && (
            <div className="image-select-box" style={{ left: box.left, top: box.top, width: box.width, height: box.height }}>
              <span>
                {shown.width} × {shown.height}
              </span>
            </div>
          )}
        </div>
      </div>
      {drawn && <ZoomControls percent={scale * 100} {...fitZoomActions(zoom, setZoom)} />}
    </div>
  );
}
