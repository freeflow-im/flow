// Tables on slides (TableElement in shared/deck.ts): building one, adding and removing rows and columns, and
// the colors and look of each cell, which the slide renderer and the PowerPoint writer both draw from so a
// table looks the same on the slide and in the file.
import type { TableCell, TableElement, TableSource, Theme } from './deck.ts';

/** Default font size of a table's text, in points. */
export const TABLE_SIZE = 16;
/** Space between a cell's border and its text, in points. */
export const TABLE_PAD = { x: 10, y: 6 };
/** Height a new table gives each row, in points. */
export const TABLE_ROW_H = 40;

export type NewTable = Omit<TableElement, 'id'>;

/** An empty table of `rows` × `cols`, with a header row, centered on a 960×540 slide unless a box is given. */
export function newTable(rows: number, cols: number, box?: { x: number; y: number; w: number; h: number }): NewTable {
  const w = box?.w ?? Math.min(840, cols * 160);
  const h = box?.h ?? rows * TABLE_ROW_H;
  return {
    type: 'table',
    x: box?.x ?? Math.round((960 - w) / 2),
    y: box?.y ?? Math.max(20, Math.round((540 - h) / 2)),
    w,
    h,
    rows: Array.from({ length: rows }, () => Array.from({ length: cols }, () => ({ text: '' }))),
    header: true,
  };
}

/** Cells from rows of texts, padded with empty cells to the longest row. */
export function cellsFromTexts(texts: string[][]): TableCell[][] {
  const n = Math.max(1, ...texts.map((r) => r.length));
  return texts.map((r) => Array.from({ length: n }, (_, c) => ({ text: r[c] ?? '' })));
}

export function columnCount(el: TableElement): number {
  return el.rows[0]?.length ?? 0;
}

/** Column widths as shares of the table's width (equal unless set). */
export function colShares(el: TableElement): number[] {
  const n = columnCount(el);
  return el.cols?.length === n ? el.cols : Array.from({ length: n }, () => 1 / n);
}

/** Shares scaled to add up to 1, rounded to keep the file small; undefined when they are all equal. */
export function normalShares(shares: number[]): number[] | undefined {
  const total = shares.reduce((a, b) => a + b, 0) || 1;
  const out = shares.map((w) => Math.max(0.001, Math.round((w / total) * 10000) / 10000));
  return out.every((w) => Math.abs(w - out[0]) < 0.0005) ? undefined : out;
}

function withCols(el: TableElement, shares: number[]): TableElement {
  const next = { ...el };
  const cols = normalShares(shares);
  if (cols) next.cols = cols;
  else delete next.cols;
  return next;
}

/** Insert `count` empty rows before row `at` (0 to the row count); the box grows by a row's height each. */
export function insertRows(el: TableElement, at: number, count = 1): TableElement {
  const n = columnCount(el);
  const rowH = el.h / el.rows.length;
  const i = Math.max(0, Math.min(at, el.rows.length));
  // A new row takes the look of the row it is next to (its fills and alignment), without its text.
  const like = el.rows[Math.min(i, el.rows.length - 1)];
  const blank = () => Array.from({ length: n }, (_, c) => ({ ...like[c], text: '' }));
  const rows = [...el.rows.slice(0, i), ...Array.from({ length: count }, blank), ...el.rows.slice(i)];
  return { ...el, rows, h: Math.round(el.h + rowH * count) };
}

/** Remove `count` rows from row `from`. Null when no row would be left. */
export function deleteRows(el: TableElement, from: number, count = 1): TableElement | null {
  const rows = el.rows.filter((_, r) => r < from || r >= from + count);
  if (!rows.length) return null;
  const removed = el.rows.length - rows.length;
  return { ...el, rows, h: Math.max(10, Math.round(el.h - (el.h / el.rows.length) * removed)) };
}

/** Insert `count` empty columns before column `at`; the table keeps its width and the columns share it. */
export function insertCols(el: TableElement, at: number, count = 1): TableElement {
  const n = columnCount(el);
  const i = Math.max(0, Math.min(at, n));
  const shares = colShares(el);
  const like = Math.min(i, n - 1);
  const rows = el.rows.map((row) => [...row.slice(0, i), ...Array.from({ length: count }, () => ({ ...row[like], text: '' })), ...row.slice(i)]);
  const added = Array.from({ length: count }, () => 1 / n);
  return withCols({ ...el, rows }, [...shares.slice(0, i), ...added, ...shares.slice(i)]);
}

/** Remove `count` columns from column `from`. Null when no column would be left. */
export function deleteCols(el: TableElement, from: number, count = 1): TableElement | null {
  const keep = (_: unknown, c: number) => c < from || c >= from + count;
  const rows = el.rows.map((row) => row.filter(keep));
  if (!rows[0].length) return null;
  return withCols({ ...el, rows }, colShares(el).filter(keep));
}

/** A cell changed by a patch; an undefined or "" value removes that property (text excepted). */
export function patchCell(cell: TableCell, patch: Partial<TableCell>): TableCell {
  const next: Record<string, unknown> = { ...cell };
  for (const [k, v] of Object.entries(patch)) {
    if (k !== 'text' && (v === undefined || v === '')) delete next[k];
    else next[k] = v;
  }
  return next as unknown as TableCell;
}

/** The table with the cells in rows r0..r1 and columns c0..c1 (inclusive) patched. */
export function patchCells(el: TableElement, r0: number, c0: number, r1: number, c1: number, patch: Partial<TableCell>): TableElement {
  return { ...el, rows: el.rows.map((row, r) => (r < r0 || r > r1 ? row : row.map((cell, c) => (c < c0 || c > c1 ? cell : patchCell(cell, patch))))) };
}

/**
 * A linked table with the cells read from its spreadsheet range. The table keeps its own look (header row,
 * banding, font, borders) and its rows their height; the column widths stay when the range kept its columns.
 */
export function withSheetCells(el: TableElement, rows: TableCell[][], source: TableSource): TableElement {
  const next: TableElement = { ...el, rows, source, h: Math.max(10, Math.round((el.h / el.rows.length) * rows.length)) };
  if (el.cols && el.cols.length !== (rows[0]?.length ?? 0)) delete next.cols;
  return next;
}

/** How a linked table's range is named for the user: "Sales › Q3!A1:D8". */
export function sourceLabel(src: TableSource): string {
  return `${src.title ? `${src.title} › ` : ''}${src.tab}${src.used ? '' : `!${src.range}`}`;
}

// ---------------------------------------------------------------------------
// Colors and the look of a cell

function rgbOf(c: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c.trim());
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].replace(/./g, (x) => x + x) : m[1];
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}

/** `a` mixed into `b` by `t` (0 is b, 1 is a), for hex colors; `a` itself for any other color. */
export function mixColor(a: string, b: string, t: number): string {
  const x = rgbOf(a);
  const y = rgbOf(b);
  if (!x || !y) return a;
  return `#${x.map((v, i) => Math.round(v * t + y[i] * (1 - t)).toString(16).padStart(2, '0')).join('')}`;
}

/** Text that reads on a background: near-black on a light one, white on a dark one. */
export function textOn(bg: string): string {
  const c = rgbOf(bg);
  if (!c) return '#ffffff';
  const [r, g, b] = c.map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  // Whichever of the two has more contrast with it (WCAG's ratio; #1f1f1f's luminance is 0.0137).
  const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return (l + 0.05) / (0.0137 + 0.05) > 1.05 / (l + 0.05) ? '#1f1f1f' : '#ffffff';
}

export interface TableColors {
  text: string;
  /** "none" for no borders. */
  border: string;
  headerFill: string;
  headerText: string;
  /** The shading of every other row when the table is banded. */
  band: string;
}

export function tableColors(el: TableElement, theme: Theme, slideBg?: string): TableColors {
  const bg = slideBg && rgbOf(slideBg) ? slideBg : theme.bg;
  const headerFill = el.style?.headerFill ?? theme.accent;
  return {
    text: el.style?.color ?? theme.text,
    border: el.style?.border ?? mixColor(theme.muted, bg, 0.45),
    headerFill,
    headerText: textOn(headerFill),
    band: mixColor(theme.accent, bg, 0.1),
  };
}

export interface CellLook {
  /** undefined: no fill (the slide shows through). */
  fill?: string;
  color: string;
  bold: boolean;
  italic: boolean;
  align: 'left' | 'center' | 'right';
}

/** How cell (r, c) is drawn: its own look over the header row's and banding's, over the table's. */
export function cellLook(el: TableElement, r: number, c: number, colors: TableColors): CellLook {
  const cell = el.rows[r][c];
  const header = !!el.header && r === 0;
  const banded = !!el.banded && !header && (r - (el.header ? 1 : 0)) % 2 === 1;
  return {
    fill: cell.fill ?? (header ? colors.headerFill : banded ? colors.band : undefined),
    // A cell given a color of its own reads on it whatever the theme's text color is.
    color: cell.color ?? (cell.fill ? textOn(cell.fill) : header ? colors.headerText : colors.text),
    bold: cell.bold ?? header,
    italic: !!cell.italic,
    align: cell.align ?? 'left',
  };
}

// ---------------------------------------------------------------------------
// The assistant's view of a table (read_deck)

export function tableOutline(el: TableElement) {
  const shares = colShares(el);
  const styled: Record<string, unknown>[] = [];
  el.rows.forEach((row, r) =>
    row.forEach((cell, c) => {
      const { text: _text, ...look } = cell;
      if (Object.keys(look).length) styled.push({ row: r + 1, col: c + 1, ...look });
    }),
  );
  return {
    type: 'table' as const,
    rows: el.rows.map((row) => row.map((cell) => cell.text)),
    header: !!el.header,
    banded: !!el.banded,
    ...(el.cols ? { col_widths: shares.map((s) => Math.round(s * el.w)) } : {}),
    ...(el.style ? { style: el.style } : {}),
    ...(el.source ? { linked: { sheet_id: el.source.sheet, ...(el.source.title ? { title: el.source.title } : {}), range: `${el.source.tab}!${el.source.range}`, ...(el.source.used ? { follows: 'the used part of the tab, which this range is now' } : {}), note: 'The cells show this spreadsheet range and update with it; they cannot be edited here.' } } : {}),
    ...(styled.length ? { cell_styles: styled.slice(0, 200) } : {}),
  };
}
