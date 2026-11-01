import { describe, expect, it } from 'vitest';
import { csvProblem, csvStyle, csvToWorkbook, formatCsv, isCsvDoc, newCsvDoc, parseCsv, workbookToCsv } from './csv.ts';
import { newWorkbook } from './types.ts';

describe('parseCsv', () => {
  it('reads plain rows, with or without a final line break', () => {
    expect(parseCsv('a,b\n1,2\n')).toEqual([['a', 'b'], ['1', '2']]);
    expect(parseCsv('a,b\r\n1,2')).toEqual([['a', 'b'], ['1', '2']]);
    expect(parseCsv('')).toEqual([]);
  });

  it('reads quoted fields with commas, quotes and line breaks', () => {
    expect(parseCsv('"a,b","say ""hi""","line\nbreak"\n')).toEqual([['a,b', 'say "hi"', 'line\nbreak']]);
  });

  it('keeps empty fields, blank lines and ragged rows', () => {
    expect(parseCsv('a,,c\n\n1\n,\n')).toEqual([['a', '', 'c'], [''], ['1'], ['', '']]);
    expect(parseCsv('""\n')).toEqual([['']]);
  });

  it('drops a byte-order mark', () => {
    expect(parseCsv('﻿a,b')).toEqual([['a', 'b']]);
  });
});

describe('CSV workbooks', () => {
  it('opens a CSV as one tab of raw values and writes the same text back', () => {
    const text = 'Item,"Price, each",Note\nPen,1.50,\nTotal,=B2*2,"a ""b"""\n';
    const wb = csvToWorkbook(text);
    expect(wb.tabs).toHaveLength(1);
    const { cells } = wb.tabs[0];
    expect(cells.B1).toEqual({ v: 'Price, each' });
    expect(cells.B3).toEqual({ v: '=B2*2' });
    expect(cells.C2).toBeUndefined();
    expect(csvProblem(wb)).toBeNull();
    expect(workbookToCsv(wb, csvStyle(text))).toBe(text);
  });

  it('grows the tab to fit a large file', () => {
    const wb = csvToWorkbook(Array.from({ length: 1500 }, (_, i) => `${i},${'x,'.repeat(30)}`).join('\n'));
    expect(wb.tabs[0].rows).toBe(1500);
    expect(wb.tabs[0].cols).toBe(32);
    expect(wb.tabs[0].cells.AE1500).toEqual({ v: 'x' });
  });

  it('keeps the line endings, final line break and byte-order mark of the file', () => {
    const text = '﻿a,b\r\n1,2';
    const style = csvStyle(text);
    expect(style).toEqual({ eol: '\r\n', finalEol: false, bom: true });
    const wb = csvToWorkbook(text);
    wb.tabs[0].cells.B2 = { v: '3' };
    expect(workbookToCsv(wb, style)).toBe('﻿a,b\r\n1,3');
  });

  it('writes a full rectangle and quotes what needs it', () => {
    expect(formatCsv([['a', ' padded '], ['x\ny', '']])).toBe('a," padded "\n"x\ny",\n');
    const wb = newWorkbook('t');
    wb.tabs[0].cells = { A1: { v: 'a' }, C2: { v: 'c' } };
    expect(workbookToCsv(wb)).toBe('a,,\n,,c\n');
    wb.tabs[0].cells = {};
    expect(workbookToCsv(wb)).toBe('');
  });

  it('names what CSV cannot store', () => {
    const base = () => csvToWorkbook('a,b\n1,2\n');
    let wb = base();
    wb.tabs[0].cells.A1 = { v: 'a', st: { b: true } };
    expect(csvProblem(wb)).toBe('Cell formatting');
    wb = base();
    wb.tabs[0].cells.A1 = { v: '', img: 'https://example.com/a.png' };
    expect(csvProblem(wb)).toBe('Images');
    wb = base();
    wb.tabs[0].colWidths = { 0: 200 };
    expect(csvProblem(wb)).toBe('Column widths');
    wb = base();
    wb.tabs[0].frozenRows = 1;
    expect(csvProblem(wb)).toBe('Frozen rows and columns');
    wb = base();
    wb.tabs[0].filter = { r1: 0, c1: 0, r2: 1, c2: 1, cols: {} };
    expect(csvProblem(wb)).toBe('Filters');
    wb = base();
    wb.tabs.push({ ...newWorkbook('x').tabs[0], name: 'Sheet2' });
    expect(csvProblem(wb)).toBe('More than one sheet');
  });

  it('tells a CSV document from a workbook', () => {
    expect(isCsvDoc(newCsvDoc('a,b'))).toBe(true);
    expect(isCsvDoc(newWorkbook('t'))).toBe(false);
    expect(isCsvDoc(null)).toBe(false);
  });
});
