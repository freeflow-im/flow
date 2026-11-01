import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Engine } from '../shared/formula/engine.ts';
import { formatValue } from '../shared/values.ts';
import { buildApp } from './app.ts';
import { mailbox, signUp } from './testing.ts';

const box = mailbox();
import { IMPORT_LIMITS, ImportError, importExcel, importXlsx, mapNumFmt } from './xlsxImport.ts';

// A genuine BIFF8 .xls written by xlwt (formulas, formats, merge, two sheets).
const sampleXls = () => readFileSync(new URL('./fixtures/sample.xls', import.meta.url));

async function sampleXlsx(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sales Data');
  ws.getCell('A1').value = 'Item';
  ws.getCell('A1').font = { bold: true, color: { argb: 'FFFF0000' } };
  ws.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } };
  ws.getCell('B1').value = 'Qty';
  ws.getCell('B1').alignment = { horizontal: 'center' };
  ws.getCell('C1').value = 'Price';
  ws.getCell('D1').value = 'Total';
  const rows: [string, number, number][] = [
    ['Apples', 3, 1.5],
    ['Pears', 5, 2.25],
    ['Figs', 12, 0.8],
  ];
  rows.forEach(([name, q, p], i) => {
    const r = i + 2;
    ws.getCell(`A${r}`).value = name;
    ws.getCell(`B${r}`).value = q;
    ws.getCell(`C${r}`).value = p;
    ws.getCell(`C${r}`).numFmt = '"$"#,##0.00';
  });
  // Master + shared formulas down column D.
  ws.getCell('D2').value = { formula: 'B2*C2', result: 4.5 } as ExcelJS.CellFormulaValue;
  ws.getCell('D3').value = { sharedFormula: 'D2', result: 11.25 } as ExcelJS.CellSharedFormulaValue;
  ws.getCell('D4').value = { sharedFormula: 'D2', result: 9.6 } as ExcelJS.CellSharedFormulaValue;
  ws.getCell('D5').value = { formula: 'SUM(D2:D4)', result: 25.35 } as ExcelJS.CellFormulaValue;
  ws.getCell('A6').value = '001'; // text that looks like a number
  ws.getCell('A7').value = new Date(Date.UTC(2024, 1, 15));
  ws.getCell('B7').value = 0.125;
  ws.getCell('B7').numFmt = '0.0%';
  ws.getCell('A8').value = { formula: '_xlfn.XLOOKUP("Figs",A2:A4,B2:B4)', result: 12 } as ExcelJS.CellFormulaValue;
  ws.getCell('A9').value = { formula: 'NPV(0.1,B2:B4)', result: 0 } as ExcelJS.CellFormulaValue;
  ws.getCell('A10').value = { error: '#N/A' } as ExcelJS.CellErrorValue;
  ws.getCell('A11').value = { richText: [{ text: 'Rich ' }, { text: 'text', font: { bold: true } }] };
  ws.getCell('A12').value = true;
  ws.mergeCells('E1:F2');
  ws.getCell('E1').value = 'Merged';
  ws.getColumn('A').width = 20;
  ws.getRow(1).height = 30;
  ws.views = [{ state: 'frozen', xSplit: 1, ySplit: 1 }];
  ws.autoFilter = 'A1:D4';

  const summary = wb.addWorksheet('Summary');
  summary.getCell('A1').value = { formula: "'Sales Data'!D5*2", result: 50.7 } as ExcelJS.CellFormulaValue;
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('importXlsx', () => {
  it('converts values, formulas, styles and layout', async () => {
    const { workbook, warnings } = await importXlsx(await sampleXlsx());
    const [data, summary] = workbook.tabs;
    expect(workbook.tabs.map((t) => t.name)).toEqual(['Sales Data', 'Summary']);

    const c = data.cells;
    expect(c.A1).toEqual({ v: 'Item', st: { b: true, color: '#ff0000', bg: '#ffff00' } });
    expect(c.B1.st?.align).toBe('center');
    expect(c.C2.st).toMatchObject({ fmt: 'currency', dp: 2 });
    expect(c.D2.v).toBe('=B2*C2');
    expect(c.D3.v).toBe('=B3*C3');
    expect(c.D4.v).toBe('=B4*C4');
    expect(c.A6.v).toBe("'001");
    expect(c.A7.v).toBe('2/15/2024');
    expect(c.B7.st).toMatchObject({ fmt: 'percent', dp: 1 });
    expect(c.A8.v).toBe('=XLOOKUP("Figs",A2:A4,B2:B4)');
    expect(c.A10.v).toBe('=#N/A');
    expect(c.A11.v).toBe('Rich text');
    expect(c.A12.v).toBe('TRUE');
    expect(c.E1.v).toBe('Merged');
    expect(data.colWidths[0]).toBe(145);
    expect(data.rowHeights[0]).toBe(40);
    expect(data.frozenRows).toBe(1);
    expect(data.frozenCols).toBe(1);
    expect(data.filter).toEqual({ r1: 0, c1: 0, r2: 3, c2: 3, cols: {} });
    expect(summary.cells.A1.v).toBe("='Sales Data'!D5*2");

    // The imported workbook evaluates.
    const e = new Engine(workbook);
    expect(e.getValue(data.id, 4, 3)).toBeCloseTo(25.35);
    expect(e.getValue(summary.id, 0, 0)).toBeCloseTo(50.7);
    expect(e.getValue(data.id, 7, 0)).toBe(12);
    expect(e.getValue(data.id, 5, 0)).toBe('001');
    expect(formatValue(e.getValue(data.id, 6, 1), c.B7.st)).toBe('12.5%');

    expect(warnings.join('\n')).toMatch(/NPV \(1\)/);
    expect(warnings.join('\n')).toMatch(/1 merged cell range was unmerged/);
  });

  it('keeps unquoted cross-sheet references', async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet('Data');
    const ws2 = wb.addWorksheet('Report');
    ws2.getCell('A1').value = { formula: 'Data!A1+1', result: 1 } as ExcelJS.CellFormulaValue;
    const { workbook } = await importXlsx(Buffer.from(await wb.xlsx.writeBuffer()));
    expect(workbook.tabs[1].cells.A1.v).toBe('=Data!A1+1');
  });

  it('maps number formats', () => {
    expect(mapNumFmt('General')).toEqual({});
    expect(mapNumFmt('0.00%')).toEqual({ fmt: 'percent', dp: 2 });
    expect(mapNumFmt('[$$-409]#,##0.00')).toEqual({ fmt: 'currency', dp: 2 });
    expect(mapNumFmt('#,##0')).toEqual({ fmt: 'number', dp: 0 });
    expect(mapNumFmt('mm-dd-yy')).toEqual({ fmt: 'date' });
    expect(mapNumFmt('m/d/yyyy h:mm')).toEqual({ fmt: 'datetime' });
    expect(mapNumFmt('h:mm:ss AM/PM')).toEqual({ fmt: 'time' });
    expect(mapNumFmt('[Red]0.00;[Blue]-0.00')).toEqual({ fmt: 'number', dp: 2 });
    expect(mapNumFmt('@')).toEqual({ fmt: 'text' });
  });

  it('rejects non-xlsx data and zip bombs', async () => {
    await expect(importXlsx(Buffer.from('not a zip'))).rejects.toBeInstanceOf(ImportError);

    const zip = new JSZip();
    zip.file('xl/workbook.xml', '<workbook/>');
    zip.file('xl/big.bin', Buffer.alloc(IMPORT_LIMITS.maxUncompressedBytes + 1024));
    const bomb = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    expect(bomb.length).toBeLessThan(2_000_000);
    await expect(importXlsx(bomb)).rejects.toThrow(/too large/);
  }, 30_000);
});

describe('importExcel (.xls)', () => {
  it('imports legacy .xls files with values, formulas and number formats', async () => {
    const { workbook, warnings } = await importExcel(sampleXls());
    const [data, other] = workbook.tabs;
    expect(workbook.tabs.map((t) => t.name)).toEqual(['My Data', 'Other']);
    expect(data.cells.D2).toEqual({ v: '=B2*C2', st: { fmt: 'currency', dp: 2 } });
    expect(data.cells.D5.v).toBe('=SUM(D2:D4)');
    expect(data.cells.A6.v).toBe("'001");
    expect(data.cells.A7).toEqual({ v: '2/15/2024', st: { fmt: 'date' } });
    expect(data.colWidths[0]).toBeGreaterThan(150);
    expect(other.cells.A1.v).toBe("='My Data'!D5*2");
    const e = new Engine(workbook);
    expect(e.getValue(data.id, 4, 3)).toBeCloseTo(25.35);
    expect(e.getValue(other.id, 0, 0)).toBeCloseTo(50.7);
    expect(warnings[0]).toMatch(/older \.xls file/);
  });

  it('detects the format from the contents, not the name', async () => {
    await expect(importExcel(Buffer.from('Region,Units\nNorth,1'))).rejects.toThrow(/not an Excel workbook/);
    const fakeCfb = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(600)]);
    await expect(importExcel(fakeCfb)).rejects.toBeInstanceOf(ImportError);
    const { workbook } = await importExcel(await sampleXlsx());
    expect(workbook.tabs[0].name).toBe('Sales Data');
  });
});

describe('POST /api/sheets/import', () => {
  let dir: string;
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'sheetsweb-import-'));
    app = await buildApp({ dataDir: dir, sendMail: box.send });
  });
  afterAll(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('imports an uploaded workbook into a new sheet', async () => {
    const { cookie } = await signUp(app, box, 'imp@x.com');
    let res;

    res = await app.inject({
      method: 'POST',
      url: '/api/sheets/import?title=Q3%20Sales',
      headers: { cookie, 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
      payload: await sampleXlsx(),
    });
    expect(res.statusCode).toBe(200);
    const { sheet, warnings } = res.json();
    expect(sheet.title).toBe('Q3 Sales');
    expect(warnings.length).toBeGreaterThan(0);

    res = await app.inject({ method: 'GET', url: `/api/sheets/${sheet.id}`, headers: { cookie } });
    expect(res.json().workbook.tabs[0].cells.D3.v).toBe('=B3*C3');

    res = await app.inject({
      method: 'POST',
      url: '/api/sheets/import',
      headers: { cookie, 'content-type': 'application/octet-stream' },
      payload: Buffer.from('garbage'),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/not an Excel workbook/);

    res = await app.inject({ method: 'POST', url: '/api/sheets/import', headers: { 'content-type': 'application/octet-stream' }, payload: Buffer.from('x') });
    expect(res.statusCode).toBe(401);

    // Convert-only endpoint returns tabs and stores nothing.
    const before = (await app.inject({ method: 'GET', url: '/api/sheets', headers: { cookie } })).json().sheets.length;
    res = await app.inject({
      method: 'POST',
      url: '/api/import/xlsx',
      headers: { cookie, 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
      payload: await sampleXlsx(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().workbook.tabs.map((t: { name: string }) => t.name)).toEqual(['Sales Data', 'Summary']);
    const after = (await app.inject({ method: 'GET', url: '/api/sheets', headers: { cookie } })).json().sheets.length;
    expect(after).toBe(before);

    res = await app.inject({
      method: 'POST',
      url: '/api/import/xlsx',
      headers: { cookie, 'content-type': 'application/vnd.ms-excel' },
      payload: sampleXls(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().workbook.tabs[0].cells.D5.v).toBe('=SUM(D2:D4)');
  });
});
