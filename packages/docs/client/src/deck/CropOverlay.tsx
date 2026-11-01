// The crop frame on a picture of the slide being edited. The whole picture is shown faint where it lies, the
// part to keep bright inside a frame with handles: drag a handle to cut a side, drag inside to move the frame
// over the picture. Enter, Done or a click elsewhere crops; Escape or Cancel leaves the picture as it was. The
// element's own `crop` is what changes (shared/deckCrop.ts), so nothing of the picture is thrown away and it can
// be cropped again, wider, later. Drawn in slide points inside the SlideView, turned as the element is.
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import type { ImageElement } from '../../../shared/deck.ts';
import { cropTo, dragHandle, moveFrame, pictureRect, startFrame, toElementFrame, type CropHandle, type Rect } from '../../../shared/deckCrop.ts';

const HANDLES: CropHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

export function CropOverlay({ el, scale, toSlide, onDone, onCancel }: { el: ImageElement; /** Screen pixels per slide point. */ scale: number; toSlide(e: { clientX: number; clientY: number }): [number, number]; /** The element cropped to the frame. */ onDone(cropped: ImageElement): void; onCancel(): void }) {
  /** The whole picture and the frame, in the element's own frame, once the picture's size is known. */
  const [picture, setPicture] = useState<Rect | null>(null);
  const [frame, setFrame] = useState<Rect | null>(null);
  const root = useRef<HTMLDivElement>(null);
  // Read by the listeners below, which are set up once.
  const live = useRef({ el, picture, frame, onDone, onCancel, toSlide });
  live.current = { el, picture, frame, onDone, onCancel, toSlide };

  useEffect(() => {
    let stop = false;
    const start = (natural: { w: number; h: number }) => {
      if (stop) return;
      const whole = pictureRect(el, natural);
      setPicture(whole);
      setFrame(startFrame(el, whole));
    };
    const img = new Image();
    img.onload = () => start({ w: img.naturalWidth, h: img.naturalHeight });
    // A picture that will not load is taken to fill its box, which is how it is drawn.
    img.onerror = () => start({ w: 0, h: 0 });
    img.src = el.src;
    return () => {
      stop = true;
    };
    // The element as it was when cropping began; it does not change under the frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [el.id]);

  const done = () => {
    const { el: now, picture: whole, frame: kept, onDone: finish, onCancel: cancel } = live.current;
    if (whole && kept) finish(cropTo(now, whole, kept));
    else cancel();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' && e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Enter') done();
      else live.current.onCancel();
    };
    // A press anywhere else crops, as clicking away from a text box keeps what was typed.
    const onDown = (e: MouseEvent) => {
      if (e.button !== 0 || root.current?.contains(e.target as Node)) return;
      done();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('mousedown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('mousedown', onDown, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Drag a handle, or (with none) the frame itself, from where the pointer went down. */
  const beginDrag = (e: ReactMouseEvent, handle: CropHandle | null) => {
    if (e.button !== 0 || !picture || !frame) return;
    e.preventDefault();
    e.stopPropagation();
    const at = (ev: { clientX: number; clientY: number }) => toElementFrame(el, ...live.current.toSlide(ev));
    const [sx, sy] = at(e);
    const start = frame;
    const onMove = (ev: MouseEvent) => {
      const [px, py] = at(ev);
      setFrame(handle ? dragHandle(start, handle, px - sx, py - sy, picture) : moveFrame(start, px - sx, py - sy, picture));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  if (!picture || !frame) return null;
  const hs = 12 / scale;
  const px = 1 / scale;
  const [cx, cy] = [el.x + el.w / 2, el.y + el.h / 2];
  const handleAt = (h: CropHandle) => ({
    left: frame.x + (h.includes('w') ? 0 : h.includes('e') ? frame.w : frame.w / 2) - hs / 2,
    top: frame.y + (h.includes('n') ? 0 : h.includes('s') ? frame.h : frame.h / 2) - hs / 2,
  });
  return (
    <div ref={root} className="sl-crop" style={{ transformOrigin: `${cx}px ${cy}px`, ...(el.rot ? { transform: `rotate(${el.rot}deg)` } : {}) }}>
      {/* The element itself is not drawn while its picture is laid out here. */}
      <style>{`.deck-canvas-slide [data-el="${CSS.escape(el.id)}"] { visibility: hidden; }`}</style>
      <img className="sl-crop-whole" src={el.src} alt="" draggable={false} style={{ left: picture.x, top: picture.y, width: picture.w, height: picture.h }} />
      <div className="sl-crop-frame" style={{ left: frame.x, top: frame.y, width: frame.w, height: frame.h, outlineWidth: 1.5 * px }} onMouseDown={(e) => beginDrag(e, null)}>
        <img src={el.src} alt="" draggable={false} style={{ left: picture.x - frame.x, top: picture.y - frame.y, width: picture.w, height: picture.h }} />
        <div className="sl-crop-thirds" style={{ backgroundSize: `${frame.w / 3}px ${frame.h / 3}px`, ['--line' as string]: `${px}px` }} />
      </div>
      {HANDLES.map((h) => (
        <div key={h} className={`sl-crop-handle sl-handle-${h}`} style={{ ...handleAt(h), width: hs, height: hs, borderWidth: 1.5 * px }} onMouseDown={(e) => beginDrag(e, h)} />
      ))}
      <div className="sl-crop-bar" style={{ left: frame.x, top: frame.y + frame.h + 10 / scale, transform: `scale(${1 / scale})` }} onMouseDown={(e) => e.stopPropagation()}>
        <button className="btn primary" onClick={done} title="Crop to the frame (Enter)">
          Done
        </button>
        <button className="btn" onClick={() => setFrame(picture)} title="Show the whole picture again">
          Reset
        </button>
        <button className="btn" onClick={onCancel} title="Leave the picture as it was (Esc)">
          Cancel
        </button>
      </div>
    </div>
  );
}
