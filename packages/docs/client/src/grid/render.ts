import { cellKey, colToName, type Range } from '../../../shared/cellref.ts';
import { hasContent, type FilterState, type Tab } from '../../../shared/types.ts';
import { CellError, type Scalar } from '../../../shared/values.ts';
import type { EditState, Selection } from '../state/controller.ts';
import type { FormulaRef } from '../state/formulaEdit.ts';
import type { WorkbookStore } from '../state/store.ts';
import {
  COL_HEADER_H,
  ROW_HEADER_W,
  cellRect,
  colX,
  rowY,
  visibleScrollCols,
  visibleScrollRows,
  type Layout,
  type Rect,
  type Viewport,
} from './layout.ts';

export const FONT_FAMILY = 'Arial, "Helvetica Neue", Helvetica, sans-serif';
export const FONT_SIZE = 13;

const C = {
  bg: '#ffffff',
  grid: '#e1e1e1',
  headerBg: '#f8f9fa',
  headerBorder: '#c0c0c0',
  headerText: '#444746',
  headerSelBg: '#d3e3fd',
  headerSelText: '#0b57d0',
  headerFullBg: '#0b57d0',
  headerFullText: '#ffffff',
  text: '#202124',
  selFill: 'rgba(26, 115, 232, 0.10)',
  selBorder: '#1a73e8',
  frozen: '#c4c7c5',
  filterHeader: '#e6f4ea',
  filterBorder: '#34a853',
  filterActive: '#188038',
  error: '#d93025',
  link: '#1155cc',
  searchHit: 'rgba(251, 188, 4, 0.30)',
  searchCurrent: 'rgba(251, 140, 0, 0.55)',
  searchCurrentBorder: '#e37400',
};

export type ChangeSide = 'mine' | 'theirs' | 'conflict';

export interface CompareOverlay {
  cells: { r: number; c: number; side: ChangeSide }[];
  /** Rows present in the branch (tinted) or absent from it (drawn as a line before `at`). */
  rows: { at: number; side: ChangeSide; inBranch: boolean }[];
}

export const CHANGE_COLORS: Record<ChangeSide, { solid: string; fill: string }> = {
  mine: { solid: '#188038', fill: 'rgba(52, 168, 83, 0.20)' },
  theirs: { solid: '#7e57c2', fill: 'rgba(126, 87, 194, 0.18)' },
  conflict: { solid: '#d93025', fill: 'rgba(217, 48, 37, 0.20)' },
};

export interface RenderState {
  tab: Tab;
  store: WorkbookStore<unknown>;
  layout: Layout;
  vp: Viewport;
  sel: Selection;
  edit: EditState | null;
  copyMark: Range | null;
  fillPreview: Range | null;
  movePreview: Range | null;
  /** Column boundary (index of the column to its right) where dragged columns would land, or null. */
  colDrop?: number | null;
  refs: (FormulaRef & { range: Range })[];
  /** Branch comparison marks for this tab. */
  compare: CompareOverlay | null;
  /** Find results on this tab ("r,c" keys) and the current match. */
  searchHits: { cells: { r: number; c: number }[]; current: { r: number; c: number } | null } | null;
  dpr: number;
}

const widthCache = new Map<string, number>();
export function measure(ctx: CanvasRenderingContext2D, font: string, text: string): number {
  const k = font + '\u0000' + text;
  let w = widthCache.get(k);
  if (w === undefined) {
    if (widthCache.size > 20000) widthCache.clear();
    ctx.font = font;
    w = ctx.measureText(text).width;
    widthCache.set(k, w);
  }
  return w;
}

export function cellFont(st: { b?: boolean; i?: boolean } | undefined): string {
  return `${st?.i ? 'italic ' : ''}${st?.b ? 'bold ' : ''}${FONT_SIZE}px ${FONT_FAMILY}`;
}

/**
 * Break text into lines no wider than maxW: at spaces where possible, inside a word when the word alone is
 * too wide. Existing line breaks are kept.
 */
export function wrapText(text: string, maxW: number, width: (s: string) => number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(' ')) {
      const candidate = line ? `${line} ${word}` : word;
      if (width(candidate) <= maxW || !candidate) {
        line = candidate;
        continue;
      }
      if (line) out.push(line);
      line = '';
      // Split a word that is wider than the cell on its own.
      let rest = word;
      while (rest && width(rest) > maxW) {
        let n = 1;
        while (n < rest.length && width(rest.slice(0, n + 1)) <= maxW) n++;
        out.push(rest.slice(0, n));
        rest = rest.slice(n);
      }
      line = rest;
    }
    out.push(line);
  }
  return out;
}

function defaultAlign(v: Scalar): 'left' | 'center' | 'right' {
  if (typeof v === 'number') return 'right';
  if (typeof v === 'boolean' || v instanceof CellError) return 'center';
  return 'left';
}

/** The link URL if point x (canvas coordinates) is over the text of a link cell, otherwise null. */
export function linkAt(ctx: CanvasRenderingContext2D, store: WorkbookStore, tab: Tab, l: Layout, vp: Viewport, r: number, c: number, x: number): string | null {
  const url = store.link(tab.id, r, c);
  if (!url) return null;
  const text = store.display(tab.id, r, c);
  if (!text) return null;
  const st = tab.cells[cellKey(r, c)]?.st;
  const tw = Math.max(...text.split('\n').map((ln) => measure(ctx, cellFont(st), ln)));
  const align = st?.align ?? defaultAlign(store.value(tab.id, r, c));
  const left = colX(l, vp, c);
  const w = l.cols.size(c);
  const pad = 3;
  const tx = align === 'right' ? left + w - pad - tw : align === 'center' ? left + (w - tw) / 2 : left + pad;
  return x >= tx - 2 && x <= tx + tw + 2 ? url : null;
}

interface Region {
  rows: [number, number];
  cols: [number, number];
  clip: Rect;
  /** Viewport for this pane: frozen panes ignore scrolling on their frozen axis. */
  vp: Viewport;
}

export function drawGrid(ctx: CanvasRenderingContext2D, s: RenderState): void {
  const { layout: l, vp, dpr } = s;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, vp.width, vp.height);

  const dataX = ROW_HEADER_W;
  const dataY = COL_HEADER_H;
  const fx = dataX + l.frozenW;
  const fy = dataY + l.frozenH;
  const [sr1, sr2] = visibleScrollRows(l, vp);
  const [sc1, sc2] = visibleScrollCols(l, vp);
  const fr: [number, number] = [0, l.frozenRows - 1];
  const fc: [number, number] = [0, l.frozenCols - 1];

  const noX = { ...vp, scrollX: 0 };
  const noY = { ...vp, scrollY: 0 };
  const regions: Region[] = [
    { rows: [sr1, sr2], cols: [sc1, sc2], clip: { x: fx, y: fy, w: vp.width - fx, h: vp.height - fy }, vp },
  ];
  if (l.frozenCols) regions.push({ rows: [sr1, sr2], cols: fc, clip: { x: dataX, y: fy, w: l.frozenW, h: vp.height - fy }, vp: noX });
  if (l.frozenRows) regions.push({ rows: fr, cols: [sc1, sc2], clip: { x: fx, y: dataY, w: vp.width - fx, h: l.frozenH }, vp: noY });
  if (l.frozenRows && l.frozenCols) {
    regions.push({ rows: fr, cols: fc, clip: { x: dataX, y: dataY, w: l.frozenW, h: l.frozenH }, vp: { ...vp, scrollX: 0, scrollY: 0 } });
  }

  for (const reg of regions) {
    if (reg.clip.w <= 0 || reg.clip.h <= 0) continue;
    ctx.save();
    ctx.beginPath();
    ctx.rect(reg.clip.x, reg.clip.y, reg.clip.w, reg.clip.h);
    ctx.clip();
    const rs = { ...s, vp: reg.vp };
    drawCells(ctx, rs, reg);
    drawOverlays(ctx, rs);
    ctx.restore();
  }

  drawHeaders(ctx, s, [sr1, sr2], [sc1, sc2]);

  // Frozen dividers
  ctx.fillStyle = C.frozen;
  if (l.frozenCols) ctx.fillRect(fx - 2, 0, 3, vp.height);
  if (l.frozenRows) ctx.fillRect(0, fy - 2, vp.width, 3);

  // Drop indicator while dragging columns
  if (s.colDrop !== null && s.colDrop !== undefined) {
    const b = s.colDrop;
    const x = b < l.cols.count ? colX(l, vp, b) : colX(l, vp, b - 1) + l.cols.size(b - 1);
    ctx.fillStyle = C.selBorder;
    ctx.fillRect(x - 1.5, 0, 3, vp.height);
  }
}

function drawCells(ctx: CanvasRenderingContext2D, s: RenderState, reg: Region): void {
  const { tab, store, layout: l, vp, sel } = s;
  const [r1, r2] = reg.rows;
  const [c1, c2] = reg.cols;
  if (r2 < r1 || c2 < c1) return;
  const filter = tab.filter;

  // 1. Backgrounds
  for (let r = r1; r <= r2; r++) {
    const h = l.rows.size(r);
    if (!h) continue;
    const y = rowY(l, vp, r);
    for (let c = c1; c <= c2; c++) {
      const cell = tab.cells[cellKey(r, c)];
      let bg = cell?.st?.bg;
      if (!bg && filter && r === filter.r1 && c >= filter.c1 && c <= filter.c2) bg = C.filterHeader;
      if (bg) {
        ctx.fillStyle = bg;
        ctx.fillRect(colX(l, vp, c), y, l.cols.size(c), h);
      }
    }
  }

  // 2. Selection fill (the active cell is left untinted)
  const act = cellRect(l, vp, sel.active.r, sel.active.c);
  for (const rg of sel.ranges) {
    if (rg.r1 === rg.r2 && rg.c1 === rg.c2 && sel.ranges.length === 1) continue;
    const rr = rangeRect(l, vp, rg);
    ctx.save();
    ctx.beginPath();
    ctx.rect(rr.x, rr.y, rr.w, rr.h);
    ctx.rect(act.x, act.y, act.w, act.h);
    ctx.clip('evenodd');
    ctx.fillStyle = C.selFill;
    ctx.fillRect(rr.x, rr.y, rr.w, rr.h);
    ctx.restore();
  }

  // 3. Grid lines
  ctx.strokeStyle = C.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  const top = rowY(l, vp, r1);
  const bottom = rowY(l, vp, r2) + l.rows.size(r2);
  const left = colX(l, vp, c1);
  const right = colX(l, vp, c2) + l.cols.size(c2);
  for (let c = c1; c <= c2; c++) {
    const x = Math.floor(colX(l, vp, c) + l.cols.size(c)) - 0.5;
    ctx.moveTo(x, top);
    ctx.lineTo(x, bottom);
  }
  for (let r = r1; r <= r2; r++) {
    if (!l.rows.size(r)) continue;
    const y = Math.floor(rowY(l, vp, r) + l.rows.size(r)) - 0.5;
    ctx.moveTo(left, y);
    ctx.lineTo(right, y);
  }
  ctx.stroke();

  // 4. Text
  ctx.textBaseline = 'alphabetic';
  const editing = s.edit && s.edit.tabId === tab.id ? s.edit : null;
  for (let r = r1; r <= r2; r++) {
    const h = l.rows.size(r);
    if (!h) continue;
    const y = rowY(l, vp, r);
    for (let c = c1; c <= c2; c++) {
      const cell = tab.cells[cellKey(r, c)];
      if (cell?.img) drawCellImage(ctx, cell.img, colX(l, vp, c), y, l.cols.size(c), h);
      if (!cell || cell.v === '') continue;
      if (editing && editing.r === r && editing.c === c) continue;
      const v = store.value(tab.id, r, c);
      const text = store.display(tab.id, r, c);
      const x = colX(l, vp, c);
      const w = l.cols.size(c);
      if (v instanceof CellError) {
        ctx.fillStyle = C.error;
        ctx.beginPath();
        ctx.moveTo(x + w - 7, y + 1);
        ctx.lineTo(x + w - 1, y + 1);
        ctx.lineTo(x + w - 1, y + 7);
        ctx.fill();
      }
      if (!text) continue;
      drawCellText(ctx, s, r, c, x, y, w, h, text, v, reg, filter, !!store.link(tab.id, r, c));
    }
  }
}

// ---------------------------------------------------------------------------
// Cell images: decoded once per source and drawn scaled to fit inside the cell.

/** Large images are kept downscaled to this size (longest side), so redraws don't rescale huge bitmaps. */
const MAX_DRAWN_IMAGE_PX = 2048;

interface CachedImage {
  /** What to draw once loaded: the decoded image, or a downscaled copy of a large one. */
  drawable: CanvasImageSource | null;
  w: number;
  h: number;
}

const imageCache = new Map<string, CachedImage>();
const imageListeners = new Set<() => void>();

/** Called whenever a cell image finishes loading, so the grid can redraw. */
export function onCellImageLoad(fn: () => void): () => void {
  imageListeners.add(fn);
  return () => imageListeners.delete(fn);
}

function cellImage(src: string): CachedImage {
  let entry = imageCache.get(src);
  if (!entry) {
    if (imageCache.size > 500) imageCache.clear();
    const e: CachedImage = { drawable: null, w: 0, h: 0 };
    entry = e;
    const img = new Image();
    img.decoding = 'async';
    const ready = (d: CanvasImageSource) => {
      Object.assign(e, { drawable: d, w: img.naturalWidth, h: img.naturalHeight });
      imageListeners.forEach((l) => l());
    };
    img.onload = () => {
      const scale = MAX_DRAWN_IMAGE_PX / Math.max(img.naturalWidth, img.naturalHeight);
      if (scale >= 1 || typeof createImageBitmap !== 'function') return ready(img);
      const resizeWidth = Math.max(1, Math.round(img.naturalWidth * scale));
      const resizeHeight = Math.max(1, Math.round(img.naturalHeight * scale));
      createImageBitmap(img, { resizeWidth, resizeHeight, resizeQuality: 'high' }).then(ready, () => ready(img));
    };
    img.src = src;
    imageCache.set(src, e);
  }
  return entry;
}

/** Largest rect with the image's aspect ratio that fits inside the box (minus padding), centered. */
export function fitImage(iw: number, ih: number, x: number, y: number, w: number, h: number, pad = 2): Rect {
  const bw = Math.max(0, w - 1 - pad * 2);
  const bh = Math.max(0, h - 1 - pad * 2);
  if (!iw || !ih || !bw || !bh) return { x, y, w: 0, h: 0 };
  const scale = Math.min(bw / iw, bh / ih);
  const dw = iw * scale;
  const dh = ih * scale;
  return { x: x + pad + (bw - dw) / 2, y: y + pad + (bh - dh) / 2, w: dw, h: dh };
}

function drawCellImage(ctx: CanvasRenderingContext2D, src: string, x: number, y: number, w: number, h: number): void {
  const img = cellImage(src);
  if (!img.drawable) return;
  const fit = fitImage(img.w, img.h, x, y, w, h);
  if (!fit.w || !fit.h) return;
  ctx.drawImage(img.drawable, fit.x, fit.y, fit.w, fit.h);
}

function drawCellText(
  ctx: CanvasRenderingContext2D,
  s: RenderState,
  r: number,
  c: number,
  x: number,
  y: number,
  w: number,
  h: number,
  text: string,
  v: Scalar,
  reg: Region,
  filter: FilterState | undefined,
  isLink: boolean,
): void {
  const { tab, layout: l, vp } = s;
  const cellSt = tab.cells[cellKey(r, c)]?.st;
  // Links are blue and underlined, like in Google Sheets.
  const st = isLink ? { ...cellSt, color: cellSt?.color ?? C.link, u: true } : cellSt;
  const font = cellFont(st);
  const align = st?.align ?? defaultAlign(v);
  const pad = 3;
  const reserve = filter && r === filter.r1 && c >= filter.c1 && c <= filter.c2 ? 18 : 0;
  const wrap = !!st?.wrap && typeof v === 'string';
  const lines = wrap ? wrapText(text, Math.max(1, w - reserve - pad * 2 - 1), (ln) => measure(ctx, font, ln)) : text.split('\n');
  const tw = Math.max(...lines.map((ln) => measure(ctx, font, ln)));

  // Text overflows into empty neighbors to the right (left-aligned, unwrapped strings only).
  let clipRight = x + w - reserve;
  if (align === 'left' && typeof v === 'string' && !wrap && tw + pad * 2 > w && !reserve) {
    let cc = c + 1;
    let edge = x + w;
    while (cc <= reg.cols[1] && edge < x + tw + pad * 2 && !hasContent(tab.cells[cellKey(r, cc)])) {
      const nx = colX(l, vp, cc);
      const nw = l.cols.size(cc);
      // Hide the gridlines the text passes over.
      ctx.fillStyle = tab.cells[cellKey(r, cc)]?.st?.bg ?? C.bg;
      ctx.fillRect(nx - 1, y, Math.min(nw, x + tw + pad * 2 - nx + 1), h - 1);
      edge = nx + nw;
      cc++;
    }
    clipRight = edge;
  }

  let tx: number;
  if (align === 'right') tx = x + w - pad - reserve - tw;
  else if (align === 'center') tx = x + (w - reserve - tw) / 2;
  else tx = x + pad;

  const needsClip = tx < x || tx + tw > clipRight || lines.length > 1;
  if (needsClip) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, clipRight - x - 1, h - 1);
    ctx.clip();
  }
  ctx.font = font;
  ctx.fillStyle = st?.color ?? C.text;
  const lineH = FONT_SIZE + 3;
  // Wrapped text that is taller than the row starts at the top so its beginning stays visible.
  const topAligned = wrap && lines.length * lineH + 5 > h;
  lines.forEach((ln, i) => {
    const baseline = topAligned ? y + 3 + FONT_SIZE + i * lineH - 2 : y + h - 5 - (lines.length - 1 - i) * lineH;
    if (topAligned && baseline - FONT_SIZE > y + h) return;
    const lw = lines.length > 1 ? measure(ctx, font, ln) : tw;
    const lx = align === 'right' ? x + w - pad - reserve - lw : align === 'center' ? x + (w - reserve - lw) / 2 : tx;
    ctx.fillText(ln, lx, baseline);
    if (st?.u || st?.s) {
      ctx.fillRect(lx, st.u ? baseline + 2 : baseline - 4, lw, 1);
      if (st.u && st.s) ctx.fillRect(lx, baseline - 4, lw, 1);
    }
  });
  if (needsClip) ctx.restore();
}

export function rangeRect(l: Layout, vp: Viewport, rg: Range): Rect {
  const a = cellRect(l, vp, rg.r1, rg.c1);
  const b = cellRect(l, vp, rg.r2, rg.c2);
  return { x: a.x, y: a.y, w: Math.max(0, b.x + b.w - a.x), h: Math.max(0, b.y + b.h - a.y) };
}

export function fillHandleRect(l: Layout, vp: Viewport, rg: Range): Rect {
  const rr = rangeRect(l, vp, rg);
  return { x: rr.x + rr.w - 4, y: rr.y + rr.h - 4, w: 7, h: 7 };
}

function strokeRect(ctx: CanvasRenderingContext2D, r: Rect, color: string, width: number, dash?: number[]) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  if (dash) ctx.setLineDash(dash);
  // Center the border on the grid line that precedes the rect (1px), or straddle it (2-3px).
  const off = (width - 1) / 2 - 0.5;
  const shrink = 2 * (off + 0.5);
  ctx.strokeRect(Math.floor(r.x) + off, Math.floor(r.y) + off, Math.max(0, Math.round(r.w) - shrink), Math.max(0, Math.round(r.h) - shrink));
  ctx.restore();
}

function drawOverlays(ctx: CanvasRenderingContext2D, s: RenderState): void {
  const { layout: l, vp, sel, tab } = s;

  if (tab.filter) {
    const f = tab.filter;
    strokeRect(ctx, rangeRect(l, vp, f), C.filterBorder, 1);
    for (let c = f.c1; c <= f.c2; c++) drawFilterButton(ctx, s, f, c);
  }

  if (s.compare) drawCompare(ctx, s, s.compare);

  if (s.searchHits) {
    ctx.fillStyle = C.searchHit;
    for (const { r, c } of s.searchHits.cells) {
      const rr = cellRect(l, vp, r, c);
      if (rr.h === 0 || rr.x > vp.width || rr.y > vp.height || rr.x + rr.w < 0 || rr.y + rr.h < 0) continue;
      ctx.fillRect(rr.x, rr.y, rr.w - 1, rr.h - 1);
    }
    const cur = s.searchHits.current;
    if (cur) {
      const rr = cellRect(l, vp, cur.r, cur.c);
      ctx.fillStyle = C.searchCurrent;
      ctx.fillRect(rr.x, rr.y, rr.w - 1, rr.h - 1);
      strokeRect(ctx, rr, C.searchCurrentBorder, 2);
    }
  }

  for (const ref of s.refs) {
    const rr = rangeRect(l, vp, ref.range);
    ctx.fillStyle = ref.color + '18';
    ctx.fillRect(rr.x, rr.y, rr.w, rr.h);
    strokeRect(ctx, rr, ref.color, 2);
  }

  // Selection borders
  const multi = sel.ranges.length > 1;
  for (const rg of sel.ranges) {
    const single = rg.r1 === rg.r2 && rg.c1 === rg.c2;
    if (!single || multi) strokeRect(ctx, rangeRect(l, vp, rg), C.selBorder, 1);
  }
  strokeRect(ctx, cellRect(l, vp, sel.active.r, sel.active.c), C.selBorder, 2);

  if (!s.edit && sel.ranges.length === 1 && !s.fillPreview) {
    const fh = fillHandleRect(l, vp, sel.ranges[0]);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(fh.x - 1, fh.y - 1, fh.w + 2, fh.h + 2);
    ctx.fillStyle = C.selBorder;
    ctx.fillRect(fh.x, fh.y, fh.w, fh.h);
  }

  if (s.copyMark) strokeRect(ctx, rangeRect(l, vp, s.copyMark), C.selBorder, 2, [5, 3]);
  if (s.fillPreview) strokeRect(ctx, rangeRect(l, vp, s.fillPreview), '#5f6368', 1, [4, 3]);
  if (s.movePreview) strokeRect(ctx, rangeRect(l, vp, s.movePreview), '#5f6368', 3);
}

function drawCompare(ctx: CanvasRenderingContext2D, s: RenderState, cmp: CompareOverlay): void {
  const { layout: l, vp } = s;
  const right = Math.min(vp.width, colX(l, vp, l.cols.count - 1) + l.cols.size(l.cols.count - 1));
  for (const row of cmp.rows) {
    const color = CHANGE_COLORS[row.side];
    if (row.inBranch) {
      if (row.at >= l.rows.count || !l.rows.size(row.at)) continue;
      const y = rowY(l, vp, row.at);
      ctx.fillStyle = color.fill;
      ctx.fillRect(ROW_HEADER_W, y, right - ROW_HEADER_W, l.rows.size(row.at) - 1);
    } else {
      // A row that exists only on the other side: a bold line where it would be.
      const y = row.at < l.rows.count ? rowY(l, vp, row.at) : rowY(l, vp, l.rows.count - 1) + l.rows.size(l.rows.count - 1);
      ctx.fillStyle = color.solid;
      ctx.fillRect(ROW_HEADER_W, y - 2, right - ROW_HEADER_W, 3);
    }
  }
  for (const cell of cmp.cells) {
    const rr = cellRect(l, vp, cell.r, cell.c);
    if (rr.h === 0 || rr.x > vp.width || rr.y > vp.height || rr.x + rr.w < 0 || rr.y + rr.h < 0) continue;
    const color = CHANGE_COLORS[cell.side];
    ctx.fillStyle = color.fill;
    ctx.fillRect(rr.x, rr.y, rr.w - 1, rr.h - 1);
    strokeRect(ctx, rr, color.solid, 1);
  }
}

/** Colored markers in the row header for rows that differ. */
function drawCompareRowHeaders(ctx: CanvasRenderingContext2D, s: RenderState, cmp: CompareOverlay): void {
  const { layout: l, vp } = s;
  for (const row of cmp.rows) {
    const color = CHANGE_COLORS[row.side].solid;
    ctx.fillStyle = color;
    if (row.inBranch) {
      if (row.at >= l.rows.count || !l.rows.size(row.at)) continue;
      ctx.fillRect(0, rowY(l, vp, row.at), 4, l.rows.size(row.at) - 1);
    } else {
      const y = row.at < l.rows.count ? rowY(l, vp, row.at) : rowY(l, vp, l.rows.count - 1) + l.rows.size(l.rows.count - 1);
      ctx.beginPath();
      ctx.moveTo(0, y - 6);
      ctx.lineTo(8, y);
      ctx.lineTo(0, y + 6);
      ctx.fill();
      ctx.fillRect(0, y - 2, ROW_HEADER_W, 3);
    }
  }
}

export function filterButtonRect(l: Layout, vp: Viewport, f: FilterState, c: number): Rect {
  const cr = cellRect(l, vp, f.r1, c);
  return { x: cr.x + cr.w - 18, y: cr.y + Math.max(1, (cr.h - 16) / 2), w: 16, h: 16 };
}

function drawFilterButton(ctx: CanvasRenderingContext2D, s: RenderState, f: FilterState, c: number): void {
  const b = filterButtonRect(s.layout, s.vp, f, c);
  const cf = f.cols[c];
  const active = !!(cf && (cf.hidden?.length || (cf.cond && cf.cond.type !== 'none')));
  if (active) {
    ctx.fillStyle = C.filterActive;
    ctx.beginPath();
    ctx.arc(b.x + 8, b.y + 8, 8, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = active ? '#ffffff' : C.filterActive;
  ctx.fillRect(b.x + 3, b.y + 4, 10, 1.6);
  ctx.fillRect(b.x + 5, b.y + 7.5, 6, 1.6);
  ctx.fillRect(b.x + 7, b.y + 11, 2, 1.6);
}

function drawHeaders(ctx: CanvasRenderingContext2D, s: RenderState, rows: [number, number], cols: [number, number]): void {
  const { layout: l, vp, sel, tab } = s;
  const font = `${11}px ${FONT_FAMILY}`;
  ctx.font = font;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';

  const colState = (c: number): 0 | 1 | 2 => {
    let st: 0 | 1 | 2 = 0;
    for (const rg of sel.ranges) {
      if (c < rg.c1 || c > rg.c2) continue;
      if (rg.r1 === 0 && rg.r2 === tab.rows - 1) return 2;
      st = 1;
    }
    return st;
  };
  const rowState = (r: number): 0 | 1 | 2 => {
    let st: 0 | 1 | 2 = 0;
    for (const rg of sel.ranges) {
      if (r < rg.r1 || r > rg.r2) continue;
      if (rg.c1 === 0 && rg.c2 === tab.cols - 1) return 2;
      st = 1;
    }
    return st;
  };

  // Column headers
  const colSets: [number, number, Rect][] = [
    [cols[0], cols[1], { x: ROW_HEADER_W + l.frozenW, y: 0, w: vp.width, h: COL_HEADER_H }],
  ];
  if (l.frozenCols) colSets.push([0, l.frozenCols - 1, { x: ROW_HEADER_W, y: 0, w: l.frozenW, h: COL_HEADER_H }]);
  for (const [a, b, clip] of colSets) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(clip.x, clip.y, clip.w, clip.h);
    ctx.clip();
    ctx.fillStyle = C.headerBg;
    ctx.fillRect(clip.x, 0, clip.w, COL_HEADER_H);
    for (let c = a; c <= b; c++) {
      const x = colX(l, vp, c);
      const w = l.cols.size(c);
      const st = colState(c);
      if (st) {
        ctx.fillStyle = st === 2 ? C.headerFullBg : C.headerSelBg;
        ctx.fillRect(x, 0, w, COL_HEADER_H);
      }
      ctx.fillStyle = st === 2 ? C.headerFullText : st ? C.headerSelText : C.headerText;
      ctx.font = st ? `bold ${font}` : font;
      ctx.fillText(colToName(c), x + w / 2, COL_HEADER_H / 2 + 1);
      ctx.fillStyle = C.headerBorder;
      ctx.fillRect(Math.floor(x + w) - 1, 0, 1, COL_HEADER_H);
    }
    ctx.restore();
  }

  // Row headers
  const rowSets: [number, number, Rect][] = [
    [rows[0], rows[1], { x: 0, y: COL_HEADER_H + l.frozenH, w: ROW_HEADER_W, h: vp.height }],
  ];
  if (l.frozenRows) rowSets.push([0, l.frozenRows - 1, { x: 0, y: COL_HEADER_H, w: ROW_HEADER_W, h: l.frozenH }]);
  for (const [a, b, clip] of rowSets) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(clip.x, clip.y, clip.w, clip.h);
    ctx.clip();
    ctx.fillStyle = C.headerBg;
    ctx.fillRect(0, clip.y, ROW_HEADER_W, clip.h);
    for (let r = a; r <= b; r++) {
      const h = l.rows.size(r);
      if (!h) continue;
      const y = rowY(l, vp, r);
      const st = rowState(r);
      if (st) {
        ctx.fillStyle = st === 2 ? C.headerFullBg : C.headerSelBg;
        ctx.fillRect(0, y, ROW_HEADER_W, h);
      }
      ctx.fillStyle = st === 2 ? C.headerFullText : st ? C.headerSelText : C.headerText;
      ctx.font = st ? `bold ${font}` : font;
      ctx.fillText(String(r + 1), ROW_HEADER_W / 2, y + h / 2 + 1);
      ctx.fillStyle = C.headerBorder;
      ctx.fillRect(0, Math.floor(y + h) - 1, ROW_HEADER_W, 1);
      // Mark hidden (filtered) rows below this one
      if (r + 1 < l.rows.count && l.rows.size(r + 1) === 0) {
        ctx.fillStyle = C.filterBorder;
        ctx.fillRect(0, Math.floor(y + h) - 2, ROW_HEADER_W, 2);
      }
    }
    ctx.restore();
  }

  if (s.compare) {
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, COL_HEADER_H, ROW_HEADER_W, vp.height);
    ctx.clip();
    drawCompareRowHeaders(ctx, s, s.compare);
    ctx.restore();
  }

  // Header borders & corner
  ctx.fillStyle = C.headerBorder;
  ctx.fillRect(0, COL_HEADER_H - 1, vp.width, 1);
  ctx.fillRect(ROW_HEADER_W - 1, 0, 1, vp.height);
  ctx.fillStyle = C.headerBg;
  ctx.fillRect(0, 0, ROW_HEADER_W - 1, COL_HEADER_H - 1);
  ctx.fillStyle = C.headerBorder;
  ctx.beginPath();
  ctx.moveTo(ROW_HEADER_W - 4, COL_HEADER_H - 12);
  ctx.lineTo(ROW_HEADER_W - 4, COL_HEADER_H - 4);
  ctx.lineTo(ROW_HEADER_W - 12, COL_HEADER_H - 4);
  ctx.fill();
  ctx.textAlign = 'left';
}
