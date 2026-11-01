// Lines, arrows and connectors on a slide. A line element is stored as its bounding box plus flips: it starts at
// the top-left corner of the box (the top-right with flipH, the bottom-left with flipV) and ends at the opposite
// corner, so moving and nudging a line is the same as moving any element. This file turns that into endpoints,
// routes elbow and curved connectors, draws arrowheads, and keeps connected lines attached to their shapes.
import type { ArrowStyle, ConnectionSite, LineElement, LineKind, ShapeElement, Slide, SlideElement } from './deck.ts';

export const ARROW_STYLES: readonly ArrowStyle[] = ['none', 'arrow', 'open', 'triangle', 'circle', 'diamond'];
export const LINE_KINDS: readonly LineKind[] = ['straight', 'elbow', 'curved'];
export const DASH_STYLES = ['solid', 'dash', 'dot'] as const;
export const SITES: readonly ConnectionSite[] = ['top', 'right', 'bottom', 'left'];

export const DEFAULT_LINE_WIDTH = 3;

type Pt = [number, number];
const r2 = (v: number) => Math.round(v * 100) / 100;

export interface Ends {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

type LineBox = Pick<LineElement, 'x' | 'y' | 'w' | 'h' | 'flipH' | 'flipV'>;

/** Start and end points of a line. */
export function lineEnds(el: LineBox): Ends {
  return {
    x1: el.flipH ? el.x + el.w : el.x,
    y1: el.flipV ? el.y + el.h : el.y,
    x2: el.flipH ? el.x : el.x + el.w,
    y2: el.flipV ? el.y : el.y + el.h,
  };
}

/** The box and flips for a line from (x1,y1) to (x2,y2). */
export function boxFromEnds(x1: number, y1: number, x2: number, y2: number): Pick<LineElement, 'x' | 'y' | 'w' | 'h'> & { flipH?: true; flipV?: true } {
  return {
    x: r2(Math.min(x1, x2)),
    y: r2(Math.min(y1, y2)),
    w: r2(Math.abs(x2 - x1)),
    h: r2(Math.abs(y2 - y1)),
    ...(x2 < x1 ? { flipH: true as const } : {}),
    ...(y2 < y1 ? { flipV: true as const } : {}),
  };
}

/** Round the angle from a fixed end to a multiple of 15 degrees, keeping the distance. */
export function snapAngle(fx: number, fy: number, px: number, py: number): Pt {
  const len = Math.hypot(px - fx, py - fy);
  const a = Math.round(Math.atan2(py - fy, px - fx) / (Math.PI / 12)) * (Math.PI / 12);
  return [fx + len * Math.cos(a), fy + len * Math.sin(a)];
}

const SITE_DIR: Record<ConnectionSite, Pt> = { top: [0, -1], right: [1, 0], bottom: [0, 1], left: [-1, 0] };

/** The point of a connection site (the middle of a side) on an element. */
export function sitePoint(el: Pick<SlideElement, 'x' | 'y' | 'w' | 'h'>, site: ConnectionSite): { x: number; y: number } {
  const cx = el.x + el.w / 2;
  const cy = el.y + el.h / 2;
  return site === 'top' ? { x: cx, y: el.y } : site === 'bottom' ? { x: cx, y: el.y + el.h } : site === 'left' ? { x: el.x, y: cy } : { x: el.x + el.w, y: cy };
}

export interface SiteHit {
  elementId: string;
  site: ConnectionSite;
  x: number;
  y: number;
}

/**
 * Connection points near a pointer: `near` lists the elements whose sites should be shown (the pointer is within
 * `reach` of their box) and `snap` the site within `radius` of the pointer, if any. Lines are not connection targets.
 */
export function nearSites(elements: SlideElement[], px: number, py: number, radius: number, reach: number, exclude?: string): { near: SlideElement[]; snap?: SiteHit } {
  const near: SlideElement[] = [];
  let snap: (SiteHit & { d: number }) | undefined;
  for (const el of elements) {
    if (el.type === 'line' || el.id === exclude) continue;
    if (px < el.x - reach || px > el.x + el.w + reach || py < el.y - reach || py > el.y + el.h + reach) continue;
    near.push(el);
    for (const site of SITES) {
      const p = sitePoint(el, site);
      const d = Math.hypot(p.x - px, p.y - py);
      if (d <= radius && (!snap || d < snap.d)) snap = { elementId: el.id, site, x: p.x, y: p.y, d };
    }
  }
  return { near, ...(snap ? { snap: { elementId: snap.elementId, site: snap.site, x: snap.x, y: snap.y } } : {}) };
}

// ---------------------------------------------------------------------------
// Geometry

/** The arrowhead length for a line of a stroke width. */
export function arrowSize(strokeWidth: number): number {
  return strokeWidth * 3 + 6;
}

export interface Head {
  type: 'polygon' | 'polyline' | 'circle';
  /** SVG points for polygons and polylines. */
  points?: string;
  cx?: number;
  cy?: number;
  r?: number;
  /** Filled with the line color; open arrows are only stroked. */
  filled: boolean;
}

export interface LineGeometry {
  /** SVG path of the stroke, already shortened so it does not poke through the arrowheads. */
  d: string;
  heads: Head[];
  /** The middle of the route, where the mid handle sits. */
  mid: { x: number; y: number };
  /** Elbows with a middle segment whose position `bend` sets: 'y' when it is horizontal (its height varies), 'x' when vertical. */
  bendAxis: 'x' | 'y' | null;
}

const dist = (a: Pt, b: Pt) => Math.hypot(b[0] - a[0], b[1] - a[1]);
const unit = (a: Pt, b: Pt): Pt => {
  const d = dist(a, b) || 1;
  return [(b[0] - a[0]) / d, (b[1] - a[1]) / d];
};

function headShape(style: ArrowStyle, tip: Pt, dir: Pt, size: number): { head: Head; back: number } | null {
  const [dx, dy] = dir;
  const hw = size / 2;
  const at = (back: number, side: number): string => `${r2(tip[0] - dx * back - dy * side)},${r2(tip[1] - dy * back + dx * side)}`;
  switch (style) {
    case 'triangle':
      return { head: { type: 'polygon', points: `${r2(tip[0])},${r2(tip[1])} ${at(size, hw)} ${at(size, -hw)}`, filled: true }, back: size * 0.8 };
    case 'arrow':
      return { head: { type: 'polygon', points: `${r2(tip[0])},${r2(tip[1])} ${at(size, hw)} ${at(size * 0.7, 0)} ${at(size, -hw)}`, filled: true }, back: size * 0.6 };
    case 'open':
      return { head: { type: 'polyline', points: `${at(size, hw)} ${r2(tip[0])},${r2(tip[1])} ${at(size, -hw)}`, filled: false }, back: 0 };
    case 'diamond':
      return { head: { type: 'polygon', points: `${r2(tip[0])},${r2(tip[1])} ${at(size / 2, hw)} ${at(size, 0)} ${at(size / 2, -hw)}`, filled: true }, back: size * 0.9 };
    case 'circle':
      return { head: { type: 'circle', cx: r2(tip[0] - (dx * size) / 2), cy: r2(tip[1] - (dy * size) / 2), r: r2(size / 2), filled: true }, back: size * 0.9 };
    default:
      return null;
  }
}

/** The direction a connector travels when it leaves or arrives at a free end, from the dominant axis. */
function axisDir(dx: number, dy: number): Pt {
  return Math.abs(dx) >= Math.abs(dy) ? [dx < 0 ? -1 : 1, 0] : [0, dy < 0 ? -1 : 1];
}

type GeometryInput = LineBox & Pick<LineElement, 'kind' | 'startArrow' | 'endArrow' | 'strokeWidth' | 'startConnection' | 'endConnection' | 'bend'>;

/**
 * How a line is drawn: its path and arrowheads, in slide coordinates. Elbow and curved connectors leave a
 * connected end perpendicular to the side of the shape it is attached to.
 */
export function lineGeometry(el: GeometryInput): LineGeometry {
  const { x1, y1, x2, y2 } = lineEnds(el);
  const p1: Pt = [x1, y1];
  const p2: Pt = [x2, y2];
  const sw = el.strokeWidth ?? DEFAULT_LINE_WIDTH;
  const bend = Math.min(1, Math.max(0, el.bend ?? 0.5));
  const free = axisDir(x2 - x1, y2 - y1);
  const out1: Pt = el.startConnection ? SITE_DIR[el.startConnection.site] : free; // travel direction at the start
  const toEnd = el.endConnection ? SITE_DIR[el.endConnection.site] : null;
  const in2: Pt = toEnd ? [-toEnd[0], -toEnd[1]] : free; // travel direction at the end
  const len = Math.hypot(x2 - x1, y2 - y1);
  const size = Math.max(2, Math.min(arrowSize(sw), len / 2 || arrowSize(sw)));

  let pts: Pt[] = [p1, p2];
  let curve: { c1: Pt; c2: Pt } | null = null;
  let bendAxis: 'x' | 'y' | null = null;
  let startTan: Pt; // direction of travel at the start and at the end
  let endTan: Pt;
  if (el.kind === 'elbow') {
    const v1 = out1[0] === 0;
    const v2 = in2[0] === 0;
    if (v1 && v2) {
      const my = y1 + (y2 - y1) * bend;
      pts = [p1, [x1, my], [x2, my], p2];
      bendAxis = 'y';
    } else if (!v1 && !v2) {
      const mx = x1 + (x2 - x1) * bend;
      pts = [p1, [mx, y1], [mx, y2], p2];
      bendAxis = 'x';
    } else pts = v1 ? [p1, [x1, y2], p2] : [p1, [x2, y1], p2];
    // Drop zero-length segments so the arrowhead directions are right.
    const all = pts;
    pts = all.filter((p, i) => i === 0 || dist(all[i - 1], p) > 0.01);
    if (pts.length < 2) pts = [p1, p2];
    startTan = unit(pts[0], pts[1]);
    endTan = unit(pts[pts.length - 2], pts[pts.length - 1]);
  } else if (el.kind === 'curved') {
    const k = Math.max(20, Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1)) / 2);
    curve = { c1: [x1 + out1[0] * k, y1 + out1[1] * k], c2: [x2 - in2[0] * k, y2 - in2[1] * k] };
    startTan = len > 0 ? out1 : [1, 0];
    endTan = len > 0 ? in2 : [1, 0];
  } else {
    startTan = unit(p1, p2);
    endTan = startTan;
  }

  const heads: Head[] = [];
  let a = pts[0];
  let b = pts[pts.length - 1];
  const endHead = headShape(el.endArrow ?? 'none', p2, endTan, size);
  if (endHead) {
    heads.push(endHead.head);
    b = [p2[0] - endTan[0] * endHead.back, p2[1] - endTan[1] * endHead.back];
  }
  const startHead = headShape(el.startArrow ?? 'none', p1, [-startTan[0], -startTan[1]], size);
  if (startHead) {
    heads.push(startHead.head);
    a = [p1[0] + startTan[0] * startHead.back, p1[1] + startTan[1] * startHead.back];
  }
  const f = (p: Pt) => `${r2(p[0])} ${r2(p[1])}`;
  let d: string;
  let mid: { x: number; y: number };
  if (curve) {
    d = `M ${f(a)} C ${f(curve.c1)} ${f(curve.c2)} ${f(b)}`;
    // Cubic Bézier at t = 0.5.
    mid = { x: (x1 + 3 * curve.c1[0] + 3 * curve.c2[0] + x2) / 8, y: (y1 + 3 * curve.c1[1] + 3 * curve.c2[1] + y2) / 8 };
  } else {
    const route = [a, ...pts.slice(1, -1), b];
    d = `M ${route.map(f).join(' L ')}`;
    mid = bendAxis && pts.length === 4 ? { x: (pts[1][0] + pts[2][0]) / 2, y: (pts[1][1] + pts[2][1]) / 2 } : { x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
  }
  return { d, heads, mid, bendAxis };
}

/** The dash pattern of a line for an SVG stroke-dasharray, or undefined for solid. */
export function dashArray(dash: LineElement['dash'], sw: number): string | undefined {
  return dash === 'dash' ? `${sw * 4} ${sw * 2.5}` : dash === 'dot' ? `${sw} ${sw * 2}` : undefined;
}

// ---------------------------------------------------------------------------
// Connections and migration

/** Strip undefined properties (they come from drag previews that clear a flip or a connection). */
export function compactLine(el: LineElement): LineElement {
  const out = { ...el } as Record<string, unknown>;
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return out as unknown as LineElement;
}

/**
 * Move the connected ends of lines to their shapes' connection sites, and drop connections to elements that no
 * longer exist. Returns the same slide when nothing changes.
 */
export function reconnectLines(slide: Slide): Slide {
  if (!slide.elements.some((e) => e.type === 'line' && (e.startConnection || e.endConnection))) return slide;
  const byId = new Map(slide.elements.map((e) => [e.id, e]));
  let changed = false;
  const elements = slide.elements.map((el) => {
    if (el.type !== 'line' || (!el.startConnection && !el.endConnection)) return el;
    const next = { ...el } as LineElement;
    let { x1, y1, x2, y2 } = lineEnds(el);
    const target = (c: LineElement['startConnection']) => {
      const t = c && c.elementId !== el.id ? byId.get(c.elementId) : undefined;
      return t && t.type !== 'line' ? t : undefined;
    };
    const s = target(el.startConnection);
    const e = target(el.endConnection);
    if (el.startConnection) {
      if (s) ({ x: x1, y: y1 } = sitePoint(s, el.startConnection.site));
      else delete next.startConnection;
    }
    if (el.endConnection) {
      if (e) ({ x: x2, y: y2 } = sitePoint(e, el.endConnection.site));
      else delete next.endConnection;
    }
    delete next.flipH;
    delete next.flipV;
    Object.assign(next, boxFromEnds(x1, y1, x2, y2));
    if (JSON.stringify(next) === JSON.stringify(el)) return el;
    changed = true;
    return next;
  });
  return changed ? { ...slide, elements } : slide;
}

/** A legacy `shape: "line"` element as a line element, drawn identically. */
export function lineFromShape(el: ShapeElement): LineElement {
  const diagonal = el.w > 0 && el.h > 0;
  const vertical = !diagonal && el.h > el.w;
  const out: LineElement = {
    id: el.id,
    type: 'line',
    kind: 'straight',
    x: el.x,
    y: el.y,
    w: vertical ? 0 : el.w,
    h: vertical || diagonal ? el.h : 0,
    ...(diagonal && el.flip ? { flipV: true } : {}),
    strokeWidth: el.strokeWidth ?? DEFAULT_LINE_WIDTH,
  };
  const color = el.stroke ?? el.fill;
  if (color !== undefined) out.strokeColor = color;
  if (el.arrow === 'end' || el.arrow === 'both') out.endArrow = 'triangle';
  if (el.arrow === 'start' || el.arrow === 'both') out.startArrow = 'triangle';
  return out;
}

/** Convert legacy line shapes in a deck to line elements (same id, same look). */
export function migrateDeck<D extends { slides: Slide[] }>(deck: D): D {
  if (!deck.slides.some((s) => s.elements.some((e) => e.type === 'shape' && e.shape === 'line'))) return deck;
  return {
    ...deck,
    slides: deck.slides.map((s) => ({ ...s, elements: s.elements.map((e) => (e.type === 'shape' && e.shape === 'line' ? lineFromShape(e) : e)) })),
  };
}

/** Copies of elements with new ids (and an offset); connections are kept between copies and dropped otherwise. */
export function cloneElements(els: SlideElement[], newId: () => string, dx = 0, dy = 0): SlideElement[] {
  const ids = new Map(els.map((e) => [e.id, newId()]));
  return els.map((e) => {
    const copy = { ...e, id: ids.get(e.id)!, x: e.x + dx, y: e.y + dy } as SlideElement;
    if (copy.type === 'line') {
      for (const key of ['startConnection', 'endConnection'] as const) {
        const c = copy[key];
        if (!c) continue;
        const to = ids.get(c.elementId);
        if (to) copy[key] = { ...c, elementId: to };
        else delete copy[key];
      }
    }
    return copy;
  });
}
