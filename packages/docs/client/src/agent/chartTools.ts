// The assistant's chart tools (add_chart, edit_chart, delete_chart), run on the open spreadsheet like its other
// sheet tools (clientTools.ts): each change is part of the request's undo step, and the chart is shown.
import { parseRangeString, type Range } from '../../../shared/cellref.ts';
import { chartOutline, MAX_CHARTS, refText, resolveRef, suggestChart, validateCharts, type Chart, type ChartSeries } from '../../../shared/chart.ts';
import type { Tab } from '../../../shared/types.ts';
import type { SheetController } from '../state/controller.ts';
import { ToolError } from './toolError.ts';

type Input = Record<string, unknown>;

/** A range the assistant gave, checked, as the chart keeps it (from the chart's tab, the tab's name only when it is another). */
function ref(ctl: SheetController, tab: Tab, given: string, what: string): string {
  const r = resolveRef(ctl.store.workbook, tab, given);
  if (typeof r === 'string') throw new ToolError(`${what}: ${r}.`);
  return refText(tab, r.tab, r.range);
}

function cellAt(tab: Tab, at: string): { r: number; c: number } {
  const rg = parseRangeString(at, tab.rows, tab.cols);
  if (!rg) throw new ToolError(`"${at}" is not a cell. Give the top-left cell, e.g. "H2".`);
  return { r: rg.r1, c: rg.c1 };
}

/** The chart with the spec's fields: what is given changes, "" removes a text, series replaces the series. */
function applySpec(ctl: SheetController, tab: Tab, chart: Chart, i: Input): Chart {
  const next: Chart = { ...chart };
  const bag = next as unknown as Record<string, unknown>;
  if (typeof i.type === 'string') next.type = i.type as Chart['type'];
  const text = (key: keyof Chart, v: unknown) => {
    if (typeof v !== 'string') return;
    if (v.trim()) bag[key] = v.trim();
    else delete bag[key];
  };
  text('title', i.title);
  text('xTitle', i.x_title);
  text('yTitle', i.y_title);
  if (typeof i.labels === 'string') {
    if (i.labels.trim()) next.categories = ref(ctl, tab, i.labels, 'labels');
    else delete next.categories;
  }
  if (Array.isArray(i.series)) {
    next.series = (i.series as Input[]).map((s, k): ChartSeries => {
      const out: ChartSeries = { values: ref(ctl, tab, String(s.values), `series ${k + 1}`) };
      if (typeof s.name === 'string' && s.name.trim()) {
        // A cell reference names the series from that cell; anything else is the name itself.
        const named = /^('?[^!]*'?!)?\$?[A-Za-z]{1,3}\$?\d+$/.test(s.name.trim()) ? resolveRef(ctl.store.workbook, tab, s.name.trim()) : null;
        if (named && typeof named !== 'string') out.nameRef = refText(tab, named.tab, named.range);
        else out.name = s.name.trim();
      }
      if (typeof s.color === 'string') out.color = s.color.toLowerCase();
      return out;
    });
  }
  for (const [key, given] of [
    ['stacked', i.stacked],
    ['logScale', i.log_scale],
  ] as const) {
    if (given === true) bag[key] = true;
    else if (given === false) delete bag[key];
  }
  if (typeof i.legend === 'string') next.legend = i.legend as Chart['legend'];
  if (typeof i.at === 'string') next.anchor = { ...cellAt(tab, i.at), dx: 0, dy: 0 };
  if (typeof i.width === 'number') next.w = i.width;
  if (typeof i.height === 'number') next.h = i.height;
  if (!next.series.length) throw new ToolError('A chart needs at least one series.');
  const problem = validateCharts([next]);
  if (problem) throw new ToolError(problem);
  return next;
}

function chartOf(ctl: SheetController, tab: Tab, id: unknown): Chart {
  const chart = tab.charts?.find((c) => c.id === id);
  if (!chart) {
    const ids = (tab.charts ?? []).map((c) => c.id);
    throw new ToolError(`"${tab.name}" has no chart "${String(id)}".${ids.length ? ` Its charts: ${ids.join(', ')}.` : ' It has no charts.'}`);
  }
  return chart;
}

export function addChart(ctl: SheetController, tab: Tab, i: Input, run: (fn: Parameters<SheetController['runAgent']>[1]) => boolean): string {
  if ((tab.charts?.length ?? 0) >= MAX_CHARTS) throw new ToolError(`A tab holds at most ${MAX_CHARTS} charts.`);
  const id = crypto.randomUUID();
  let base: Chart;
  if (typeof i.data_range === 'string' && i.data_range.trim()) {
    const at = resolveRef(ctl.store.workbook, tab, i.data_range);
    if (typeof at === 'string') throw new ToolError(`data_range: ${at}.`);
    if (at.tab.id !== tab.id) throw new ToolError('data_range must be on the chart\'s tab; give labels and series to chart another tab\'s data.');
    const rg: Range = at.range;
    const suggested = suggestChart(ctl.store.engine, tab, rg, id, { r: rg.r1, c: Math.min(rg.c2 + 1, tab.cols - 1), dx: 12, dy: 0 });
    if (!suggested) throw new ToolError(`There are no numbers to chart in ${i.data_range}.`);
    base = suggested;
  } else {
    if (!Array.isArray(i.series)) throw new ToolError('Give data_range, or series (with labels) to chart.');
    base = { id, type: 'column', anchor: { r: 0, c: 0, dx: 0, dy: 0 }, w: 600, h: 371, series: [] };
  }
  const chart = applySpec(ctl, tab, base, i);
  // Without a place, beside the data: right of the last column a series reads, at the first row.
  if (typeof i.at !== 'string' && !(typeof i.data_range === 'string' && i.data_range.trim())) {
    const own = chart.series.map((s) => resolveRef(ctl.store.workbook, tab, s.values)).filter((r): r is { tab: Tab; range: Range } => typeof r !== 'string' && r.tab.id === tab.id);
    if (own.length) chart.anchor = { r: Math.min(...own.map((r) => r.range.r1)), c: Math.min(tab.cols - 1, Math.max(...own.map((r) => r.range.c2)) + 1), dx: 12, dy: 0 };
  }
  run((tx) => tx.setTabProp(tab.id, 'charts', [...(tx.tab(tab.id).charts ?? []), chart]));
  ctl.selectChart(chart.id);
  return JSON.stringify({ added: chartOutline(chart) });
}

export function editChart(ctl: SheetController, tab: Tab, i: Input, run: (fn: Parameters<SheetController['runAgent']>[1]) => boolean): string {
  const chart = chartOf(ctl, tab, i.chart_id);
  const next = applySpec(ctl, tab, chart, i);
  run((tx) => tx.setTabProp(tab.id, 'charts', (tx.tab(tab.id).charts ?? []).map((c) => (c.id === chart.id ? next : c))));
  ctl.selectChart(chart.id);
  return JSON.stringify({ changed: chartOutline(next) });
}

export function deleteChart(ctl: SheetController, tab: Tab, i: Input, run: (fn: Parameters<SheetController['runAgent']>[1]) => boolean): string {
  const chart = chartOf(ctl, tab, i.chart_id);
  run((tx) => {
    const rest = (tx.tab(tab.id).charts ?? []).filter((c) => c.id !== chart.id);
    tx.setTabProp(tab.id, 'charts', rest.length ? rest : undefined);
  });
  return JSON.stringify({ deleted: chart.id });
}
