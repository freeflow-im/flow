// Read-only views of a workbook for the agent. Used by the browser (on the live, open spreadsheet)
// and by the server (on other spreadsheets in the account), so both describe sheets the same way.
import { cellKey, parseRangeString, rangeToString, type Range } from '../cellref.ts';
import { isFormula } from '../formula/adjust.ts';
import type { Engine } from '../formula/engine.ts';
import type { CellStyle, Tab, Workbook } from '../types.ts';
import { formatValue } from '../values.ts';
import { chartOutline } from '../chart.ts';

export interface SheetSource {
  workbook: Workbook;
  engine: Engine;
}

/** Most cells returned by one read, to keep tool results a reasonable size. */
export const MAX_READ_CELLS = 2500;
const PREVIEW_ROWS = 5;
const PREVIEW_COLS = 15;

/** Split "'My Tab'!A1:B2", "Sheet1!A1" or "A1:B2" into an optional tab name and the range. */
export function splitTabRange(s: string): { tab?: string; range: string } {
  const i = s.lastIndexOf('!');
  if (i < 0) return { range: s.trim() };
  let tab = s.slice(0, i).trim();
  if (tab.startsWith("'") && tab.endsWith("'")) tab = tab.slice(1, -1).replace(/''/g, "'");
  return { tab, range: s.slice(i + 1).trim() };
}

/** A tab by name (case-insensitive), or the fallback/first tab when no name is given. Returns an error message if not found. */
export function findTab(wb: Workbook, name: string | undefined, fallbackId?: string): Tab | string {
  if (!name) return wb.tabs.find((t) => t.id === fallbackId) ?? wb.tabs[0];
  const t = wb.tabs.find((t) => t.name.toLowerCase() === name.trim().toLowerCase());
  return t ?? `There is no tab named "${name}". Tabs: ${wb.tabs.map((t) => t.name).join(', ')}.`;
}

/** Resolve a tab and range. A tab prefix in the range ("Data!A1:B2") wins over the separate tab argument. */
export function resolveRange(wb: Workbook, tabArg: string | undefined, rangeArg: string, fallbackId?: string): { tab: Tab; range: Range } | string {
  const { tab: prefix, range } = splitTabRange(rangeArg);
  const tab = findTab(wb, prefix ?? tabArg, fallbackId);
  if (typeof tab === 'string') return tab;
  const rg = parseRangeString(range, tab.rows, tab.cols);
  if (!rg) return `"${rangeArg}" is not a valid range. Use A1 notation such as B2, A1:D10, C:E or 3:5.`;
  return { tab, range: rg };
}

export function displayValue(src: SheetSource, tab: Tab, r: number, c: number): string {
  const cell = tab.cells[cellKey(r, c)];
  if (!cell) return '';
  if (cell.img && cell.v === '') return '[image]';
  const v = src.engine.getValue(tab.id, r, c);
  const implied = typeof v === 'number' ? src.engine.getImpliedFormat(tab.id, r, c) : undefined;
  return formatValue(v, cell.st, implied);
}

function usedRange(src: SheetSource, tab: Tab): string | null {
  const ext = src.engine.extent(tab.id);
  if (!ext.rows || !ext.cols) return null;
  return rangeToString({ r1: 0, c1: 0, r2: ext.rows - 1, c2: ext.cols - 1 });
}

/** Every tab's size, used range, frozen panes, filter and first few rows. */
export function sheetOverview(src: SheetSource, opts: { activeTabId?: string; selection?: string[] } = {}) {
  return {
    tabs: src.workbook.tabs.map((tab) => {
      const ext = src.engine.extent(tab.id);
      const first_rows: string[][] = [];
      for (let r = 0; r < Math.min(ext.rows, PREVIEW_ROWS); r++) {
        const row: string[] = [];
        for (let c = 0; c < Math.min(ext.cols, PREVIEW_COLS); c++) row.push(displayValue(src, tab, r, c));
        first_rows.push(row);
      }
      return {
        name: tab.name,
        ...(tab.id === opts.activeTabId ? { active: true } : {}),
        grid_size: `${tab.rows} rows x ${tab.cols} columns`,
        used_range: usedRange(src, tab),
        ...(tab.frozenRows ? { frozen_rows: tab.frozenRows } : {}),
        ...(tab.frozenCols ? { frozen_columns: tab.frozenCols } : {}),
        ...(tab.filter ? { filter_range: rangeToString(tab.filter) } : {}),
        ...(tab.charts?.length ? { charts: tab.charts.map(chartOutline) } : {}),
        first_rows,
      };
    }),
    ...(opts.selection ? { selection: opts.selection } : {}),
  };
}

/**
 * Displayed values of a range, clipped to the used area and capped at MAX_READ_CELLS.
 * Optionally includes formulas and cell formats (keyed by A1 address, only for cells that have them).
 */
export function readRange(src: SheetSource, tab: Tab, rg: Range, opts: { formulas?: boolean; formats?: boolean } = {}) {
  const ext = src.engine.extent(tab.id);
  const notes: string[] = [];
  const clipped: Range = { r1: rg.r1, c1: rg.c1, r2: Math.min(rg.r2, ext.rows - 1), c2: Math.min(rg.c2, ext.cols - 1) };
  if (clipped.r2 < clipped.r1 || clipped.c2 < clipped.c1) {
    return { tab: tab.name, range: rangeToString(rg), values: [], note: 'This range is empty.' };
  }
  if (clipped.r2 < rg.r2 || clipped.c2 < rg.c2) notes.push('Clipped to the used part of the tab; everything outside it is empty.');
  const cols = clipped.c2 - clipped.c1 + 1;
  const maxRows = Math.max(1, Math.floor(MAX_READ_CELLS / cols));
  if (clipped.r2 - clipped.r1 + 1 > maxRows) {
    clipped.r2 = clipped.r1 + maxRows - 1;
    notes.push(`Truncated to ${maxRows} rows; read from row ${clipped.r2 + 2} on with another call.`);
  }

  const values: string[][] = [];
  const formulas: Record<string, string> = {};
  const formats: Record<string, CellStyle> = {};
  const links: Record<string, string> = {};
  for (let r = clipped.r1; r <= clipped.r2; r++) {
    const row: string[] = [];
    for (let c = clipped.c1; c <= clipped.c2; c++) {
      const key = cellKey(r, c);
      const cell = tab.cells[key];
      row.push(displayValue(src, tab, r, c));
      if (opts.formulas && cell && isFormula(cell.v)) formulas[key] = cell.v;
      if (opts.formats && cell?.st) formats[key] = cell.st;
      const link = cell ? src.engine.getLink(tab.id, r, c) : null;
      if (link) links[key] = link;
    }
    values.push(row);
  }
  return {
    tab: tab.name,
    range: rangeToString(clipped),
    values,
    ...(opts.formulas ? { formulas } : {}),
    ...(opts.formats ? { formats } : {}),
    ...(Object.keys(links).length ? { links } : {}),
    ...(notes.length ? { note: notes.join(' ') } : {}),
  };
}
