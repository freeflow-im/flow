// The geometry of cropping a picture on a slide. An image element's `crop` is the fraction of the picture cut
// from each side, and the box shows what is left; so a crop is worked out in the element's own frame (the
// slide's, before the element's rotation), where the whole picture and the part to keep are both rectangles.
import type { ImageElement } from './deck.ts';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type CropHandle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

/** The smallest a crop can be made, in slide points. */
export const MIN_CROP = 12;

/**
 * Where the whole picture lies, in the element's own frame. A cropped element says so itself (its box is the
 * kept part). An uncropped one is fitted into its box, whole or covering it, which takes the picture's natural
 * size to know.
 */
export function pictureRect(el: ImageElement, natural: { w: number; h: number }): Rect {
  const c = el.crop;
  if (c && 1 - c.l - c.r > 0 && 1 - c.t - c.b > 0) {
    const w = el.w / (1 - c.l - c.r);
    const h = el.h / (1 - c.t - c.b);
    return { x: el.x - c.l * w, y: el.y - c.t * h, w, h };
  }
  if (!(natural.w > 0 && natural.h > 0) || !(el.w > 0 && el.h > 0)) return { x: el.x, y: el.y, w: el.w, h: el.h };
  const scale = el.fit === 'cover' ? Math.max(el.w / natural.w, el.h / natural.h) : Math.min(el.w / natural.w, el.h / natural.h);
  const w = natural.w * scale;
  const h = natural.h * scale;
  return { x: el.x + (el.w - w) / 2, y: el.y + (el.h - h) / 2, w, h };
}

/** A rectangle kept inside the picture, and no smaller than a crop can be (or than the picture, if that is smaller). */
export function clampToPicture(frame: Rect, picture: Rect): Rect {
  const w = Math.min(picture.w, Math.max(Math.min(MIN_CROP, picture.w), frame.w));
  const h = Math.min(picture.h, Math.max(Math.min(MIN_CROP, picture.h), frame.h));
  const x = Math.min(picture.x + picture.w - w, Math.max(picture.x, frame.x));
  const y = Math.min(picture.y + picture.h - h, Math.max(picture.y, frame.y));
  return { x, y, w, h };
}

/** The frame a crop starts from: the part of the picture the element shows now. */
export function startFrame(el: ImageElement, picture: Rect): Rect {
  const x0 = Math.max(el.x, picture.x);
  const y0 = Math.max(el.y, picture.y);
  const x1 = Math.min(el.x + el.w, picture.x + picture.w);
  const y1 = Math.min(el.y + el.h, picture.y + picture.h);
  return clampToPicture({ x: x0, y: y0, w: x1 - x0, h: y1 - y0 }, picture);
}

/** The frame after one of its handles was dragged by (dx, dy) from where it was at `start`; the opposite sides stay. */
export function dragHandle(start: Rect, handle: CropHandle, dx: number, dy: number, picture: Rect): Rect {
  let { x, y } = start;
  let right = start.x + start.w;
  let bottom = start.y + start.h;
  const min = (side: number) => Math.min(MIN_CROP, side);
  if (handle.includes('w')) x = Math.min(right - min(picture.w), Math.max(picture.x, x + dx));
  if (handle.includes('e')) right = Math.max(x + min(picture.w), Math.min(picture.x + picture.w, right + dx));
  if (handle.includes('n')) y = Math.min(bottom - min(picture.h), Math.max(picture.y, y + dy));
  if (handle.includes('s')) bottom = Math.max(y + min(picture.h), Math.min(picture.y + picture.h, bottom + dy));
  return { x, y, w: right - x, h: bottom - y };
}

/** The frame moved by (dx, dy) from where it was at `start`, kept on the picture. */
export function moveFrame(start: Rect, dx: number, dy: number, picture: Rect): Rect {
  return clampToPicture({ ...start, x: start.x + dx, y: start.y + dy }, picture);
}

/** A slide point in the element's own frame: turned back by the element's rotation about its box's centre. */
export function toElementFrame(el: Pick<ImageElement, 'x' | 'y' | 'w' | 'h' | 'rot'>, px: number, py: number): [number, number] {
  if (!el.rot) return [px, py];
  const [cx, cy] = [el.x + el.w / 2, el.y + el.h / 2];
  const a = (-el.rot * Math.PI) / 180;
  const [dx, dy] = [px - cx, py - cy];
  return [cx + dx * Math.cos(a) - dy * Math.sin(a), cy + dx * Math.sin(a) + dy * Math.cos(a)];
}

const round = (n: number, places: number) => Math.round(n * 10 ** places) / 10 ** places;

/**
 * The element cropped to `frame`: the box becomes the frame and `crop` the fractions cut away, so the picture
 * stays the size and in the place it was on the slide. A frame that is the whole picture leaves no crop. A
 * rotated element turns about its box's centre, so the new box is placed where the frame is after that turn.
 */
export function cropTo(el: ImageElement, picture: Rect, frame: Rect): ImageElement {
  const f = clampToPicture(frame, picture);
  const cut = {
    l: round((f.x - picture.x) / picture.w, 4),
    t: round((f.y - picture.y) / picture.h, 4),
    r: round((picture.x + picture.w - f.x - f.w) / picture.w, 4),
    b: round((picture.y + picture.h - f.y - f.h) / picture.h, 4),
  };
  const whole = cut.l <= 0.0005 && cut.t <= 0.0005 && cut.r <= 0.0005 && cut.b <= 0.0005;
  let [cx, cy] = [f.x + f.w / 2, f.y + f.h / 2];
  if (el.rot) {
    // The frame's centre as the slide sees it: turned with the element about the old box's centre.
    const [ox, oy] = [el.x + el.w / 2, el.y + el.h / 2];
    const a = (el.rot * Math.PI) / 180;
    const [dx, dy] = [cx - ox, cy - oy];
    [cx, cy] = [ox + dx * Math.cos(a) - dy * Math.sin(a), oy + dx * Math.sin(a) + dy * Math.cos(a)];
  }
  const { crop: _crop, ...rest } = el;
  const box = { x: round(cx - f.w / 2, 2), y: round(cy - f.h / 2, 2), w: round(f.w, 2), h: round(f.h, 2) };
  return whole ? { ...rest, ...box } : { ...rest, ...box, crop: cut };
}
