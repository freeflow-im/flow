import { cellKey, parseCellKey, type Range } from '../../../shared/cellref.ts';
import { adjustCharts, type ChartChange } from '../../../shared/chart.ts';
import { adjustForDelete, adjustForInsert, adjustForMove, isFormula, moveIndexMap, moveSpan, renameSheetRefs, shiftFormula } from '../../../shared/formula/adjust.ts';
import type { CellData, CellStyle, FilterCondition, FilterState, Tab } from '../../../shared/types.ts';
import { hasContent, newTab } from '../../../shared/types.ts';
import {
  CellError,
  formatDate,
  formatTime,
  parseLiteral,
  type Scalar,
} from '../../../shared/values.ts';
import type { Tx, WorkbookStore } from './store.ts';

export type Axis = 'row' | 'col';

// ---------------------------------------------------------------------------
// Cell content & style

export function setInput(tx: Tx, tabId: string, r: number, c: number, raw: string): void {
  const existing = tx.tab(tabId).cells[cellKey(r, c)];
  tx.setCellAt(tabId, r, c, raw === '' && !existing?.st ? undefined : { v: raw, ...(existing?.st ? { st: existing.st } : {}) });
}

/** Put an image in a cell (replacing its value), or remove the image with `src` undefined. Keeps the cell's formatting. */
export function setImage(tx: Tx, tabId: string, r: number, c: number, src: string | undefined): void {
  const existing = tx.tab(tabId).cells[cellKey(r, c)];
  const st = existing?.st ? { st: existing.st } : {};
  tx.setCellAt(tabId, r, c, src ? { v: '', img: src, ...st } : existing ? { v: existing.v, ...st } : undefined);
}

/** Keys of existing cells inside a range (efficient for huge, sparse ranges). */
export function existingKeysIn(tab: Tab, rg: Range): { key: string; r: number; c: number }[] {
  const out: { key: string; r: number; c: number }[] = [];
  const area = (rg.r2 - rg.r1 + 1) * (rg.c2 - rg.c1 + 1);
  if (area > Object.keys(tab.cells).length) {
    for (const key in tab.cells) {
      const p = parseCellKey(key);
      if (p && p.r >= rg.r1 && p.r <= rg.r2 && p.c >= rg.c1 && p.c <= rg.c2) out.push({ key, ...p });
    }
  } else {
    for (let r = rg.r1; r <= rg.r2; r++)
      for (let c = rg.c1; c <= rg.c2; c++) {
        const key = cellKey(r, c);
        if (tab.cells[key]) out.push({ key, r, c });
      }
  }
  return out;
}

export function clearContents(tx: Tx, tabId: string, ranges: Range[]): void {
  const tab = tx.tab(tabId);
  for (const rg of ranges) {
    for (const { key } of existingKeysIn(tab, rg)) {
      const cell = tab.cells[key];
      tx.setCell(tabId, key, cell.st ? { v: '', st: cell.st } : undefined);
    }
  }
}

function mergeStyle(st: CellStyle | undefined, patch: Partial<CellStyle>): CellStyle | undefined {
  const out: Record<string, unknown> = { ...(st ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === false || v === null) delete out[k];
    else out[k] = v;
  }
  return Object.keys(out).length ? (out as CellStyle) : undefined;
}

export function applyStyle(tx: Tx, tabId: string, ranges: Range[], patch: Partial<CellStyle>): void {
  const tab = tx.tab(tabId);
  for (const rg of ranges) {
    for (let r = rg.r1; r <= rg.r2; r++)
      for (let c = rg.c1; c <= rg.c2; c++) {
        const key = cellKey(r, c);
        const cell = tab.cells[key];
        const st = mergeStyle(cell?.st, patch);
        tx.setCell(tabId, key, cell || st ? { v: cell?.v ?? '', ...(cell?.img ? { img: cell.img } : {}), ...(st ? { st } : {}) } : undefined);
      }
  }
}

export function clearFormatting(tx: Tx, tabId: string, ranges: Range[]): void {
  const tab = tx.tab(tabId);
  for (const rg of ranges) {
    for (const { key } of existingKeysIn(tab, rg)) {
      const cell = tab.cells[key];
      if (cell.st) tx.setCell(tabId, key, hasContent(cell) ? { v: cell.v, ...(cell.img ? { img: cell.img } : {}) } : undefined);
    }
  }
}

// ---------------------------------------------------------------------------
// Row / column insert & delete

function shiftSizes(sizes: Record<string, number>, map: (i: number) => number | null): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(sizes)) {
    const n = map(+k);
    if (n !== null) out[n] = v;
  }
  return out;
}

function rebuildTabs(
  tx: Tx,
  tabId: string,
  axis: Axis,
  mapIndex: (i: number) => number | null,
  adjust: (raw: string, ownSheet: string, targetSheet: string) => string,
  transformTarget: (t: Tab) => Partial<Tab>,
  chartChange?: ChartChange,
): void {
  const target = tx.tab(tabId);
  const newTabs = tx.workbook.tabs.map((t) => {
    const isTarget = t.id === tabId;
    let changed = isTarget;
    // Charts' ranges follow the data as formulas do, and the target tab's charts stay over their cells.
    const charts = chartChange ? adjustCharts(t.charts, t, chartChange, mapIndex) : t.charts;
    if (charts !== t.charts && JSON.stringify(charts) !== JSON.stringify(t.charts)) changed = true;
    const cells: Record<string, CellData> = {};
    for (const key in t.cells) {
      const cell = t.cells[key];
      let nk: string | null = key;
      if (isTarget) {
        const p = parseCellKey(key)!;
        const idx = mapIndex(axis === 'row' ? p.r : p.c);
        nk = idx === null ? null : axis === 'row' ? cellKey(idx, p.c) : cellKey(p.r, idx);
      }
      if (nk === null) continue;
      let next = cell;
      if (isFormula(cell.v)) {
        const v = adjust(cell.v, t.name, target.name);
        if (v !== cell.v) {
          next = { ...cell, v };
          changed = true;
        }
      }
      cells[nk] = next;
    }
    if (!changed) return t;
    const withCharts = charts ? { charts } : {};
    return isTarget ? { ...t, cells, ...withCharts, ...transformTarget(t) } : { ...t, cells, ...withCharts };
  });
  tx.setTabs(newTabs);
}

function adjustFilter(f: FilterState | undefined, axis: Axis, mapIndex: (i: number) => number | null, deleted?: [number, number]): FilterState | undefined {
  if (!f) return f;
  const [a, b] = axis === 'row' ? [f.r1, f.r2] : [f.c1, f.c2];
  let na: number | null;
  let nb: number | null;
  if (deleted) {
    const [d1, d2] = deleted;
    if (axis === 'row' && f.r1 >= d1 && f.r1 <= d2) return undefined; // header row deleted
    na = a > d2 ? a - (d2 - d1 + 1) : a >= d1 ? d1 : a;
    nb = b > d2 ? b - (d2 - d1 + 1) : b >= d1 ? d1 - 1 : b;
    if (nb < na) return undefined;
  } else {
    na = mapIndex(a);
    nb = mapIndex(b);
    if (na === null || nb === null) return undefined;
  }
  if (axis === 'row') return { ...f, r1: na, r2: nb! };
  const cols: FilterState['cols'] = {};
  for (const [k, v] of Object.entries(f.cols)) {
    const n = mapIndex(+k);
    if (n !== null) cols[n] = v;
  }
  return { ...f, c1: na, c2: nb!, cols };
}

export function insertLines(tx: Tx, tabId: string, axis: Axis, at: number, count: number): void {
  const map = (i: number) => (i >= at ? i + count : i);
  rebuildTabs(
    tx,
    tabId,
    axis,
    map,
    (raw, own, target) => adjustForInsert(raw, own, target, axis, at, count),
    (t) =>
      axis === 'row'
        ? {
            rows: t.rows + count,
            rowHeights: shiftSizes(t.rowHeights, map),
            filter: adjustFilter(t.filter, 'row', map),
            frozenRows: t.frozenRows && at < t.frozenRows ? t.frozenRows + count : t.frozenRows,
          }
        : {
            cols: t.cols + count,
            colWidths: shiftSizes(t.colWidths, map),
            filter: adjustFilter(t.filter, 'col', map),
            frozenCols: t.frozenCols && at < t.frozenCols ? t.frozenCols + count : t.frozenCols,
          },
    { kind: 'insert', tab: tx.tab(tabId).name, axis, at, count },
  );
}

export function deleteLines(tx: Tx, tabId: string, axis: Axis, from: number, to: number): void {
  const tab = tx.tab(tabId);
  const total = axis === 'row' ? tab.rows : tab.cols;
  if (to - from + 1 >= total) to = total - 2; // always keep at least one row/column
  if (to < from) return;
  const n = to - from + 1;
  const map = (i: number) => (i < from ? i : i > to ? i - n : null);
  const frozen = (f: number | undefined) => (f === undefined ? f : f <= from ? f : Math.max(from, f - n));
  rebuildTabs(
    tx,
    tabId,
    axis,
    map,
    (raw, own, target) => adjustForDelete(raw, own, target, axis, from, to),
    (t) =>
      axis === 'row'
        ? {
            rows: t.rows - n,
            rowHeights: shiftSizes(t.rowHeights, map),
            filter: adjustFilter(t.filter, 'row', map, [from, to]),
            frozenRows: frozen(t.frozenRows),
          }
        : {
            cols: t.cols - n,
            colWidths: shiftSizes(t.colWidths, map),
            filter: adjustFilter(t.filter, 'col', map, [from, to]),
            frozenCols: frozen(t.frozenCols),
          },
    { kind: 'delete', tab: tab.name, axis, from, to },
  );
}

/**
 * Move columns [from, to] so they sit immediately left of column `before` (an index in the current layout;
 * `before` may equal the column count to move to the end). Columns in between shift over. Cells, formatting,
 * widths and filter criteria travel with their column; references across the workbook are rewritten to keep
 * pointing at the same data. Returns the moved block's new first column, or null if nothing moves.
 */
export function moveColumns(tx: Tx, tabId: string, from: number, to: number, before: number): number | null {
  const tab = tx.tab(tabId);
  if (from < 0 || to < from || to >= tab.cols || before < 0 || before > tab.cols) return null;
  if (before >= from && before <= to + 1) return null;
  const mv = { from, to, before };
  const map = moveIndexMap(mv);
  rebuildTabs(
    tx,
    tabId,
    'col',
    map,
    (raw, own, target) => adjustForMove(raw, own, target, 'col', mv),
    (t) => {
      let filter = t.filter;
      if (filter) {
        const [c1, c2] = moveSpan(filter.c1, filter.c2, mv);
        const cols: FilterState['cols'] = {};
        for (const [k, v] of Object.entries(filter.cols)) {
          const c = map(+k);
          if (c >= c1 && c <= c2) cols[c] = v;
        }
        filter = { ...filter, c1, c2, cols };
      }
      return { colWidths: shiftSizes(t.colWidths, map), filter };
    },
    { kind: 'move', tab: tab.name, axis: 'col', move: mv },
  );
  return map(from);
}

export function appendRows(tx: Tx, tabId: string, count: number): void {
  const tab = tx.tab(tabId);
  tx.setTabProp(tabId, 'rows', tab.rows + count);
}

// ---------------------------------------------------------------------------
// Sorting

function sortRank(v: Scalar): number {
  if (v === null || v === '') return 4;
  if (typeof v === 'number') return 0;
  if (typeof v === 'string') return 1;
  if (typeof v === 'boolean') return 2;
  return 3;
}

export function compareForSort(a: Scalar, b: Scalar, asc: boolean): number {
  const ra = sortRank(a);
  const rb = sortRank(b);
  if (ra === 4 || rb === 4) return ra - rb; // blanks always last
  let cmp: number;
  if (ra !== rb) cmp = ra - rb;
  else if (typeof a === 'number') cmp = a - (b as number);
  else if (typeof a === 'string') cmp = a.localeCompare(b as string, undefined, { sensitivity: 'base', numeric: true });
  else if (typeof a === 'boolean') cmp = Number(a) - Number(b);
  else cmp = (a as CellError).code.localeCompare((b as CellError).code);
  return asc ? cmp : -cmp;
}

/** Sort the rows of `range` by the values in column `col`. Formulas move with their row. */
export function sortRange(tx: Tx, store: WorkbookStore<unknown>, tabId: string, range: Range, col: number, asc: boolean): void {
  const tab = tx.tab(tabId);
  const n = range.r2 - range.r1 + 1;
  const keys = Array.from({ length: n }, (_, i) => store.value(tabId, range.r1 + i, col));
  const perm = Array.from({ length: n }, (_, i) => i).sort((a, b) => compareForSort(keys[a], keys[b], asc) || a - b);
  const snapshot: (CellData | undefined)[][] = [];
  for (let i = 0; i < n; i++) {
    const row: (CellData | undefined)[] = [];
    for (let c = range.c1; c <= range.c2; c++) row.push(tab.cells[cellKey(range.r1 + i, c)]);
    snapshot.push(row);
  }
  for (let i = 0; i < n; i++) {
    const src = perm[i];
    if (src === i) continue;
    for (let j = 0; j <= range.c2 - range.c1; j++) {
      const cell = snapshot[src][j];
      const moved = cell && isFormula(cell.v) ? { ...cell, v: shiftFormula(cell.v, i - src, 0) } : cell;
      tx.setCellAt(tabId, range.r1 + i, range.c1 + j, moved);
    }
  }
}

// ---------------------------------------------------------------------------
// Fill (drag the fill handle)

type Series =
  | { kind: 'linear'; a: number; b: number; lit: ReturnType<typeof parseLiteral> }
  | { kind: 'text'; prefix: string; start: number; width: number }
  | { kind: 'copy' };

function analyzeSeries(seq: (CellData | undefined)[]): Series {
  const lits = seq.map((c) => (c && c.v !== '' && !isFormula(c.v) ? parseLiteral(c.v) : null));
  if (lits.every((l) => l && typeof l.value === 'number')) {
    const ys = lits.map((l) => l!.value as number);
    const m = ys.length;
    const lit = lits[0]!;
    const isDate = lit.fmt === 'date' || lit.fmt === 'datetime';
    if (m === 1) return isDate ? { kind: 'linear', a: ys[0], b: 1, lit } : { kind: 'copy' };
    const xm = (m - 1) / 2;
    const ym = ys.reduce((s, y) => s + y, 0) / m;
    let num = 0;
    let den = 0;
    ys.forEach((y, x) => {
      num += (x - xm) * (y - ym);
      den += (x - xm) ** 2;
    });
    const b = num / den;
    return { kind: 'linear', a: ym - b * xm, b, lit };
  }
  if (seq.length === 1 && seq[0] && !isFormula(seq[0].v)) {
    const m = /^(.*?)(\d+)$/.exec(seq[0].v);
    if (m && m[1] !== '') return { kind: 'text', prefix: m[1], start: +m[2], width: m[2].length };
  }
  return { kind: 'copy' };
}

function rawForNumber(v: number, lit: ReturnType<typeof parseLiteral>): string {
  const clean = Number(v.toPrecision(12));
  switch (lit.fmt) {
    case 'date':
      return formatDate(clean);
    case 'datetime':
      return `${formatDate(clean)} ${formatTime(clean)}`;
    case 'percent':
      return `${Number((clean * 100).toPrecision(12))}%`;
    case 'currency':
      return clean < 0 ? `-$${-clean}` : `$${clean}`;
    default:
      return String(clean);
  }
}

/**
 * Fill `target` (which contains `src` and extends it along one axis) from the source cells.
 * Numbers/dates continue their linear trend, "Item 1" increments, formulas shift relatively.
 */
export function fillRange(tx: Tx, tabId: string, src: Range, target: Range): void {
  const tab = tx.tab(tabId);
  const vertical = target.c1 === src.c1 && target.c2 === src.c2;
  const lines = vertical ? [src.c1, src.c2] : [src.r1, src.r2];
  const [t1, t2] = vertical ? [target.r1, target.r2] : [target.c1, target.c2];
  const [s1, s2] = vertical ? [src.r1, src.r2] : [src.c1, src.c2];
  const m = s2 - s1 + 1;
  for (let line = lines[0]; line <= lines[1]; line++) {
    const seq: (CellData | undefined)[] = [];
    for (let i = s1; i <= s2; i++) seq.push(tab.cells[vertical ? cellKey(i, line) : cellKey(line, i)]);
    const series = analyzeSeries(seq);
    for (let pos = t1; pos <= t2; pos++) {
      if (pos >= s1 && pos <= s2) continue;
      const p = pos - s1;
      const idx = ((p % m) + m) % m;
      const base = seq[idx];
      const [r, c] = vertical ? [pos, line] : [line, pos];
      if (!base) {
        tx.setCellAt(tabId, r, c, undefined);
        continue;
      }
      let v = base.v;
      if (isFormula(v)) {
        const d = p - idx;
        v = vertical ? shiftFormula(v, d, 0) : shiftFormula(v, 0, d);
      } else if (series.kind === 'linear') {
        v = rawForNumber(series.a + series.b * p, series.lit);
      } else if (series.kind === 'text') {
        const n = series.start + p;
        v = n < 0 ? base.v : series.prefix + String(n).padStart(series.width, '0');
      }
      tx.setCellAt(tabId, r, c, { v, ...(base.st ? { st: base.st } : {}) });
    }
  }
}

// ---------------------------------------------------------------------------
// Clipboard / move

export interface ClipData {
  /** Cells relative to the source top-left. */
  cells: (CellData | undefined)[][];
  /** Where the data was copied from (internal copies only), used to shift formulas. */
  origin?: { tabId: string; r: number; c: number };
}

/**
 * Paste clipboard data at the selection. If the selection is an exact multiple of the clip size the data is tiled.
 * Returns the range written.
 */
export function pasteClip(tx: Tx, tabId: string, sel: Range, clip: ClipData, opts: { valuesOnly?: (cell: CellData, r: number, c: number) => string } = {}): Range {
  const tab = tx.tab(tabId);
  const h = clip.cells.length;
  const w = Math.max(1, ...clip.cells.map((r) => r.length));
  const selH = sel.r2 - sel.r1 + 1;
  const selW = sel.c2 - sel.c1 + 1;
  const tileR = selH % h === 0 && selW % w === 0 ? selH / h : 1;
  const tileC = selH % h === 0 && selW % w === 0 ? selW / w : 1;
  const outH = h * tileR;
  const outW = w * tileC;
  if (sel.r1 + outH > tab.rows) tx.setTabProp(tabId, 'rows', sel.r1 + outH);
  if (sel.c1 + outW > tab.cols) tx.setTabProp(tabId, 'cols', sel.c1 + outW);
  for (let i = 0; i < outH; i++) {
    for (let j = 0; j < outW; j++) {
      const r = sel.r1 + i;
      const c = sel.c1 + j;
      const src = clip.cells[i % h]?.[j % w];
      if (!src) {
        tx.setCellAt(tabId, r, c, undefined);
        continue;
      }
      let v = src.v;
      if (opts.valuesOnly && clip.origin) {
        v = opts.valuesOnly(src, clip.origin.r + (i % h), clip.origin.c + (j % w));
        const existing = tab.cells[cellKey(r, c)];
        tx.setCellAt(tabId, r, c, { v, ...(existing?.st ? { st: existing.st } : {}) });
        continue;
      }
      if (clip.origin && isFormula(v)) v = shiftFormula(v, r - (clip.origin.r + (i % h)), c - (clip.origin.c + (j % w)));
      if (!clip.origin) {
        // External text: keep the destination's formatting.
        const existing = tab.cells[cellKey(r, c)];
        tx.setCellAt(tabId, r, c, v === '' && !existing?.st ? undefined : { v, ...(existing?.st ? { st: existing.st } : {}) });
      } else {
        tx.setCellAt(tabId, r, c, { ...src, v });
      }
    }
  }
  return { r1: sel.r1, c1: sel.c1, r2: sel.r1 + outH - 1, c2: sel.c1 + outW - 1 };
}

export function readClip(tab: Tab, rg: Range, skipRows?: Set<number>): ClipData {
  const cells: (CellData | undefined)[][] = [];
  for (let r = rg.r1; r <= rg.r2; r++) {
    if (skipRows?.has(r)) continue;
    const row: (CellData | undefined)[] = [];
    for (let c = rg.c1; c <= rg.c2; c++) row.push(tab.cells[cellKey(r, c)]);
    cells.push(row);
  }
  return { cells, origin: { tabId: tab.id, r: rg.r1, c: rg.c1 } };
}

/** Move a block of cells (drag-and-drop or cut/paste). Formulas inside the block keep pointing at the same cells. */
export function moveRange(tx: Tx, srcTabId: string, src: Range, destTabId: string, destR: number, destC: number): Range {
  const srcTab = tx.tab(srcTabId);
  const snapshot = readClip(srcTab, src);
  for (const { key } of existingKeysIn(srcTab, src)) tx.setCell(srcTabId, key, undefined);
  const dest: Range = { r1: destR, c1: destC, r2: destR + (src.r2 - src.r1), c2: destC + (src.c2 - src.c1) };
  const destTab = tx.tab(destTabId);
  if (dest.r2 >= destTab.rows) tx.setTabProp(destTabId, 'rows', dest.r2 + 1);
  if (dest.c2 >= destTab.cols) tx.setTabProp(destTabId, 'cols', dest.c2 + 1);
  snapshot.cells.forEach((row, i) =>
    row.forEach((cell, j) => {
      tx.setCellAt(destTabId, destR + i, destC + j, cell);
    }),
  );
  return dest;
}

// ---------------------------------------------------------------------------
// Filters

function numericOf(s: string): number | null {
  const lit = parseLiteral(s.trim());
  return typeof lit.value === 'number' ? lit.value : null;
}

export function matchesCondition(cond: FilterCondition, display: string, value: Scalar): boolean {
  const text = display.toLowerCase();
  const arg = (cond.value ?? '').toLowerCase();
  switch (cond.type) {
    case 'none':
      return true;
    case 'empty':
      return display === '';
    case 'notEmpty':
      return display !== '';
    case 'contains':
      return text.includes(arg);
    case 'notContains':
      return !text.includes(arg);
    case 'startsWith':
      return text.startsWith(arg);
    case 'endsWith':
      return text.endsWith(arg);
    case 'eq':
    case 'neq': {
      const n = numericOf(cond.value ?? '');
      const eq = n !== null && typeof value === 'number' ? Math.abs(value - n) < 1e-9 : text === arg;
      return cond.type === 'eq' ? eq : !eq;
    }
    default: {
      const n = numericOf(cond.value ?? '');
      if (n === null || typeof value !== 'number') return false;
      switch (cond.type) {
        case 'gt':
          return value > n;
        case 'gte':
          return value >= n;
        case 'lt':
          return value < n;
        default:
          return value <= n;
      }
    }
  }
}

/** Rows hidden by the tab's filter. */
export function computeHiddenRows(store: WorkbookStore<unknown>, tab: Tab): Set<number> {
  const hidden = new Set<number>();
  const f = tab.filter;
  if (!f) return hidden;
  const active = Object.entries(f.cols).filter(([, cf]) => cf.hidden?.length || (cf.cond && cf.cond.type !== 'none'));
  if (!active.length) return hidden;
  const hiddenSets = active.map(([c, cf]) => ({ c: +c, set: new Set(cf.hidden ?? []), cond: cf.cond }));
  for (let r = f.r1 + 1; r <= f.r2; r++) {
    for (const { c, set, cond } of hiddenSets) {
      const display = store.display(tab.id, r, c);
      if (set.has(display) || (cond && !matchesCondition(cond, display, store.value(tab.id, r, c)))) {
        hidden.add(r);
        break;
      }
    }
  }
  return hidden;
}

/** Expand from a cell to the surrounding block of non-empty cells (like Ctrl+A's "current region"). */
export function detectDataRegion(tab: Tab, r: number, c: number): Range {
  const has = (rr: number, cc: number) => rr >= 0 && cc >= 0 && hasContent(tab.cells[cellKey(rr, cc)]);
  const rg = { r1: r, c1: c, r2: r, c2: c };
  let grew = true;
  while (grew) {
    grew = false;
    const rowHas = (rr: number) => {
      for (let cc = rg.c1 - 1; cc <= rg.c2 + 1; cc++) if (has(rr, cc)) return true;
      return false;
    };
    const colHas = (cc: number) => {
      for (let rr = rg.r1 - 1; rr <= rg.r2 + 1; rr++) if (has(rr, cc)) return true;
      return false;
    };
    if (rg.r1 > 0 && rowHas(rg.r1 - 1)) (rg.r1--, (grew = true));
    if (rg.r2 < tab.rows - 1 && rowHas(rg.r2 + 1)) (rg.r2++, (grew = true));
    if (rg.c1 > 0 && colHas(rg.c1 - 1)) (rg.c1--, (grew = true));
    if (rg.c2 < tab.cols - 1 && colHas(rg.c2 + 1)) (rg.c2++, (grew = true));
  }
  return rg;
}

// ---------------------------------------------------------------------------
// Tabs

export function uniqueTabName(tabs: Tab[], base: string): string {
  const names = new Set(tabs.map((t) => t.name.toLowerCase()));
  if (!names.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) {
    const n = `${base} ${i}`;
    if (!names.has(n.toLowerCase())) return n;
  }
}

function nextSheetName(tabs: Tab[]): string {
  const names = new Set(tabs.map((t) => t.name.toLowerCase()));
  for (let i = tabs.length + 1; ; i++) if (!names.has(`sheet${i}`)) return `Sheet${i}`;
}

export function addTab(tx: Tx, afterIndex: number): string {
  const id = crypto.randomUUID();
  const tabs = [...tx.workbook.tabs];
  tabs.splice(afterIndex + 1, 0, newTab(id, nextSheetName(tabs)));
  tx.setTabs(tabs);
  return id;
}

export function duplicateTab(tx: Tx, tabId: string): string {
  const src = tx.tab(tabId);
  const copy: Tab = JSON.parse(JSON.stringify(src));
  copy.id = crypto.randomUUID();
  copy.name = uniqueTabName(tx.workbook.tabs, `Copy of ${src.name}`);
  // The copy's charts are its own (their ranges on the tab are the copy's, as its formulas' are).
  if (copy.charts) copy.charts = copy.charts.map((c) => ({ ...c, id: crypto.randomUUID() }));
  const tabs = [...tx.workbook.tabs];
  tabs.splice(tabs.indexOf(src) + 1, 0, copy);
  tx.setTabs(tabs);
  return copy.id;
}

export function deleteTab(tx: Tx, tabId: string): void {
  if (tx.workbook.tabs.length <= 1) return;
  tx.setTabs(tx.workbook.tabs.filter((t) => t.id !== tabId));
}

export function moveTab(tx: Tx, from: number, to: number): void {
  const tabs = [...tx.workbook.tabs];
  const [t] = tabs.splice(from, 1);
  tabs.splice(to, 0, t);
  tx.setTabs(tabs);
}

/**
 * Append tabs from another workbook (e.g. an Excel import) after the existing ones.
 * Names that clash with existing tabs are made unique, and references between the incoming tabs are rewritten
 * to follow the renames. Returns the new tab ids and the renames applied.
 */
export function appendTabs(tx: Tx, incoming: Tab[]): { ids: string[]; renamed: { from: string; to: string }[] } {
  const existing = tx.workbook.tabs;
  // Reserve incoming names too, so a generated name never collides with another incoming tab.
  const reserved = [...existing, ...incoming];
  const renames = new Map<string, string>();
  const renamed: { from: string; to: string }[] = [];
  for (const t of incoming) {
    if (!existing.some((e) => e.name.toLowerCase() === t.name.toLowerCase())) continue;
    const to = uniqueTabName(reserved, t.name);
    reserved.push({ ...t, name: to });
    renames.set(t.name, to);
    renamed.push({ from: t.name, to });
  }
  const added = incoming.map((t): Tab => {
    let cells = t.cells;
    if (renames.size) {
      cells = {};
      for (const [key, cell] of Object.entries(t.cells)) {
        let v = cell.v;
        if (isFormula(v)) for (const [from, to] of renames) v = renameSheetRefs(v, from, to);
        cells[key] = v === cell.v ? cell : { ...cell, v };
      }
    }
    let charts = t.charts;
    for (const [from, to] of renames) charts = adjustCharts(charts, t, { kind: 'rename', from, to });
    return { ...t, id: crypto.randomUUID(), name: renames.get(t.name) ?? t.name, cells, ...(charts ? { charts } : {}) };
  });
  tx.setTabs([...existing, ...added]);
  return { ids: added.map((t) => t.id), renamed };
}

export function validateTabName(tabs: Tab[], tabId: string, name: string): string | null {
  const n = name.trim();
  if (!n) return 'Name cannot be empty.';
  if (n.length > 100) return 'Name is too long.';
  if (/[[\]*?/\\:]/.test(n)) return 'Name cannot contain [ ] * ? / \\ :';
  if (tabs.some((t) => t.id !== tabId && t.name.toLowerCase() === n.toLowerCase())) return `A sheet named "${n}" already exists.`;
  return null;
}

export function renameTab(tx: Tx, tabId: string, name: string): void {
  const tab = tx.tab(tabId);
  const old = tab.name;
  if (old === name) return;
  for (const t of tx.workbook.tabs) {
    for (const key in t.cells) {
      const cell = t.cells[key];
      if (!isFormula(cell.v)) continue;
      const v = renameSheetRefs(cell.v, old, name);
      if (v !== cell.v) tx.setCell(t.id, key, { ...cell, v });
    }
    const charts = adjustCharts(t.charts, t, { kind: 'rename', from: old, to: name });
    if (charts && JSON.stringify(charts) !== JSON.stringify(t.charts)) tx.setTabProp(t.id, 'charts', charts);
  }
  tx.setTabProp(tabId, 'name', name);
}

/**
 * The block of data around a cell, as Ctrl-A or a chart of one cell takes it: the cell's range grown in every
 * direction while the row or column next to it (including the corners) has something in it.
 */
export function dataRegion(tab: Tab, r: number, c: number): Range {
  const filled = (rr: number, cc: number) => rr >= 0 && cc >= 0 && rr < tab.rows && cc < tab.cols && !!tab.cells[cellKey(rr, cc)]?.v;
  const rg = { r1: r, c1: c, r2: r, c2: c };
  const lineFilled = (fixed: number, from: number, to: number, isRow: boolean) => {
    for (let i = from; i <= to; i++) if (isRow ? filled(fixed, i) : filled(i, fixed)) return true;
    return false;
  };
  for (let grew = true, guard = 0; grew && guard < 100_000; guard++) {
    grew = false;
    if (lineFilled(rg.r1 - 1, rg.c1 - 1, rg.c2 + 1, true)) (rg.r1--, (grew = true));
    if (lineFilled(rg.r2 + 1, rg.c1 - 1, rg.c2 + 1, true)) (rg.r2++, (grew = true));
    if (lineFilled(rg.c1 - 1, rg.r1 - 1, rg.r2 + 1, false)) (rg.c1--, (grew = true));
    if (lineFilled(rg.c2 + 1, rg.r1 - 1, rg.r2 + 1, false)) (rg.c2++, (grew = true));
    rg.r1 = Math.max(0, rg.r1);
    rg.c1 = Math.max(0, rg.c1);
    rg.r2 = Math.min(tab.rows - 1, rg.r2);
    rg.c2 = Math.min(tab.cols - 1, rg.c2);
  }
  return rg;
}
