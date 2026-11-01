import type { Tab } from '../../../shared/types.ts';

export const ROW_HEADER_W = 46;
export const COL_HEADER_H = 24;
export const DEFAULT_COL_W = 100;
export const DEFAULT_ROW_H = 21;
export const FOOTER_H = 64; // space below the last row for the "add rows" control

/** Prefix-sum positions along one axis, with size overrides and hidden (zero-size) entries. */
export class Axis {
  readonly count: number;
  private offsets: Float64Array;

  constructor(count: number, def: number, overrides: Record<string, number>, hidden?: Set<number>) {
    this.count = count;
    this.offsets = new Float64Array(count + 1);
    let pos = 0;
    for (let i = 0; i < count; i++) {
      this.offsets[i] = pos;
      if (!hidden?.has(i)) pos += overrides[i] ?? def;
    }
    this.offsets[count] = pos;
  }

  start(i: number): number {
    return this.offsets[Math.max(0, Math.min(i, this.count))];
  }

  end(i: number): number {
    return this.start(i + 1);
  }

  size(i: number): number {
    return this.end(i) - this.start(i);
  }

  get total(): number {
    return this.offsets[this.count];
  }

  /** Index of the entry containing `pos` (clamped to [0, count-1]); hidden entries are skipped. */
  indexAt(pos: number): number {
    if (pos <= 0) {
      // first visible entry
      let i = 0;
      while (i < this.count - 1 && this.size(i) === 0) i++;
      return i;
    }
    let lo = 0;
    let hi = this.count - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.offsets[mid] <= pos) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }
}

export class Layout {
  readonly rows: Axis;
  readonly cols: Axis;
  readonly frozenRows: number;
  readonly frozenCols: number;
  readonly frozenH: number;
  readonly frozenW: number;

  constructor(tab: Tab, hiddenRows: Set<number>, colOverride?: Record<string, number>, rowOverride?: Record<string, number>) {
    this.rows = new Axis(tab.rows, DEFAULT_ROW_H, rowOverride ?? tab.rowHeights, hiddenRows);
    this.cols = new Axis(tab.cols, DEFAULT_COL_W, colOverride ?? tab.colWidths);
    this.frozenRows = Math.min(tab.frozenRows ?? 0, tab.rows);
    this.frozenCols = Math.min(tab.frozenCols ?? 0, tab.cols);
    this.frozenH = this.rows.start(this.frozenRows);
    this.frozenW = this.cols.start(this.frozenCols);
  }
}

export interface Viewport {
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Screen x of a column's left edge (canvas coordinates). */
export function colX(l: Layout, vp: Viewport, c: number): number {
  return ROW_HEADER_W + l.cols.start(c) - (c < l.frozenCols ? 0 : vp.scrollX);
}

export function rowY(l: Layout, vp: Viewport, r: number): number {
  return COL_HEADER_H + l.rows.start(r) - (r < l.frozenRows ? 0 : vp.scrollY);
}

export function cellRect(l: Layout, vp: Viewport, r: number, c: number): Rect {
  return { x: colX(l, vp, c), y: rowY(l, vp, r), w: l.cols.size(c), h: l.rows.size(r) };
}

export function colAtX(l: Layout, vp: Viewport, x: number): number {
  const cx = x - ROW_HEADER_W;
  if (cx < l.frozenW) return l.cols.indexAt(cx);
  return Math.max(l.frozenCols, l.cols.indexAt(cx + vp.scrollX));
}

export function rowAtY(l: Layout, vp: Viewport, y: number): number {
  const cy = y - COL_HEADER_H;
  if (cy < l.frozenH) return l.rows.indexAt(cy);
  return Math.max(l.frozenRows, l.rows.indexAt(cy + vp.scrollY));
}

/** Visible index ranges for the scrollable (non-frozen) part of each axis. */
export function visibleScrollRows(l: Layout, vp: Viewport): [number, number] {
  const first = Math.max(l.frozenRows, l.rows.indexAt(l.frozenH + vp.scrollY));
  const last = l.rows.indexAt(vp.height - COL_HEADER_H + vp.scrollY);
  return [first, Math.min(last, l.rows.count - 1)];
}

export function visibleScrollCols(l: Layout, vp: Viewport): [number, number] {
  const first = Math.max(l.frozenCols, l.cols.indexAt(l.frozenW + vp.scrollX));
  const last = l.cols.indexAt(vp.width - ROW_HEADER_W + vp.scrollX);
  return [first, Math.min(last, l.cols.count - 1)];
}
