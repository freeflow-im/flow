import { describe, expect, it } from 'vitest';
import { newTab, type Workbook } from '../types.ts';
import { CellError, dateToSerial, formatValue } from '../values.ts';
import { adjustForDelete, adjustForInsert, renameSheetRefs, shiftFormula } from './adjust.ts';
import { Engine } from './engine.ts';

function wb(cells: Record<string, string>, extra: Record<string, Record<string, string>> = {}): Workbook {
  const t = newTab('t1', 'Sheet1');
  for (const [k, v] of Object.entries(cells)) t.cells[k] = { v };
  const tabs = [t];
  for (const [name, cs] of Object.entries(extra)) {
    const x = newTab('id-' + name, name);
    for (const [k, v] of Object.entries(cs)) x.cells[k] = { v };
    tabs.push(x);
  }
  return { version: 1, tabs };
}

function val(e: Engine, key: string, tab = 't1') {
  const m = /^([A-Z]+)(\d+)$/.exec(key)!;
  const c = m[1].charCodeAt(0) - 65;
  return e.getValue(tab, +m[2] - 1, c);
}

describe('links', () => {
  it('evaluates HYPERLINK to its label and detects plain-text URLs', () => {
    const e = new Engine(
      wb({
        A1: '=HYPERLINK("https://example.com", "Example")',
        A2: '=HYPERLINK("https://example.com/a")',
        A3: '=HYPERLINK(B1, B2)',
        A4: '=HYPERLINK("javascript:alert(1)", "x")',
        A5: 'https://en.wikipedia.org/wiki/Eat_a_Peach',
        A6: 'n/a (original)',
        A7: 'see https://example.com',
        A8: '=HYPERLINK("mailto:a@b.co", "Mail")',
        B1: 'http://x.org',
        B2: 'X',
      }),
    );
    expect(val(e, 'A1')).toBe('Example');
    expect(e.getLink('t1', 0, 0)).toBe('https://example.com');
    expect(val(e, 'A2')).toBe('https://example.com/a');
    expect(e.getLink('t1', 1, 0)).toBe('https://example.com/a');
    expect(val(e, 'A3')).toBe('X');
    expect(e.getLink('t1', 2, 0)).toBe('http://x.org');
    expect(val(e, 'A4')).toBe('x');
    expect(e.getLink('t1', 3, 0)).toBeNull();
    expect(e.getLink('t1', 4, 0)).toBe('https://en.wikipedia.org/wiki/Eat_a_Peach');
    expect(e.getLink('t1', 5, 0)).toBeNull();
    expect(e.getLink('t1', 6, 0)).toBeNull();
    expect(e.getLink('t1', 7, 0)).toBe('mailto:a@b.co');
  });
});

describe('engine basics', () => {
  it('evaluates arithmetic with precedence', () => {
    const e = new Engine(wb({ A1: '=1+2*3', A2: '=(1+2)*3', A3: '=-2^2', A4: '=2^3^2', A5: '=10%', A6: '="a"&1&TRUE' }));
    expect(val(e, 'A1')).toBe(7);
    expect(val(e, 'A2')).toBe(9);
    expect(val(e, 'A3')).toBe(4);
    expect(val(e, 'A4')).toBe(64);
    expect(val(e, 'A5')).toBeCloseTo(0.1);
    expect(val(e, 'A6')).toBe('a1TRUE');
  });

  it('references and literals', () => {
    const e = new Engine(wb({ A1: '5', A2: '$1,000', A3: '50%', B1: '=A1+A2+A3', B2: '=A9', B3: '=A1=5' }));
    expect(val(e, 'B1')).toBeCloseTo(1005.5);
    expect(val(e, 'B2')).toBe(null);
    expect(val(e, 'B3')).toBe(true);
  });

  it('aggregates', () => {
    const e = new Engine(
      wb({
        A1: '1',
        A2: '2',
        A3: 'x',
        A4: '',
        A5: '4',
        B1: '=SUM(A1:A5)',
        B2: '=AVERAGE(A1:A5)',
        B3: '=COUNT(A1:A5)',
        B4: '=COUNTA(A1:A5)',
        B5: '=MAX(A:A)',
        B6: '=MIN(A1:A5, -3)',
        B7: '=MEDIAN(A1:A5)',
        B8: '=SUM("3", TRUE)',
        B9: '=COUNTBLANK(A1:A5)',
      }),
    );
    expect(val(e, 'B1')).toBe(7);
    expect(val(e, 'B2')).toBeCloseTo(7 / 3);
    expect(val(e, 'B3')).toBe(3);
    expect(val(e, 'B4')).toBe(4);
    expect(val(e, 'B5')).toBe(4);
    expect(val(e, 'B6')).toBe(-3);
    expect(val(e, 'B7')).toBe(2);
    expect(val(e, 'B8')).toBe(4);
    expect(val(e, 'B9')).toBe(1);
  });

  it('conditional aggregates', () => {
    const e = new Engine(
      wb({
        A1: 'apple', B1: '10',
        A2: 'banana', B2: '20',
        A3: 'apple', B3: '30',
        A4: 'cherry', B4: '40',
        C1: '=SUMIF(A1:A4,"apple",B1:B4)',
        C2: '=COUNTIF(B1:B4,">15")',
        C3: '=AVERAGEIF(A1:A4,"a*",B1:B4)',
        C4: '=SUMIFS(B1:B4,A1:A4,"<>apple",B1:B4,"<40")',
        C5: '=COUNTIFS(A1:A4,"apple",B1:B4,">=30")',
        C6: '=MAXIFS(B1:B4,A1:A4,"apple")',
      }),
    );
    expect(val(e, 'C1')).toBe(40);
    expect(val(e, 'C2')).toBe(3);
    expect(val(e, 'C3')).toBe(20);
    expect(val(e, 'C4')).toBe(20);
    expect(val(e, 'C5')).toBe(1);
    expect(val(e, 'C6')).toBe(30);
  });

  it('lookups', () => {
    const e = new Engine(
      wb({
        A1: 'a', B1: '1',
        A2: 'b', B2: '2',
        A3: 'c', B3: '3',
        C1: '=VLOOKUP("b",A1:B3,2,FALSE)',
        C2: '=MATCH("c",A1:A3,0)',
        C3: '=INDEX(A1:B3,3,2)',
        C4: '=XLOOKUP("a",A1:A3,B1:B3)',
        C5: '=VLOOKUP("z",A1:B3,2,FALSE)',
        C6: '=IFERROR(C5,"none")',
      }),
    );
    expect(val(e, 'C1')).toBe(2);
    expect(val(e, 'C2')).toBe(3);
    expect(val(e, 'C3')).toBe(3);
    expect(val(e, 'C4')).toBe(1);
    expect((val(e, 'C5') as CellError).code).toBe('#N/A');
    expect(val(e, 'C6')).toBe('none');
  });

  it('text and logic', () => {
    const e = new Engine(
      wb({
        A1: '  Hello   World ',
        B1: '=TRIM(A1)',
        B2: '=UPPER(LEFT(B1,5))',
        B3: '=IF(LEN(B1)>5,"long","short")',
        B4: '=AND(TRUE,1,NOT(FALSE))',
        B5: '=TEXTJOIN("-",TRUE,"a","","b")',
        B6: '=SUBSTITUTE("aaa","a","b",2)',
        B7: '=TEXT(1234.5,"$#,##0.00")',
        B8: '=TEXT(0.256,"0.0%")',
      }),
    );
    expect(val(e, 'B1')).toBe('Hello World');
    expect(val(e, 'B2')).toBe('HELLO');
    expect(val(e, 'B3')).toBe('long');
    expect(val(e, 'B4')).toBe(true);
    expect(val(e, 'B5')).toBe('a-b');
    expect(val(e, 'B6')).toBe('aba');
    expect(val(e, 'B7')).toBe('$1,234.50');
    expect(val(e, 'B8')).toBe('25.6%');
  });

  it('dates', () => {
    const e = new Engine(wb({ A1: '2024-02-15', B1: '=YEAR(A1)', B2: '=EOMONTH(A1,0)', B3: '=A1+1', B4: '=DATE(2024,1,31)' }));
    expect(val(e, 'A1')).toBe(dateToSerial(2024, 2, 15));
    expect(val(e, 'B1')).toBe(2024);
    expect(val(e, 'B2')).toBe(dateToSerial(2024, 2, 29));
    expect(e.getImpliedFormat('t1', 0, 1 + 1)).toBeUndefined(); // C1 empty
    expect(e.getImpliedFormat('t1', 2, 1)?.fmt).toBe('date'); // B3 = A1+1 keeps date format
    expect(formatValue(val(e, 'B4'), undefined, e.getImpliedFormat('t1', 3, 1))).toBe('1/31/2024');
  });

  it('errors and cycles', () => {
    const e = new Engine(wb({ A1: '=1/0', A2: '=B2', B2: '=A2', A3: '=FOO(1)', A4: '=1+', A5: '=A1+1' }));
    expect((val(e, 'A1') as CellError).code).toBe('#DIV/0!');
    expect((val(e, 'A2') as CellError).code).toBe('#REF!');
    expect((val(e, 'A3') as CellError).code).toBe('#NAME?');
    expect((val(e, 'A4') as CellError).code).toBe('#ERROR!');
    expect((val(e, 'A5') as CellError).code).toBe('#DIV/0!');
  });

  it('cross-sheet references', () => {
    const e = new Engine(wb({ A1: "='My Data'!B2*2", A2: '=Other!A1', A3: '=Missing!A1' }, { 'My Data': { B2: '21' }, Other: { A1: 'hi' } }));
    expect(val(e, 'A1')).toBe(42);
    expect(val(e, 'A2')).toBe('hi');
    expect((val(e, 'A3') as CellError).code).toBe('#REF!');
  });

  it('recalculates incrementally', () => {
    const w = wb({ A1: '1', A2: '=A1*2', A3: '=A2+1', B1: '=SUM(A:A)' });
    const e = new Engine(w);
    expect(val(e, 'A3')).toBe(3);
    w.tabs[0].cells.A1 = { v: '10' };
    e.update([{ tabId: 't1', key: 'A1' }]);
    expect(val(e, 'A2')).toBe(20);
    expect(val(e, 'A3')).toBe(21);
    expect(val(e, 'B1')).toBe(51);
    w.tabs[0].cells.A7 = { v: '100' };
    e.update([{ tabId: 't1', key: 'A7' }]);
    expect(val(e, 'B1')).toBe(151);
  });

  it('handles long dependency chains', () => {
    const cells: Record<string, string> = { A1: '1' };
    for (let i = 2; i <= 5000; i++) cells['A' + i] = `=A${i - 1}+1`;
    const w = wb(cells);
    const e = new Engine(w);
    expect(e.getValue('t1', 4999, 0)).toBe(5000);
    w.tabs[0].cells.A1 = { v: '2' };
    e.update([{ tabId: 't1', key: 'A1' }]);
    expect(e.getValue('t1', 4999, 0)).toBe(5001);
  });
});

describe('formula adjustment', () => {
  it('shifts relative refs', () => {
    expect(shiftFormula('=A1+$B$2+C$3+$D4', 2, 1)).toBe('=B3+$B$2+D$3+$D6');
    expect(shiftFormula('=SUM(A1:B2)', 1, 0)).toBe('=SUM(A2:B3)');
    expect(shiftFormula('=A1', -1, 0)).toBe('=#REF!');
    expect(shiftFormula('=SUM(A:A)', 5, 1)).toBe('=SUM(B:B)');
    expect(shiftFormula('="A1"&A1', 1, 0)).toBe('="A1"&A2');
  });

  it('adjusts for inserted/deleted rows', () => {
    expect(adjustForInsert('=A1+A5', 'Sheet1', 'Sheet1', 'row', 2, 3)).toBe('=A1+A8');
    expect(adjustForInsert('=Other!A5', 'Sheet1', 'Sheet1', 'row', 2, 3)).toBe('=Other!A5');
    expect(adjustForDelete('=A1+A5', 'Sheet1', 'Sheet1', 'row', 4, 4)).toBe('=A1+#REF!');
    expect(adjustForDelete('=SUM(A1:A10)', 'Sheet1', 'Sheet1', 'row', 2, 4)).toBe('=SUM(A1:A7)');
    expect(adjustForDelete('=SUM(B1:D1)', 'Sheet1', 'Sheet1', 'col', 1, 1)).toBe('=SUM(B1:C1)');
  });

  it('renames sheet refs', () => {
    expect(renameSheetRefs("=Sheet2!A1+'Sheet2'!B1", 'sheet2', 'My Tab')).toBe("='My Tab'!A1+'My Tab'!B1");
  });
});
