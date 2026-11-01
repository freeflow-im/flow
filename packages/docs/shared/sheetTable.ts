// A spreadsheet range as the cells of a slide table (a linked TableElement, shared/deck.ts): each cell's shown
// value with its bold, italic, colors and alignment. The server reads it for the deck editor
// (GET /api/sheets/:id/table) and for the assistant's tools, so a linked table looks the same however it is made.
import { cellKey, parseRangeString, rangeToString } from './cellref.ts';
import { MAX_TABLE_COLS, MAX_TABLE_ROWS, type TableCell, type TableSource } from './deck.ts';
import { Engine } from './formula/engine.ts';
import { displayValue, splitTabRange } from './agent/sheetRead.ts';
import type { Tab, Workbook } from './types.ts';

export interface SheetTableRef {
  /** The tab by id, else by name, else the first tab. */
  tabId?: string;
  tab?: string;
  /** A1 notation, optionally with the tab ("Data!A1:D8"); the tab's used part when not given. */
  range?: string;
}

export interface SheetTable {
  tabId: string;
  tab: string;
  /** The range read, in A1 notation (whole columns or rows clipped to the used part of the tab). */
  range: string;
  rows: TableCell[][];
  /** Every tab's name, for choosing another. */
  tabs: string[];
}

/** The cells of a range, or a message saying what is wrong (no such tab, an empty or too large range). */
export function sheetTable(wb: Workbook, ref: SheetTableRef, engine = new Engine(wb)): SheetTable | string {
  const split = ref.range ? splitTabRange(ref.range) : { range: '' };
  const name = split.tab ?? ref.tab;
  let tab: Tab | undefined = split.tab ? undefined : wb.tabs.find((t) => t.id === ref.tabId);
  if (!tab && name) tab = wb.tabs.find((t) => t.name.toLowerCase() === name.trim().toLowerCase());
  if (!tab && name) return `There is no tab named "${name}". Tabs: ${wb.tabs.map((t) => t.name).join(', ')}.`;
  tab ??= wb.tabs[0];
  if (!tab) return 'The spreadsheet has no tabs.';
  const ext = engine.extent(tab.id);
  if (!ext.rows || !ext.cols) return `The tab "${tab.name}" is empty.`;
  const asked = split.range ? parseRangeString(split.range, tab.rows, tab.cols) : { r1: 0, c1: 0, r2: ext.rows - 1, c2: ext.cols - 1 };
  if (!asked) return `"${split.range}" is not a valid range. Use A1 notation such as A1:D10.`;
  const rg = { r1: asked.r1, c1: asked.c1, r2: Math.min(asked.r2, ext.rows - 1), c2: Math.min(asked.c2, ext.cols - 1) };
  if (rg.r2 < rg.r1 || rg.c2 < rg.c1) return `The range ${rangeToString(asked)} of "${tab.name}" is empty.`;
  const nRows = rg.r2 - rg.r1 + 1;
  const nCols = rg.c2 - rg.c1 + 1;
  if (nRows > MAX_TABLE_ROWS || nCols > MAX_TABLE_COLS) return `The range ${rangeToString(rg)} is ${nRows} rows by ${nCols} columns; a slide table holds at most ${MAX_TABLE_ROWS} rows and ${MAX_TABLE_COLS} columns.`;
  const src = { workbook: wb, engine };
  const rows: TableCell[][] = [];
  for (let r = rg.r1; r <= rg.r2; r++) {
    const row: TableCell[] = [];
    for (let c = rg.c1; c <= rg.c2; c++) {
      const st = tab.cells[cellKey(r, c)]?.st;
      const cell: TableCell = { text: displayValue(src, tab, r, c) };
      if (st?.b) cell.bold = true;
      if (st?.i) cell.italic = true;
      if (st?.color) cell.color = st.color;
      if (st?.bg) cell.fill = st.bg;
      // Numbers sit on the right, as in the spreadsheet, unless the cell says otherwise.
      const align = st?.align ?? (typeof engine.getValue(tab.id, r, c) === 'number' ? 'right' : undefined);
      if (align && align !== 'left') cell.align = align;
      row.push(cell);
    }
    rows.push(row);
  }
  return { tabId: tab.id, tab: tab.name, range: rangeToString(rg), rows, tabs: wb.tabs.map((t) => t.name) };
}

/** A range read from a stored spreadsheet: its cells, with the spreadsheet's title and the revision read. */
export interface LinkedTable extends SheetTable {
  title: string;
  rev: string;
}

/** The source a table read from `t` keeps; `used` when it follows the tab's used part rather than `t.range`. */
export function sourceOf(sheetId: string, t: LinkedTable, used = false): TableSource {
  return { sheet: sheetId, title: t.title, tabId: t.tabId, tab: t.tab, range: t.range, rev: t.rev, ...(used ? { used: true } : {}) };
}

/** What to read for a linked table's source: its fixed range, or the tab's used part. */
export function refOf(src: TableSource): SheetTableRef {
  return { tabId: src.tabId, tab: src.tab, ...(src.used ? {} : { range: src.range }) };
}
