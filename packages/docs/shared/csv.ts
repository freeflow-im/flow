// CSV files: a spreadsheet whose stored file is CSV text. It opens in the spreadsheet editor as one tab of
// plain values, and edits are written back as CSV. Stored like the other kinds (server/sheets.ts, kind
// "sheet" with format "csv") as JSON holding the text. Anything CSV cannot hold (formatting, images, column
// widths, frozen panes, filters, more tabs) needs the file converted to a native spreadsheet first.

import { cellKey, MAX_COLS, MAX_ROWS } from './cellref.ts';
import { DEFAULT_COLS, DEFAULT_ROWS, type CellData, type Tab, type Workbook } from './types.ts';

export interface CsvDoc {
  version: 1;
  /** The CSV text, as imported or as last written from the grid. */
  csv: string;
}

/** Largest CSV text accepted by an import, in characters. */
export const MAX_CSV_CHARS = 10 * 1024 * 1024;

/** Id of the only tab of a CSV file (the same on every load, so selections and comparisons stay stable). */
export const CSV_TAB_ID = 'csv';

export class CsvError extends Error {}

export function newCsvDoc(csv = ''): CsvDoc {
  return { version: 1, csv };
}

export function isCsvDoc(doc: unknown): doc is CsvDoc {
  return !!doc && typeof doc === 'object' && typeof (doc as CsvDoc).csv === 'string' && !('tabs' in doc);
}

/** Parse CSV text (RFC 4180: comma-separated, fields optionally in double quotes, "" for a quote). */
export function parseCsv(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let i = 0;
  const n = src.length;
  // True once the current row has any content, so a final line break does not add an empty row.
  let open = false;
  while (i < n) {
    const ch = src[i];
    if (ch === '"' && field === '') {
      // Quoted field: read to the closing quote.
      i++;
      for (;;) {
        const q = src.indexOf('"', i);
        if (q < 0) {
          field += src.slice(i);
          i = n;
          break;
        }
        field += src.slice(i, q);
        if (src[q + 1] === '"') {
          field += '"';
          i = q + 2;
        } else {
          i = q + 1;
          break;
        }
      }
      open = true;
      // Anything between the closing quote and the next separator is kept as typed.
      continue;
    }
    if (ch === ',') {
      row.push(field);
      field = '';
      open = true;
      i++;
    } else if (ch === '\n' || ch === '\r') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      open = false;
      i += ch === '\r' && src[i + 1] === '\n' ? 2 : 1;
    } else {
      // Unquoted run up to the next separator.
      let j = i + 1;
      while (j < n && src[j] !== ',' && src[j] !== '\n' && src[j] !== '\r') j++;
      field += src.slice(i, j);
      open = true;
      i = j;
    }
  }
  if (open) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const quote = (v: string) => (/[",\n\r]/.test(v) || /^\s|\s$/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** How a CSV text is written, so saving keeps the file's line endings, final line break and byte-order mark. */
export interface CsvStyle {
  eol: '\n' | '\r\n';
  finalEol: boolean;
  bom: boolean;
}

export function csvStyle(text: string): CsvStyle {
  const firstBreak = text.indexOf('\n');
  return {
    eol: firstBreak > 0 && text[firstBreak - 1] === '\r' ? '\r\n' : '\n',
    finalEol: text === '' || /[\r\n]$/.test(text),
    bom: text.charCodeAt(0) === 0xfeff,
  };
}

export function formatCsv(rows: string[][], style: CsvStyle = { eol: '\n', finalEol: true, bom: false }): string {
  const body = rows.map((r) => r.map(quote).join(',')).join(style.eol);
  return (style.bom ? '﻿' : '') + body + (rows.length && style.finalEol ? style.eol : '');
}

/** The workbook a CSV file opens as: one tab with every field as a cell's raw value. */
export function csvToWorkbook(text: string): Workbook {
  const rows = parseCsv(text);
  if (rows.length > MAX_ROWS) throw new CsvError(`This CSV file has too many rows (${MAX_ROWS.toLocaleString('en-US')} maximum).`);
  const cells: Record<string, CellData> = {};
  let width = 0;
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r];
    if (row.length > MAX_COLS) throw new CsvError(`This CSV file has too many columns (${MAX_COLS.toLocaleString('en-US')} maximum).`);
    if (row.length > width) width = row.length;
    for (let c = 0; c < row.length; c++) if (row[c] !== '') cells[cellKey(r, c)] = { v: row[c] };
  }
  const tab: Tab = {
    id: CSV_TAB_ID,
    name: 'Sheet1',
    rows: Math.max(DEFAULT_ROWS, rows.length),
    cols: Math.max(DEFAULT_COLS, width),
    cells,
    colWidths: {},
    rowHeights: {},
  };
  return { version: 1, tabs: [tab] };
}

const KEY_RE = /^([A-Z]+)(\d+)$/;

/** The CSV text of a workbook that `csvProblem` accepts: the raw value of every cell, as a full rectangle. */
export function workbookToCsv(wb: Workbook, style?: CsvStyle): string {
  const tab = wb.tabs[0];
  const filled: { r: number; c: number; v: string }[] = [];
  let height = 0;
  let width = 0;
  for (const key in tab.cells) {
    const v = tab.cells[key].v;
    if (v === '') continue;
    const m = KEY_RE.exec(key);
    if (!m) continue;
    let c = 0;
    for (let i = 0; i < m[1].length; i++) c = c * 26 + (m[1].charCodeAt(i) - 64);
    c -= 1;
    const r = Number(m[2]) - 1;
    filled.push({ r, c, v });
    if (r >= height) height = r + 1;
    if (c >= width) width = c + 1;
  }
  const rows: string[][] = Array.from({ length: height }, () => new Array<string>(width).fill(''));
  for (const f of filled) rows[f.r][f.c] = f.v;
  return formatCsv(rows, style);
}

/** What a cell holds that CSV cannot store, or null. */
export function csvCellProblem(cell: CellData | undefined): string | null {
  if (!cell) return null;
  if (cell.img) return 'Images';
  if (cell.st && Object.keys(cell.st).length > 0) return 'Cell formatting';
  return null;
}

/** Tab properties a CSV file cannot store, with what to call each. `rows` and `cols` follow from the content. */
const TAB_PROP_PROBLEMS: Partial<Record<keyof Tab, string>> = {
  name: 'Sheet names',
  colWidths: 'Column widths',
  rowHeights: 'Row heights',
  frozenRows: 'Frozen rows and columns',
  frozenCols: 'Frozen rows and columns',
  filter: 'Filters',
  charts: 'Charts',
};

const isEmpty = (v: unknown) => v === undefined || v === null || v === 0 || (typeof v === 'object' && Object.keys(v as object).length === 0);

/** What setting a tab property would add that CSV cannot store, or null. */
export function csvTabPropProblem(prop: keyof Tab, value: unknown): string | null {
  const problem = TAB_PROP_PROBLEMS[prop];
  if (!problem) return null;
  if (prop === 'name') return problem;
  return isEmpty(value) ? null : problem;
}

/**
 * The first feature of the workbook that CSV cannot store (named for the user, e.g. "Cell formatting"), or
 * null when the workbook can be saved as CSV without losing anything. The tab's name is not checked.
 */
export function csvProblem(wb: Workbook): string | null {
  if (wb.tabs.length !== 1) return 'More than one sheet';
  const tab = wb.tabs[0];
  for (const prop of ['colWidths', 'rowHeights', 'frozenRows', 'frozenCols', 'filter', 'charts'] as const) {
    const problem = csvTabPropProblem(prop, tab[prop]);
    if (problem) return problem;
  }
  for (const key in tab.cells) {
    const problem = csvCellProblem(tab.cells[key]);
    if (problem) return problem;
  }
  return null;
}

/** A title for an imported CSV file: the file name without its extension. */
export function csvTitle(fileName: string): string {
  return fileName.replace(/\.csv$/i, '').trim().slice(0, 200) || 'Imported CSV';
}
