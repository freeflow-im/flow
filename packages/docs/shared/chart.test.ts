import { describe, expect, it } from 'vitest';
import { Engine } from './formula/engine.ts';
import { newTab, type Tab, type Workbook } from './types.ts';
import { adjustCharts, chartData, formatTick, suggestChart, validateCharts, type Chart } from './chart.ts';
import { linearScale, logScale } from './chartScale.ts';

function book(): { wb: Workbook; tab: Tab; other: Tab } {
  const tab = newTab('t1', 'Prices');
  tab.cells = {
    A1: { v: 'Date' },
    B1: { v: 'Model' },
    C1: { v: 'Input' },
    D1: { v: 'Output' },
    A2: { v: '2023-03' },
    B2: { v: 'gpt-4' },
    C2: { v: '30', st: { fmt: 'currency', dp: 2 } },
    D2: { v: '=C2*2' },
    A3: { v: '2024-05' },
    B3: { v: 'gpt-4o' },
    C3: { v: '5' },
    D3: { v: '' },
    A4: { v: '2025-04' },
    B4: { v: 'o3' },
    C4: { v: '2' },
    D4: { v: '8' },
  };
  const other = newTab('t2', 'My data');
  other.cells = { A1: { v: '1' }, A2: { v: '2' } };
  return { wb: { version: 1, tabs: [tab, other] }, tab, other };
}

const anchor = { r: 0, c: 5, dx: 0, dy: 0 };

describe('charts', () => {
  it('suggests the usual chart of a table: header names, a label column, a series per numeric column', () => {
    const { wb, tab } = book();
    const ch = suggestChart(new Engine(wb), tab, { r1: 0, c1: 0, r2: 3, c2: 3 }, 'c1', anchor)!;
    // Dates as labels make it a line chart; the text column B is not a series.
    expect(ch).toMatchObject({ type: 'line', categories: 'A2:A4', legend: 'bottom', series: [{ values: 'C2:C4', nameRef: 'C1' }, { values: 'D2:D4', nameRef: 'D1' }] });
    // Only the columns picked (Ctrl-click): the labels and Output.
    const picked = suggestChart(new Engine(wb), tab, { r1: 0, c1: 0, r2: 3, c2: 3 }, 'c2', anchor, (c) => c === 0 || c === 3)!;
    expect(picked.series).toEqual([{ values: 'D2:D4', nameRef: 'D1' }]);
    // Two columns of numbers with no labels: a scatter chart of y against x.
    const xy = suggestChart(new Engine(wb), tab, { r1: 1, c1: 2, r2: 3, c2: 3 }, 'c3', anchor)!;
    expect(xy).toMatchObject({ type: 'scatter', categories: 'C2:C4', series: [{ values: 'D2:D4' }] });
    expect(suggestChart(new Engine(wb), tab, { r1: 0, c1: 0, r2: 3, c2: 1 }, 'c4', anchor)).toBeNull();
  });

  it('reads values through formulas, names from cells, gaps for empty cells, and the values’ format', () => {
    const { wb, tab } = book();
    const chart: Chart = { id: 'c', type: 'column', anchor, w: 600, h: 371, categories: 'A2:A4', series: [{ values: 'C2:C4', nameRef: 'C1' }, { values: 'D2:D4', name: 'Out', color: '#000000' }, { values: "'My data'!A1:A2" }] };
    const data = chartData(wb, new Engine(wb), tab, chart);
    expect(data.categories).toEqual(['2023-03', '2024-05', '2025-04']);
    expect(data.series.map((s) => [s.name, s.color, s.points.map((p) => p.y)])).toEqual([
      ['Input', '#4285f4', [30, 5, 2]],
      ['Out', '#000000', [60, null, 8]],
      ['Series 3', '#fbbc04', [1, 2]],
    ]);
    expect(data.format).toEqual({ fmt: 'currency', dp: 2 });
    expect(chartData(wb, new Engine(wb), tab, { ...chart, series: [{ values: "'Nope'!A1:A2" }] }).error).toMatch(/no tab named "Nope"/);
    expect(chartData(wb, new Engine(wb), tab, { ...chart, series: [{ values: '#REF!' }] }).error).toMatch(/deleted/);
  });

  it('follows inserted, deleted and moved rows and columns and renamed tabs, as formulas do', () => {
    const { tab, other } = book();
    const charts: Chart[] = [{ id: 'c', type: 'line', anchor: { r: 5, c: 5, dx: 4, dy: 2 }, w: 600, h: 371, categories: 'A2:A4', series: [{ values: 'C2:C4', nameRef: 'C1' }, { values: "'My data'!A1:A2" }] }];
    const rows = adjustCharts(charts, tab, { kind: 'insert', tab: 'Prices', axis: 'row', at: 2, count: 2 }, (i) => (i >= 2 ? i + 2 : i))!;
    expect(rows[0]).toMatchObject({ anchor: { r: 7, c: 5, dx: 4, dy: 2 }, categories: 'A2:A6', series: [{ values: 'C2:C6', nameRef: 'C1' }, { values: "'My data'!A1:A2" }] });
    const cols = adjustCharts(charts, tab, { kind: 'delete', tab: 'Prices', axis: 'col', from: 1, to: 1 }, (i) => (i < 1 ? i : i > 1 ? i - 1 : null))!;
    expect(cols[0]).toMatchObject({ anchor: { c: 4 }, series: [{ values: 'B2:B4', nameRef: 'B1' }, {}] });
    const gone = adjustCharts(charts, tab, { kind: 'delete', tab: 'Prices', axis: 'col', from: 2, to: 2 }, (i) => (i < 2 ? i : i > 2 ? i - 1 : null))!;
    expect(gone[0].series[0].values).toContain('#REF!');
    // The other tab's rows: this tab's anchors stay, references to that tab move.
    const there = adjustCharts(charts, tab, { kind: 'insert', tab: 'My data', axis: 'row', at: 0, count: 1 }, (i) => i + 1)!;
    expect(there[0]).toMatchObject({ anchor: { r: 5 }, series: [{ values: 'C2:C4' }, { values: "'My data'!A2:A3" }] });
    const renamed = adjustCharts(charts, other, { kind: 'rename', from: 'My data', to: 'Data' })!;
    expect(renamed[0].series[1].values).toBe('Data!A1:A2');
  });

  it('validates charts', () => {
    const ok: Chart = { id: 'c', type: 'pie', anchor, w: 300, h: 200, series: [{ values: 'A1:A3' }] };
    expect(validateCharts([ok])).toBeNull();
    expect(validateCharts([ok, ok])).toMatch(/duplicate/);
    expect(validateCharts([{ ...ok, type: 'radar' }])).toMatch(/unknown type/);
    expect(validateCharts([{ ...ok, series: [{ values: '' }] }])).toMatch(/range of values/);
    expect(validateCharts([{ ...ok, w: 5 }])).toMatch(/size/);
    expect(validateCharts([{ ...ok, series: [{ values: 'A1:A2', color: 'red' }] }])).toMatch(/color/);
  });

  it('labels axes in the values’ format with the decimals the ticks need', () => {
    expect(formatTick(20, { fmt: 'number', dp: 5 }, 20)).toBe('20');
    expect(formatTick(0.025, { fmt: 'number', dp: 5 }, 0.005)).toBe('0.025');
    expect(formatTick(0.5, { fmt: 'percent', dp: 2 }, 0.25)).toBe('50%');
    expect(formatTick(1000, { fmt: 'currency', dp: 2 }, 500)).toBe('$1,000');
  });

  it('makes round ticks over the data, from zero for bars, and decades on a log axis', () => {
    expect(linearScale([3, 47], true).ticks).toEqual([0, 10, 20, 30, 40, 50]);
    expect(linearScale([12, 18], false)).toMatchObject({ lo: 12, hi: 18 });
    expect(linearScale([-3, 4], true).ticks).toEqual([-4, -2, 0, 2, 4]);
    const log = logScale([0.0003, 0.06, 0]);
    expect(log.ticks).toEqual([0.0001, 0.001, 0.01, 0.1]);
    expect(log.at(0.001)).toBeCloseTo(1 / 3);
  });
});
