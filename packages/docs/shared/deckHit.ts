// What a click on a slide means around a hollow shape. A shape with no fill and no text is an outline: a frame
// around a screenshot, a box drawn round a group of things. What the user sees inside it, and is reaching for,
// is what lies under it; the frame itself is its line. So:
//  - a click near the line (a band on both sides of it, wide enough to hit however thin the line is) is for
//    the frame, even when it lands just outside the shape's box or on something the frame is drawn over;
//  - a click in the open middle is for the element beneath, when there is one, and for the frame when not.
import type { SlideElement } from './deck.ts';

/** The point in an element's own frame: turned back by the element's rotation about its box's centre. */
function local(el: SlideElement, px: number, py: number): [number, number] {
  if (!el.rot) return [px, py];
  const [cx, cy] = [el.x + el.w / 2, el.y + el.h / 2];
  const a = (-el.rot * Math.PI) / 180;
  const [dx, dy] = [px - cx, py - cy];
  return [cx + dx * Math.cos(a) - dy * Math.sin(a), cy + dx * Math.sin(a) + dy * Math.cos(a)];
}

function inBox(el: SlideElement, px: number, py: number): boolean {
  const [x, y] = local(el, px, py);
  return x >= el.x && x <= el.x + el.w && y >= el.y && y <= el.y + el.h;
}

/** True for a shape that is only an outline: nothing fills it and nothing is written in it. */
export function isHollow(el: SlideElement): boolean {
  return el.type === 'shape' && el.fill === 'none' && !el.text && el.shape !== 'line' && el.shape !== 'arc' && el.w > 0 && el.h > 0;
}

/**
 * True if the point is in the band along a hollow shape's outline: within `reach` of it on the outside, and
 * within `reach` of the inner edge of its line on the inside (the line is drawn inward from the box's edge).
 */
export function onOutline(el: SlideElement, px: number, py: number, reach: number): boolean {
  if (!isHollow(el) || el.type !== 'shape') return false;
  const [x, y] = local(el, px, py);
  const line = el.strokeWidth ?? 2;
  if (el.shape === 'ellipse') {
    const [rx, ry] = [el.w / 2, el.h / 2];
    // How far in from the curve (negative: outside it), along the line from the centre, in the smaller radius's units.
    const inside = (1 - Math.hypot((x - (el.x + rx)) / rx, (y - (el.y + ry)) / ry)) * Math.min(rx, ry);
    return inside >= -reach && inside <= reach + line;
  }
  // Inside the box: how far from its nearest edge. Outside: how far from the box.
  const inside = Math.min(x - el.x, el.x + el.w - x, y - el.y, el.y + el.h - y);
  if (inside >= 0) return inside <= reach + line;
  return Math.hypot(Math.max(el.x - x, 0, x - el.x - el.w), Math.max(el.y - y, 0, y - el.y - el.h)) <= reach;
}

/**
 * The element a click at (px, py) is for. `hit` is the element that received it (the topmost there), or null
 * for a click on the slide itself; `elements` are the slide's, in drawing order; `reach` is how near an outline
 * counts as on it, in slide points. Null means the slide itself.
 */
export function clickTarget(elements: SlideElement[], hit: SlideElement | null, px: number, py: number, reach: number): SlideElement | null {
  const top = hit ? elements.findIndex((e) => e.id === hit.id) : -1;
  // A frame whose line the click is on, drawn over what received the click (or over the bare slide).
  for (let i = elements.length - 1; i > top; i--) if (onOutline(elements[i], px, py, reach)) return elements[i];
  if (!hit) return null;
  // From what received the click, down through the open middles of frames.
  let open: SlideElement | null = null;
  for (let i = top; i >= 0; i--) {
    const el = elements[i];
    if (!isHollow(el)) {
      if (i === top || inBox(el, px, py)) return el;
      continue;
    }
    if (onOutline(el, px, py, reach)) return el;
    if (i === top || inBox(el, px, py)) open = el;
  }
  // Nothing under the frames there: the click is for the innermost of them.
  return open ?? hit;
}

/** The frame whose outline band the pointer is in and a click there would take, if any (for the hover cue). */
export function frameUnderPointer(elements: SlideElement[], hit: SlideElement | null, px: number, py: number, reach: number): SlideElement | null {
  const target = clickTarget(elements, hit, px, py, reach);
  return target && onOutline(target, px, py, reach) ? target : null;
}

/** True if the segment from (x1, y1) to (x2, y2) touches the box with corners (l, t) and (r, b). */
function segmentTouchesBox(x1: number, y1: number, x2: number, y2: number, l: number, t: number, r: number, b: number): boolean {
  // Liang-Barsky: clip the segment's parameter range against each side of the box.
  let [t0, t1] = [0, 1];
  const [dx, dy] = [x2 - x1, y2 - y1];
  for (const [p, q] of [[-dx, x1 - l], [dx, r - x1], [-dy, y1 - t], [dy, b - y1]]) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const u = q / p;
    if (p < 0) t0 = Math.max(t0, u);
    else t1 = Math.min(t1, u);
    if (t0 > t1) return false;
  }
  return true;
}

/**
 * The elements a selection box touches, in drawing order. The box is given by two opposite corners (where the
 * drag started and where the pointer is), in slide points. An element is touched when the box overlaps any of
 * it, except that:
 *  - a straight line is touched only where the box crosses the line itself, not anywhere in its bounding box;
 *  - an outline (see isHollow) is touched at its line, not in its open middle, so that the things inside a
 *    frame can be boxed without taking the frame;
 *  - a turned element is taken by the box that holds it as turned.
 */
export function elementsInBox(elements: SlideElement[], ax: number, ay: number, bx: number, by: number): SlideElement[] {
  const [l, r] = ax < bx ? [ax, bx] : [bx, ax];
  const [t, b] = ay < by ? [ay, by] : [by, ay];
  return elements.filter((el) => {
    if (el.type === 'line' && el.kind === 'straight') {
      return segmentTouchesBox(el.flipH ? el.x + el.w : el.x, el.flipV ? el.y + el.h : el.y, el.flipH ? el.x : el.x + el.w, el.flipV ? el.y : el.y + el.h, l, t, r, b);
    }
    let [x0, y0, x1, y1] = [el.x, el.y, el.x + el.w, el.y + el.h];
    if (el.rot) {
      const [cx, cy] = [el.x + el.w / 2, el.y + el.h / 2];
      const a = (el.rot * Math.PI) / 180;
      const [hw, hh] = [(Math.abs(el.w * Math.cos(a)) + Math.abs(el.h * Math.sin(a))) / 2, (Math.abs(el.w * Math.sin(a)) + Math.abs(el.h * Math.cos(a))) / 2];
      [x0, y0, x1, y1] = [cx - hw, cy - hh, cx + hw, cy + hh];
    }
    if (r < x0 || l > x1 || b < y0 || t > y1) return false;
    if (isHollow(el) && !el.rot && el.type === 'shape') {
      const line = el.strokeWidth ?? 2;
      // Wholly within the open middle: the frame's line is not touched.
      if (l > x0 + line && r < x1 - line && t > y0 + line && b < y1 - line) return false;
    }
    return true;
  });
}
