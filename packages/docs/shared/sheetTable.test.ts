import { describe, expect, it } from 'vitest';
import { newTab, type Workbook } from './types.ts';
import { sheetTable } from './sheetTable.ts';

function workbook(): Workbook {
  const sales = newTab('t1', 'Sales');
  sales.cells = {
    A1: { v: 'Region', st: { b: true, bg: '#eeeeee' } },
    B1: { v: 'Q1' },
    A2: { v: 'North' },
    B2: { v: '10', st: { fmt: 'currency', dp: 0 } },
    A3: { v: 'South', st: { i: true, color: '#aa0000' } },
    B3: { v: '=B2*2', st: { align: 'center' } },
  };
  return { version: 1, tabs: [newTab('t0', 'Notes'), sales] };
}

describe('a spreadsheet range as table cells', () => {
  it('reads shown values with their look, numbers on the right, and the used part when no range is given', () => {
    const t = sheetTable(workbook(), { tab: 'sales' });
    if (typeof t === 'string') throw new Error(t);
    expect(t).toMatchObject({ tabId: 't1', tab: 'Sales', range: 'A1:B3', tabs: ['Notes', 'Sales'] });
    expect(t.rows).toEqual([
      [{ text: 'Region', bold: true, fill: '#eeeeee' }, { text: 'Q1' }],
      [{ text: 'North' }, { text: '$10', align: 'right' }],
      [{ text: 'South', italic: true, color: '#aa0000' }, { text: '20', align: 'center' }],
    ]);
  });

  it('finds the tab by id before its name, takes the tab from the range, and clips whole columns', () => {
    const wb = workbook();
    wb.tabs[1].name = 'Renamed';
    const byId = sheetTable(wb, { tabId: 't1', tab: 'Sales', range: 'B:B' });
    expect(byId).toMatchObject({ tab: 'Renamed', range: 'B1:B3' });
    expect(sheetTable(wb, { range: 'Renamed!A2:A3' })).toMatchObject({ range: 'A2:A3', rows: [[{ text: 'North' }], [{ text: 'South' }]] });
  });

  it('says what is wrong', () => {
    expect(sheetTable(workbook(), { tab: 'Nope' })).toMatch(/no tab named "Nope"/);
    expect(sheetTable(workbook(), {})).toMatch(/"Notes" is empty/);
    expect(sheetTable(workbook(), { tab: 'Sales', range: 'D5:E9' })).toMatch(/is empty/);
    expect(sheetTable(workbook(), { tab: 'Sales', range: 'zz' })).toMatch(/not a valid range/);
  });
});
