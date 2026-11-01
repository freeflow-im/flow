// A stored spreadsheet's range read as the cells of a linked slide table (shared/sheetTable.ts), for the deck
// editor's GET /api/sheets/:id/table and for the assistant's tools when they link a table.
import { sheetTable, type LinkedTable, type SheetTableRef } from '../shared/sheetTable.ts';
import type { SheetStore } from './sheets.ts';
import { linkedChartOf, type LinkedChart, type SheetChartList } from '../shared/chart.ts';
import { Engine } from '../shared/formula/engine.ts';

/** The range's cells, null when there is no such spreadsheet, or a message saying what is wrong with the range. */
export async function loadLinkedTable(sheets: SheetStore, userId: string, sheetId: string, ref: SheetTableRef): Promise<LinkedTable | string | null> {
  const res = await sheets.load(userId, sheetId);
  if (!res || res.meta.kind !== 'sheet') return null;
  const table = sheetTable(res.workbook, ref);
  return typeof table === 'string' ? table : { ...table, title: res.meta.title, rev: res.meta.updatedAt };
}

/** A spreadsheet's chart as a slide shows it; null when there is no such spreadsheet, a message when no such chart. */
export async function loadLinkedChart(sheets: SheetStore, userId: string, sheetId: string, chartId: string): Promise<LinkedChart | string | null> {
  const res = await sheets.load(userId, sheetId);
  if (!res || res.meta.kind !== 'sheet') return null;
  return linkedChartOf(res.workbook, new Engine(res.workbook), chartId, { title: res.meta.title, rev: res.meta.updatedAt });
}

/** A spreadsheet's charts, for choosing one; null when there is no such spreadsheet. */
export async function listSheetCharts(sheets: SheetStore, userId: string, sheetId: string): Promise<SheetChartList | null> {
  const res = await sheets.load(userId, sheetId);
  if (!res || res.meta.kind !== 'sheet') return null;
  return { title: res.meta.title, charts: res.workbook.tabs.flatMap((t) => (t.charts ?? []).map((c) => ({ id: c.id, tabId: t.id, tab: t.name, type: c.type, ...(c.title ? { title: c.title } : {}) }))) };
}
