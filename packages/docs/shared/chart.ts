// Charts on a spreadsheet tab (Tab.charts): what a chart is, how its data is read from the workbook, and how
// its references follow the workbook's changes. The model follows Excel's (a chart floats over the grid from
// an anchor cell, each series is a range of values with an optional name, and the categories are one range for
// all of them) so it maps onto an .xlsx chart part one to one.
//
// Ranges are written as in formulas, from the chart's own tab: "F6:F21", or "'Other tab'!A1:A5" for another
// tab. They go through the same adjusters as formulas when rows, columns or tabs change (adjustChartRefs), and
// the client's renderer (client/src/chart/ChartView.tsx) draws what chartData reads.
import { cellKey, parseRangeString, rangeToString, type Range } from './cellref.ts';
import { adjustForDelete, adjustForInsert, adjustForMove, renameSheetRefs, type Axis, type LineMove } from './formula/adjust.ts';
import type { Engine } from './formula/engine.ts';
import { displayValue, splitTabRange } from './agent/sheetRead.ts';
import { formatValue, isError } from './values.ts';
import type { CellStyle, NumberFormat, Tab, Workbook } from './types.ts';

export const CHART_TYPES = ['column', 'bar', 'line', 'area', 'pie', 'scatter'] as const;
export type ChartType = (typeof CHART_TYPES)[number];
export const LEGEND_POSITIONS = ['right', 'bottom', 'top', 'none'] as const;
export type LegendPosition = (typeof LEGEND_POSITIONS)[number];

export const CHART_TYPE_NAMES: Record<ChartType, string> = { column: 'Column', bar: 'Bar', line: 'Line', area: 'Area', pie: 'Pie', scatter: 'Scatter' };

export interface ChartSeries {
  /** The values: one row or column (formula reference syntax, from the chart's tab). */
  values: string;
  /** The series' name: a cell holding it (a reference), or the text itself when `nameRef` is not set. */
  name?: string;
  nameRef?: string;
  /** CSS color (#rrggbb); defaults to the palette. */
  color?: string;
}

export interface Chart {
  id: string;
  type: ChartType;
  /** Where its top-left corner is: a cell, and the offset into it in pixels. */
  anchor: { r: number; c: number; dx: number; dy: number };
  /** Size in pixels. */
  w: number;
  h: number;
  title?: string;
  /** The labels along the category axis (the x values of a scatter chart), one row or column. */
  categories?: string;
  series: ChartSeries[];
  /** Column, bar and area charts: the series are stacked on each other. */
  stacked?: boolean;
  legend?: LegendPosition;
  xTitle?: string;
  yTitle?: string;
  /** The value axis is logarithmic (base 10). */
  logScale?: boolean;
}

/** The palette series take their colors from, in order. */
export const CHART_COLORS = ['#4285f4', '#ea4335', '#fbbc04', '#34a853', '#ff6d01', '#46bdc6', '#7baaf7', '#f07b72', '#fcd04f', '#71c287'];

export const MAX_CHARTS = 50;
export const MAX_SERIES = 30;
/** Most points one series draws (the rest of a longer range is left out). */
export const MAX_POINTS = 2000;
const MAX_REF = 300;

// ---------------------------------------------------------------------------
// References

export interface ResolvedRef {
  tab: Tab;
  range: Range;
}

/** The tab and range a chart reference means, from the chart's tab; a message when it means nothing. */
export function resolveRef(wb: Workbook, own: Tab, ref: string): ResolvedRef | string {
  const { tab: name, range } = splitTabRange(ref);
  if (ref.includes('#REF!')) return 'The range was deleted';
  const tab = name === undefined ? own : wb.tabs.find((t) => t.name.toLowerCase() === name.toLowerCase());
  if (!tab) return `There is no tab named "${name}"`;
  const rg = parseRangeString(range, tab.rows, tab.cols);
  if (!rg) return `"${ref}" is not a range`;
  return { tab, range: rg };
}

/** A range written as a chart reference from `own` ("B2:B9", or "'Other'!B2:B9"). */
export function refText(own: Tab, tab: Tab, range: Range): string {
  const rg = rangeToString(range);
  if (tab.id === own.id) return rg;
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(tab.name) ? `${tab.name}!${rg}` : `'${tab.name.replace(/'/g, "''")}'!${rg}`;
}

/** The cells of a one-row or one-column range, in order. */
function cellsOf(rg: Range): [number, number][] {
  const out: [number, number][] = [];
  if (rg.r1 === rg.r2 || rg.c2 - rg.c1 > rg.r2 - rg.r1) {
    for (let c = rg.c1; c <= rg.c2 && out.length < MAX_POINTS; c++) out.push([rg.r1, c]);
  } else {
    for (let r = rg.r1; r <= rg.r2 && out.length < MAX_POINTS; r++) out.push([r, rg.c1]);
  }
  return out;
}

/** Every reference a chart has, with a way to put a new one in its place. */
function refsOf(chart: Chart): { get: string; set(c: Chart, v: string): Chart }[] {
  const out: { get: string; set(c: Chart, v: string): Chart }[] = [];
  if (chart.categories) out.push({ get: chart.categories, set: (c, v) => ({ ...c, categories: v }) });
  chart.series.forEach((s, i) => {
    const at = (c: Chart, patch: Partial<ChartSeries>) => ({ ...c, series: c.series.map((x, j) => (j === i ? { ...x, ...patch } : x)) });
    out.push({ get: s.values, set: (c, v) => at(c, { values: v }) });
    if (s.nameRef) out.push({ get: s.nameRef, set: (c, v) => at(c, { nameRef: v }) });
  });
  return out;
}

/** The chart with every reference passed through a formula adjuster (which works on "=ref"). */
function mapRefs(chart: Chart, adjust: (formula: string) => string): Chart {
  let next = chart;
  for (const ref of refsOf(chart)) {
    const v = adjust(`=${ref.get}`).replace(/^=/, '');
    if (v !== ref.get) next = ref.set(next, v);
  }
  return next;
}

export type ChartChange =
  | { kind: 'insert'; tab: string; axis: Axis; at: number; count: number }
  | { kind: 'delete'; tab: string; axis: Axis; from: number; to: number }
  | { kind: 'move'; tab: string; axis: Axis; move: LineMove }
  | { kind: 'rename'; from: string; to: string };

/**
 * The charts of tab `own` after rows or columns of tab `change.tab` were inserted, deleted or moved, or a tab
 * renamed: their references follow the data as formulas do, and the anchors of the changed tab's charts follow
 * their cells. Undefined for no charts.
 */
export function adjustCharts(charts: Chart[] | undefined, own: Tab, change: ChartChange, mapIndex?: (i: number) => number | null): Chart[] | undefined {
  if (!charts?.length) return charts;
  return charts.map((ch) => {
    let next = mapRefs(ch, (f) =>
      change.kind === 'insert'
        ? adjustForInsert(f, own.name, change.tab, change.axis, change.at, change.count)
        : change.kind === 'delete'
          ? adjustForDelete(f, own.name, change.tab, change.axis, change.from, change.to)
          : change.kind === 'move'
            ? adjustForMove(f, own.name, change.tab, change.axis, change.move)
            : renameSheetRefs(f, change.from, change.to),
    );
    if (change.kind !== 'rename' && change.tab === own.name && mapIndex) {
      const key = change.axis === 'row' ? 'r' : 'c';
      const at = next.anchor[key];
      let to = mapIndex(at);
      // A chart whose anchor row or column was deleted sits where it was, on the next one.
      if (to === null) to = change.kind === 'delete' ? change.from : at;
      if (to !== at) next = { ...next, anchor: { ...next.anchor, [key]: Math.max(0, to) } };
    }
    return next;
  });
}

// ---------------------------------------------------------------------------
// Data

export interface ChartPoint {
  /** null where the cell is empty or not a number (a gap in the line). */
  y: number | null;
  /** Scatter charts: the x value. */
  x?: number | null;
}

export interface SeriesData {
  name: string;
  color: string;
  points: ChartPoint[];
}

export interface ChartData {
  categories: string[];
  series: SeriesData[];
  /** How the values are shown on the value axis (the first value cell's number format). */
  format?: { fmt?: NumberFormat; dp?: number };
  /** For scatter charts: the x values' format. */
  xFormat?: { fmt?: NumberFormat; dp?: number };
  /** Why nothing can be drawn, if so. */
  error?: string;
}

/** A value for drawing: the number, or null for anything else. */
function numberAt(engine: Engine, tab: Tab, r: number, c: number): number | null {
  const v = engine.getValue(tab.id, r, c);
  return typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'boolean' ? Number(v) : null;
}

function formatAt(engine: Engine, tab: Tab, r: number, c: number): { fmt?: NumberFormat; dp?: number } | undefined {
  const st: CellStyle | undefined = tab.cells[cellKey(r, c)]?.st;
  if (st?.fmt) return { fmt: st.fmt, ...(st.dp !== undefined ? { dp: st.dp } : {}) };
  const implied = engine.getImpliedFormat(tab.id, r, c);
  return implied ?? undefined;
}

function colName(c: number): string {
  let s = '';
  for (let n = c + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/** What a chart shows, read from the workbook through the formula engine (so formulas are their values). */
export function chartData(wb: Workbook, engine: Engine, own: Tab, chart: Chart): ChartData {
  const src = { workbook: wb, engine };
  let categories: string[] = [];
  let xs: (number | null)[] | null = null;
  let xFormat: ChartData['xFormat'];
  if (chart.categories) {
    const at = resolveRef(wb, own, chart.categories);
    if (typeof at === 'string') return { categories: [], series: [], error: `Labels: ${at}` };
    const cells = cellsOf(at.range);
    categories = cells.map(([r, c]) => displayValue(src, at.tab, r, c));
    if (chart.type === 'scatter') {
      xs = cells.map(([r, c]) => numberAt(engine, at.tab, r, c));
      if (cells.length) xFormat = formatAt(engine, at.tab, cells[0][0], cells[0][1]);
    }
  }
  const series: SeriesData[] = [];
  let format: ChartData['format'];
  for (const [i, s] of chart.series.entries()) {
    const at = resolveRef(wb, own, s.values);
    if (typeof at === 'string') return { categories, series, error: `Series ${i + 1}: ${at}` };
    const cells = cellsOf(at.range);
    if (!format && cells.length) format = formatAt(engine, at.tab, cells[0][0], cells[0][1]);
    let name = s.name ?? '';
    if (s.nameRef) {
      const n = resolveRef(wb, own, s.nameRef);
      name = typeof n === 'string' ? '' : displayValue(src, n.tab, n.range.r1, n.range.c1);
    }
    series.push({
      name: name || `Series ${i + 1}`,
      color: s.color ?? CHART_COLORS[i % CHART_COLORS.length],
      points: cells.map(([r, c], k) => ({ y: numberAt(engine, at.tab, r, c), ...(xs ? { x: xs[k] ?? null } : {}) })),
    });
  }
  // Without labels, the points are numbered.
  const n = Math.max(0, ...series.map((s) => s.points.length));
  if (!chart.categories) categories = Array.from({ length: n }, (_, k) => String(k + 1));
  if (!series.length) return { categories, series, error: 'The chart has no data' };
  return { categories, series, ...(format ? { format } : {}), ...(xFormat ? { xFormat } : {}) };
}

/** A value as a tooltip shows it: in the values' number format. */
export function formatChartValue(v: number, format: ChartData['format']): string {
  return formatValue(v, format ? ({ fmt: format.fmt, dp: format.dp } as CellStyle) : undefined, format ?? null);
}

/**
 * An axis label: in the values' format (currency, percent, ...) with only the decimals the ticks need, so an
 * axis of 0, 20, 40 reads so whatever the cells show.
 */
export function formatTick(v: number, format: ChartData['format'], step: number): string {
  const fmt = format?.fmt;
  if (fmt === 'date' || fmt === 'datetime' || fmt === 'time' || fmt === 'text') return formatChartValue(v, format);
  const scale = fmt === 'percent' ? 100 : 1;
  const unit = Math.abs(step || v) * scale;
  const dp = unit > 0 && unit < 1 ? Math.min(10, Math.ceil(-Math.log10(unit) - 1e-9)) : 0;
  return formatValue(v, { fmt: fmt && fmt !== 'general' ? fmt : 'number', dp } as CellStyle, null);
}

// ---------------------------------------------------------------------------
// A chart made from a selection

const isNumber = (engine: Engine, tab: Tab, r: number, c: number) => {
  const v = engine.getValue(tab.id, r, c);
  return typeof v === 'number' && !isError(v);
};
const isBlank = (engine: Engine, tab: Tab, r: number, c: number) => {
  const v = engine.getValue(tab.id, r, c);
  return v === null || v === '';
};

/**
 * A chart of a range, as a spreadsheet makes one: a first row that is not numbers holds the series' names, a
 * first column that is not numbers holds the labels (with only numbers, a two-column range is x and y of a
 * scatter chart), and every other column with numbers in it is a series. Line for dates and other time labels,
 * columns otherwise. Null when the range has no numbers.
 */
export function suggestChart(engine: Engine, tab: Tab, rg: Range, id: string, anchor: Chart['anchor'], picked: (c: number) => boolean = () => true): Chart | null {
  const rowNumbers = (r: number) => {
    let n = 0;
    for (let c = rg.c1; c <= rg.c2; c++) if (isNumber(engine, tab, r, c)) n++;
    return n;
  };
  const header = rg.r2 > rg.r1 && rowNumbers(rg.r1) === 0;
  const top = header ? rg.r1 + 1 : rg.r1;
  const colNumbers = (c: number) => {
    let n = 0;
    let filled = 0;
    for (let r = top; r <= rg.r2; r++) {
      if (isNumber(engine, tab, r, c)) n++;
      if (!isBlank(engine, tab, r, c)) filled++;
    }
    return { n, filled };
  };
  const first = colNumbers(rg.c1);
  const labels = rg.c2 > rg.c1 && first.n < first.filled && picked(rg.c1);
  const own = (r1: number, c1: number, r2: number, c2: number) => rangeToString({ r1, c1, r2, c2 });
  const series: ChartSeries[] = [];
  for (let c = labels ? rg.c1 + 1 : rg.c1; c <= rg.c2 && series.length < MAX_SERIES; c++) {
    if (!picked(c)) continue;
    const col = colNumbers(c);
    // A column that is mostly text (a model name, a note) is not a series.
    if (!col.n || col.n < col.filled / 2) continue;
    series.push({ values: own(top, c, rg.r2, c), ...(header ? { nameRef: own(rg.r1, c, rg.r1, c) } : {}) });
  }
  if (!series.length) return null;
  let type: ChartType = 'column';
  let categories = labels ? own(top, rg.c1, rg.r2, rg.c1) : undefined;
  // Two columns of numbers and no labels: x and y.
  if (!labels && series.length === 2) {
    type = 'scatter';
    categories = series[0].values;
    series.splice(0, 1);
  } else if (labels) {
    const fmt = engine.getImpliedFormat(tab.id, top, rg.c1)?.fmt ?? tab.cells[cellKey(top, rg.c1)]?.st?.fmt;
    const text = displayValue({ workbook: { version: 1, tabs: [tab] }, engine }, tab, top, rg.c1);
    if (fmt === 'date' || fmt === 'datetime' || /^\d{4}-\d{1,2}(-\d{1,2})?$|^(19|20)\d\d$|^Q[1-4]\b/i.test(text)) type = 'line';
  }
  return { id, type, anchor, w: 600, h: 371, ...(categories ? { categories } : {}), series, ...(series.length > 1 ? { legend: 'bottom' as const } : { legend: 'none' as const }) };
}

// ---------------------------------------------------------------------------
// Charts on slides (ChartElement in shared/deck.ts)

/** How a chart on a slide looks: a spreadsheet chart without its place (and its ranges, if it has them, unused). */
export type SlideChart = Omit<Chart, 'anchor' | 'w' | 'h'>;

/** A spreadsheet chart's look, for a slide. */
export function slideChartOf(chart: Chart): SlideChart {
  const { anchor: _a, w: _w, h: _h, ...look } = chart;
  return look;
}

/** The chart a slide's chart element draws: its look at the element's size. */
export function chartOfSlide(look: SlideChart, w: number, h: number): Chart {
  return { ...look, anchor: { r: 0, c: 0, dx: 0, dy: 0 }, w: Math.max(20, w), h: Math.max(20, h) };
}

const isFormat = (f: unknown) => f === undefined || (!!f && typeof f === 'object' && (((f as { fmt?: unknown }).fmt === undefined || typeof (f as { fmt?: unknown }).fmt === 'string') && ((f as { dp?: unknown }).dp === undefined || nonNeg((f as { dp?: unknown }).dp, 20))));
const isNum = (v: unknown) => v === null || (typeof v === 'number' && Number.isFinite(v));

/** What is wrong with a slide's chart element (its look and data), or null. */
export function validateChartElement(el: { chart?: unknown; data?: unknown; source?: unknown; w: number; h: number }): string | null {
  const look = el.chart as SlideChart | undefined;
  if (!look || typeof look !== 'object') return 'a chart needs its look';
  const problem = validateCharts([{ ...look, series: look.series ?? [], anchor: { r: 0, c: 0, dx: 0, dy: 0 }, w: Math.max(20, el.w), h: Math.max(20, el.h) }]);
  if (problem) return problem;
  const d = el.data as ChartData | undefined;
  if (!d || !Array.isArray(d.categories) || !Array.isArray(d.series) || d.series.length > MAX_SERIES || d.categories.length > MAX_POINTS) return 'invalid chart data';
  if (!d.categories.every((c) => typeof c === 'string' && c.length <= 500)) return 'invalid chart labels';
  for (const s of d.series) {
    if (!s || typeof s.name !== 'string' || !isHex(s.color) || !Array.isArray(s.points) || s.points.length > MAX_POINTS) return 'invalid chart series';
    if (!s.points.every((p) => p && isNum(p.y) && (p.x === undefined || isNum(p.x)))) return 'invalid chart values';
  }
  if (!isFormat(d.format) || !isFormat(d.xFormat) || (d.error !== undefined && !isText(d.error, 500))) return 'invalid chart data';
  const src = el.source as { sheet?: unknown; tabId?: unknown; tab?: unknown; chart?: unknown; title?: unknown; rev?: unknown } | undefined;
  if (src !== undefined) {
    const str = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 200;
    if (!src || !str(src.sheet) || !str(src.tabId) || !str(src.tab) || !str(src.chart) || (src.title !== undefined && typeof src.title !== 'string') || (src.rev !== undefined && typeof src.rev !== 'string')) return 'invalid chart source';
  }
  return null;
}

/** A slide's chart for read_deck: its kind, titles and the data it shows (the first rows of it), and its link. */
export function chartElementOutline(el: { chart: SlideChart; data: ChartData; source?: { sheet: string; title?: string; tab: string; chart: string } }) {
  const { chart, data } = el;
  return {
    type: 'chart' as const,
    chart_type: chart.type,
    ...(chart.title ? { title: chart.title } : {}),
    labels: data.categories.slice(0, 50),
    series: data.series.map((s) => ({ name: s.name, values: s.points.slice(0, 50).map((p) => p.y) })),
    ...(chart.stacked ? { stacked: true } : {}),
    ...(chart.logScale ? { log_scale: true } : {}),
    ...(el.source ? { linked: { sheet_id: el.source.sheet, ...(el.source.title ? { title: el.source.title } : {}), tab: el.source.tab, chart_id: el.source.chart, note: 'The chart shows this spreadsheet chart and updates with it; change it there.' } } : {}),
  };
}

// ---------------------------------------------------------------------------
// Validation (saved workbooks and tool input)

const isRef = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= MAX_REF;
const isHex = (v: unknown) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v);
const isText = (v: unknown, max = 200) => typeof v === 'string' && v.length <= max;
const nonNeg = (v: unknown, max: number) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max;

/** What is wrong with a tab's charts, or null. */
export function validateCharts(charts: unknown): string | null {
  if (charts === undefined) return null;
  if (!Array.isArray(charts) || charts.length > MAX_CHARTS) return `A tab holds at most ${MAX_CHARTS} charts`;
  const ids = new Set<string>();
  for (const ch of charts as Chart[]) {
    if (!ch || typeof ch !== 'object' || typeof ch.id !== 'string' || !ch.id || ids.has(ch.id)) return 'Invalid or duplicate chart id';
    ids.add(ch.id);
    if (!CHART_TYPES.includes(ch.type)) return `Chart ${ch.id}: unknown type`;
    const a = ch.anchor;
    if (!a || !Number.isInteger(a.r) || !Number.isInteger(a.c) || a.r < 0 || a.c < 0 || !nonNeg(a.dx, 10_000) || !nonNeg(a.dy, 10_000)) return `Chart ${ch.id}: invalid position`;
    if (!nonNeg(ch.w, 10_000) || !nonNeg(ch.h, 10_000) || ch.w < 20 || ch.h < 20) return `Chart ${ch.id}: invalid size`;
    if (!Array.isArray(ch.series) || ch.series.length > MAX_SERIES) return `Chart ${ch.id}: invalid series`;
    for (const s of ch.series) {
      if (!s || !isRef(s.values)) return `Chart ${ch.id}: a series needs a range of values`;
      if (s.nameRef !== undefined && !isRef(s.nameRef)) return `Chart ${ch.id}: invalid series name`;
      if (s.name !== undefined && !isText(s.name)) return `Chart ${ch.id}: invalid series name`;
      if (s.color !== undefined && !isHex(s.color)) return `Chart ${ch.id}: invalid series color`;
    }
    if (ch.categories !== undefined && !isRef(ch.categories)) return `Chart ${ch.id}: invalid labels`;
    for (const k of ['title', 'xTitle', 'yTitle'] as const) if (ch[k] !== undefined && !isText(ch[k])) return `Chart ${ch.id}: invalid ${k}`;
    if (ch.legend !== undefined && !LEGEND_POSITIONS.includes(ch.legend)) return `Chart ${ch.id}: invalid legend`;
    for (const k of ['stacked', 'logScale'] as const) if (ch[k] !== undefined && typeof ch[k] !== 'boolean') return `Chart ${ch.id}: invalid ${k}`;
  }
  return null;
}

/** A chart in a tool result or the sheet overview: its kind, place and ranges, without its pixels. */
export function chartOutline(chart: Chart) {
  return {
    id: chart.id,
    type: chart.type,
    at: `${colName(chart.anchor.c)}${chart.anchor.r + 1}`,
    size: `${Math.round(chart.w)}x${Math.round(chart.h)}`,
    ...(chart.title ? { title: chart.title } : {}),
    ...(chart.categories ? { labels: chart.categories } : {}),
    series: chart.series.map((s) => ({ values: s.values, ...(s.nameRef ? { name_cell: s.nameRef } : s.name ? { name: s.name } : {}), ...(s.color ? { color: s.color } : {}) })),
    ...(chart.stacked ? { stacked: true } : {}),
    ...(chart.logScale ? { log_scale: true } : {}),
    ...(chart.legend ? { legend: chart.legend } : {}),
    ...(chart.xTitle ? { x_title: chart.xTitle } : {}),
    ...(chart.yTitle ? { y_title: chart.yTitle } : {}),
  };
}

export { colName as chartColName };

/** A spreadsheet's chart as a slide shows it (GET /api/sheets/:id/chart): its look, data and size, and where it is. */
export interface LinkedChart {
  title: string;
  rev: string;
  tabId: string;
  tab: string;
  chart: SlideChart;
  data: ChartData;
  w: number;
  h: number;
}

/** A spreadsheet's charts, for choosing one (GET /api/sheets/:id/charts). */
export interface SheetChartList {
  title: string;
  charts: { id: string; tabId: string; tab: string; type: ChartType; title?: string }[];
}

/** The source a slide chart read from `c` keeps. */
export function chartSourceOf(sheetId: string, chartId: string, c: LinkedChart): { sheet: string; title: string; tabId: string; tab: string; chart: string; rev: string } {
  return { sheet: sheetId, title: c.title, tabId: c.tabId, tab: c.tab, chart: chartId, rev: c.rev };
}

/** A spreadsheet chart of a workbook read for a slide, or a message when there is no such chart. */
export function linkedChartOf(wb: Workbook, engine: Engine, chartId: string, meta: { title: string; rev: string }): LinkedChart | string {
  for (const tab of wb.tabs) {
    const chart = tab.charts?.find((c) => c.id === chartId);
    if (chart) return { title: meta.title, rev: meta.rev, tabId: tab.id, tab: tab.name, chart: slideChartOf(chart), data: chartData(wb, engine, tab, chart), w: chart.w, h: chart.h };
  }
  return 'The chart is no longer in the spreadsheet.';
}
