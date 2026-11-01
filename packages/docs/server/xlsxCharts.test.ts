import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import type { Chart } from '../shared/chart.ts';
import { newTab, type Workbook } from '../shared/types.ts';
import { workbookXlsx } from './export.ts';
import { importXlsx } from './xlsxImport.ts';
import { readChart } from './xlsxCharts.ts';

function book(): Workbook {
  const prices = newTab('t1', 'Prices 2025');
  prices.colWidths = { 0: 120 };
  prices.cells = {
    A1: { v: 'Month' },
    B1: { v: 'Input' },
    C1: { v: 'Output' },
    A2: { v: 'Jan' },
    B2: { v: '10', st: { fmt: 'currency', dp: 2 } },
    C2: { v: '=B2*3' },
    A3: { v: 'Feb' },
    B3: { v: '8' },
    C3: { v: '' },
    A4: { v: 'Mar' },
    B4: { v: '0.5' },
    C4: { v: '2' },
  };
  const charts: Chart[] = [
    { id: 'c1', type: 'line', anchor: { r: 1, c: 4, dx: 12, dy: 3 }, w: 600, h: 371, title: 'Prices & costs', categories: 'A2:A4', series: [{ values: 'B2:B4', nameRef: 'B1', color: '#ff0000' }, { values: 'C2:C4', name: 'Out' }], legend: 'bottom', logScale: true, xTitle: 'Month', yTitle: 'USD' },
    { id: 'c2', type: 'bar', anchor: { r: 20, c: 0, dx: 0, dy: 0 }, w: 400, h: 300, categories: 'A2:A4', series: [{ values: 'B2:B4' }, { values: 'C2:C4' }], stacked: true, legend: 'right' },
    { id: 'c3', type: 'scatter', anchor: { r: 20, c: 6, dx: 0, dy: 0 }, w: 400, h: 300, categories: 'B2:B4', series: [{ values: 'C2:C4' }], legend: 'none' },
  ];
  prices.charts = charts;
  const other = newTab('t2', 'Notes');
  other.cells = { A1: { v: 'x' } };
  other.charts = [{ id: 'c4', type: 'pie', anchor: { r: 2, c: 2, dx: 0, dy: 0 }, w: 300, h: 300, categories: "'Prices 2025'!A2:A4", series: [{ values: "'Prices 2025'!B2:B4", nameRef: "'Prices 2025'!B1" }], legend: 'right' }];
  return { version: 1, tabs: [prices, other] };
}

const strip = (c: Chart) => {
  const { id: _id, ...rest } = c;
  return rest;
};

describe('charts in Excel files', () => {
  it('writes chart parts Excel reads (with cached values), and reads them back as the same charts', async () => {
    const wb = book();
    const file = await workbookXlsx(wb, 'Charts');
    const zip = await JSZip.loadAsync(file);
    const names = Object.keys(zip.files);
    expect(names.filter((n) => /^xl\/charts\/chart\d+\.xml$/.test(n))).toHaveLength(4);
    expect(names).toContain('xl/drawings/drawing1.xml');
    const types = await zip.file('[Content_Types].xml')!.async('string');
    expect(types).toContain('PartName="/xl/charts/chart1.xml"');
    expect(types).toContain('PartName="/xl/drawings/drawing2.xml"');
    const sheet = await zip.file('xl/worksheets/sheet1.xml')!.async('string');
    expect(sheet).toMatch(/<drawing r:id="rId\d+"\/><\/worksheet>|<drawing r:id="rId\d+"\/><(tableParts|extLst)/);
    const line = await zip.file('xl/charts/chart1.xml')!.async('string');
    // References are absolute and quoted; the values are cached (a formula's result; the empty cell left out).
    expect(line).toContain("<c:f>'Prices 2025'!$B$2:$B$4</c:f>");
    expect(line).toContain("<c:f>'Prices 2025'!$A$2:$A$4</c:f>");
    expect(line).toContain('<c:pt idx="0"><c:v>30</c:v></c:pt><c:pt idx="2"><c:v>2</c:v></c:pt>');
    expect(line).toContain('<c:logBase val="10"/>');
    expect(line).toContain('<a:t>Prices &amp; costs</a:t>');

    const back = await importXlsx(file);
    expect(back.lost).not.toContain('Charts');
    expect(back.warnings.join(' ')).not.toMatch(/chart/);
    const [prices, notes] = back.workbook.tabs;
    expect(prices.charts!.map(strip)).toEqual(wb.tabs[0].charts!.map(strip));
    expect(notes.charts!.map(strip)).toEqual([{ ...strip(wb.tabs[1].charts![0]), categories: "'Prices 2025'!A2:A4" }]);
    // Each chart keeps its id, so a slide linked to it still finds it after the file is read again.
    expect(back.workbook.tabs.flatMap((t) => t.charts!.map((c) => c.id))).toEqual(wb.tabs.flatMap((t) => t.charts!.map((c) => c.id)));
  });

  it('gives a chart made elsewhere the same id every time the file is read', async () => {
    const zip = await JSZip.loadAsync(await workbookXlsx(book(), 'Charts'));
    // As Excel would have written it: no id of ours.
    for (const n of Object.keys(zip.files).filter((f) => /^xl\/drawings\/drawing\d+\.xml$/.test(f))) {
      zip.file(n, (await zip.file(n)!.async('string')).replace(/<a:extLst>.*?<\/a:extLst>/g, ''));
    }
    const file = Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
    const ids = async () => (await importXlsx(file)).workbook.tabs.flatMap((t) => (t.charts ?? []).map((c) => c.id));
    const first = await ids();
    expect(first).toEqual(['xlsx-1-2', 'xlsx-1-3', 'xlsx-1-4', 'xlsx-2-2']);
    expect(await ids()).toEqual(first);
  });

  it('reads a workbook whose drawings are named by absolute paths (as openpyxl writes them), which ExcelJS fails on', async () => {
    const zip = await JSZip.loadAsync(await workbookXlsx(book(), 'Charts'));
    for (const n of Object.keys(zip.files).filter((f) => f.endsWith('.rels'))) {
      const xml = await zip.file(n)!.async('string');
      zip.file(n, xml.replace(/Target="\.\.\/(drawings|charts)\//g, 'Target="/xl/$1/'));
    }
    const back = await importXlsx(Buffer.from(await zip.generateAsync({ type: 'nodebuffer' })));
    expect(back.workbook.tabs[0].charts).toHaveLength(3);
    expect(back.workbook.tabs[0].cells.B2.v).toBe('10');
  });

  it('reads the kinds ours can be and leaves out the others', () => {
    const wrap = (plot: string) => `<c:chartSpace xmlns:c="c" xmlns:a="a"><c:chart><c:plotArea>${plot}</c:plotArea></c:chart></c:chartSpace>`;
    const ser = '<c:ser><c:idx val="0"/><c:tx><c:v>Sales</c:v></c:tx><c:cat><c:strRef><c:f>Sheet1!$A$2:$A$5</c:f></c:strRef></c:cat><c:val><c:numRef><c:f>Data!$B$2:$B$5</c:f></c:numRef></c:val></c:ser>';
    expect(readChart(wrap(`<c:bar3DChart><c:barDir val="bar"/><c:grouping val="percentStacked"/>${ser}</c:bar3DChart>`), 'Sheet1', new Map(), 'x')).toEqual({
      id: 'x',
      type: 'bar',
      stacked: true,
      categories: 'A2:A5',
      series: [{ values: 'Data!B2:B5', name: 'Sales' }],
      legend: 'none',
    });
    expect(readChart(wrap(`<c:doughnutChart>${ser}</c:doughnutChart>`), 'Sheet1', new Map([['Data', 'My data']]), 'x')).toMatchObject({ type: 'pie', series: [{ values: "'My data'!B2:B5" }] });
    // A combination of two kinds, a radar chart, and a series over several areas are not ours.
    expect(readChart(wrap(`<c:barChart>${ser}</c:barChart><c:lineChart>${ser}</c:lineChart>`), 'Sheet1', new Map(), 'x')).toBeNull();
    expect(readChart(wrap(`<c:radarChart>${ser}</c:radarChart>`), 'Sheet1', new Map(), 'x')).toBeNull();
    expect(readChart(wrap(`<c:lineChart>${ser.replace('Data!$B$2:$B$5', '(Data!$B$2,Data!$B$4)')}</c:lineChart>`), 'Sheet1', new Map(), 'x')).toBeNull();
  });
});
