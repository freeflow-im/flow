// The box a user drags on a picture in its preview page (components/ImageSelector.tsx), which the assistant is
// told about. Boxes are kept in the picture's own pixels, so they mean the same at any zoom or window size.
import type { ImageRegion } from '../../shared/agent/protocol.ts';

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Drags shorter than this (in screen pixels, either way) are clicks, which clear the selection. */
const MIN_DRAG = 4;

/** The region between two screen points, in picture pixels and kept inside the picture; null for a mere click. */
export function regionFromDrag(a: { x: number; y: number }, b: { x: number; y: number }, drawn: Box, imageWidth: number, imageHeight: number): ImageRegion | null {
  if (!drawn.width || !drawn.height || (Math.abs(a.x - b.x) < MIN_DRAG && Math.abs(a.y - b.y) < MIN_DRAG)) return null;
  const px = (v: number, from: number, size: number, n: number) => Math.round((Math.min(Math.max(v - from, 0), size) / size) * n);
  const x0 = px(Math.min(a.x, b.x), drawn.left, drawn.width, imageWidth);
  const x1 = px(Math.max(a.x, b.x), drawn.left, drawn.width, imageWidth);
  const y0 = px(Math.min(a.y, b.y), drawn.top, drawn.height, imageHeight);
  const y1 = px(Math.max(a.y, b.y), drawn.top, drawn.height, imageHeight);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0, imageWidth, imageHeight };
}

/** Where a region is on screen, given where its picture is drawn. */
export function regionBox(r: ImageRegion, drawn: Box): Box {
  const sx = drawn.width / r.imageWidth;
  const sy = drawn.height / r.imageHeight;
  return { left: drawn.left + r.x * sx, top: drawn.top + r.y * sy, width: r.width * sx, height: r.height * sy };
}
