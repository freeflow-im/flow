import { describe, expect, it } from 'vitest';
import { newTab, type Workbook } from '../../../shared/types.ts';
import { findMatches, type SearchOptions } from './search.ts';
import { WorkbookStore } from './store.ts';

function setup() {
  const a = newTab('a', 'Sheet1');
  Object.assign(a.cells, {
    A1: { v: 'Apple pie' },
    B1: { v: 'apple' },
    A2: { v: '=UPPER("apple")' },
    C3: { v: '1500', st: { fmt: 'currency' } },
    A4: { v: 'hidden apple' },
  });
  a.filter = { r1: 2, c1: 0, r2: 3, c2: 0, cols: { 0: { hidden: ['hidden apple'] } } };
  const b = newTab('b', 'Other');
  b.cells.D9 = { v: 'Pineapple' };
  const store = new WorkbookStore({ version: 1, tabs: [a, b] } as Workbook);
  const src = {
    display: (t: string, r: number, c: number) => store.display(t, r, c),
    hiddenRows: (tab: typeof a) => (tab.id === 'a' ? new Set([3]) : new Set<number>()),
  };
  return { store, src, a, b };
}

const opts = (o: Partial<SearchOptions>): SearchOptions => ({ query: '', matchCase: false, wholeCell: false, formulas: false, allTabs: false, ...o });
const keys = (hits: { tabId: string; r: number; c: number }[]) => hits.map((h) => `${h.tabId}:${h.r},${h.c}`);

describe('findMatches', () => {
  it('matches displayed values case-insensitively, skipping filtered rows', () => {
    const { src, a } = setup();
    // A2 displays "APPLE"; A4 is hidden by the filter.
    expect(keys(findMatches(src, [a], opts({ query: 'apple' })))).toEqual(['a:0,0', 'a:0,1', 'a:1,0']);
  });

  it('respects match case and whole cell', () => {
    const { src, a } = setup();
    expect(keys(findMatches(src, [a], opts({ query: 'apple', matchCase: true })))).toEqual(['a:0,1']);
    expect(keys(findMatches(src, [a], opts({ query: 'APPLE', wholeCell: true })))).toEqual(['a:0,1', 'a:1,0']);
  });

  it('searches formatted values and optionally formula text', () => {
    const { src, a } = setup();
    expect(keys(findMatches(src, [a], opts({ query: '$1,500' })))).toEqual(['a:2,2']);
    expect(findMatches(src, [a], opts({ query: 'upper' }))).toEqual([]);
    expect(keys(findMatches(src, [a], opts({ query: 'upper', formulas: true })))).toEqual(['a:1,0']);
  });

  it('searches across tabs in tab order', () => {
    const { src, a, b } = setup();
    expect(keys(findMatches(src, [a, b], opts({ query: 'pine' })))).toEqual(['b:8,3']);
    expect(findMatches(src, [a, b], opts({ query: 'apple' })).map((h) => h.tabId)).toEqual(['a', 'a', 'a', 'b']);
  });

  it('returns nothing for an empty query', () => {
    const { src, a } = setup();
    expect(findMatches(src, [a], opts({ query: '' }))).toEqual([]);
  });
});
