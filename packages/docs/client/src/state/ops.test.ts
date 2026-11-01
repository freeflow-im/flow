import { describe, expect, it } from 'vitest';
import { checkCellImage, hasContent, MAX_CELL_IMAGE_CHARS, newTab, type Workbook } from '../../../shared/types.ts';
import { adjustForMove } from '../../../shared/formula/adjust.ts';
import { fitImage } from '../grid/render.ts';
import {
  appendTabs,
  applyStyle,
  clearContents,
  clearFormatting,
  computeHiddenRows,
  deleteLines,
  detectDataRegion,
  fillRange,
  insertLines,
  moveColumns,
  moveRange,
  pasteClip,
  readClip,
  renameTab,
  setImage,
  setInput,
  sortRange,
} from './ops.ts';
import { WorkbookStore } from './store.ts';

function makeStore(cells: Record<string, string>, other?: Record<string, string>) {
  const t = newTab('t1', 'Sheet1');
  for (const [k, v] of Object.entries(cells)) t.cells[k] = { v };
  const wb: Workbook = { version: 1, tabs: [t] };
  if (other) {
    const o = newTab('t2', 'Other');
    for (const [k, v] of Object.entries(other)) o.cells[k] = { v };
    wb.tabs.push(o);
  }
  return new WorkbookStore(wb);
}

const raw = (s: WorkbookStore, key: string, tab = 't1') => s.getTab(tab)!.cells[key]?.v;

describe('store undo/redo', () => {
  it('undoes and redoes cell edits and recalculates', () => {
    const s = makeStore({ A1: '1', A2: '=A1*10' });
    s.transact((tx) => setInput(tx, 't1', 0, 0, '5'));
    expect(s.value('t1', 1, 0)).toBe(50);
    s.undo();
    expect(s.value('t1', 1, 0)).toBe(10);
    s.redo();
    expect(s.value('t1', 1, 0)).toBe(50);
  });

  it('undoes structural changes interleaved with edits', () => {
    const s = makeStore({ A1: '1', A2: '2', A3: '=SUM(A1:A2)' });
    s.transact((tx) => insertLines(tx, 't1', 'row', 1, 2));
    expect(raw(s, 'A5')).toBe('=SUM(A1:A4)');
    expect(raw(s, 'A4')).toBe('2');
    s.transact((tx) => setInput(tx, 't1', 1, 0, '10'));
    expect(s.value('t1', 4, 0)).toBe(13);
    s.undo();
    s.undo();
    expect(raw(s, 'A3')).toBe('=SUM(A1:A2)');
    expect(s.value('t1', 2, 0)).toBe(3);
    s.redo();
    s.redo();
    expect(s.value('t1', 4, 0)).toBe(13);
  });
});

describe('structural ops', () => {
  it('deletes rows and updates references in other tabs', () => {
    const s = makeStore({ A1: 'a', A2: 'b', A3: 'c', A4: '=A3' }, { A1: '=Sheet1!A3', A2: '=Sheet1!A2' });
    s.transact((tx) => deleteLines(tx, 't1', 'row', 1, 1));
    expect(raw(s, 'A2')).toBe('c');
    expect(raw(s, 'A3')).toBe('=A2');
    expect(raw(s, 'A1', 't2')).toBe('=Sheet1!A2');
    expect(raw(s, 'A2', 't2')).toBe('=Sheet1!#REF!'.replace('Sheet1!', ''));
    expect(s.getTab('t1')!.rows).toBe(999);
  });

  it('inserts columns', () => {
    const s = makeStore({ A1: '1', B1: '2', C1: '=A1+B1' });
    s.transact((tx) => insertLines(tx, 't1', 'col', 1, 1));
    expect(raw(s, 'D1')).toBe('=A1+C1');
    expect(s.value('t1', 0, 3)).toBe(3);
  });

  it('moves columns with their cells, widths and filter, rewriting references', () => {
    const s = makeStore({ A1: 'a', B1: 'b', C1: 'c', D1: 'd', E1: '=SUM(B2:C2)', B2: '1', C2: '2', D2: '=$B$2*10' }, { A1: '=Sheet1!B2', B1: '=SUM(Sheet1!A:B)' });
    s.getTab('t1')!.cells.B1.st = { b: true };
    s.getTab('t1')!.colWidths = { 1: 150 };
    s.getTab('t1')!.filter = { r1: 0, c1: 0, r2: 5, c2: 3, cols: { 1: { hidden: ['x'] } } };
    // Move B:C in front of E: order becomes A D B C E.
    let start: number | null = null;
    s.transact((tx) => {
      start = moveColumns(tx, 't1', 1, 2, 4);
    });
    expect(start).toBe(2);
    const t = s.getTab('t1')!;
    expect(['A1', 'B1', 'C1', 'D1'].map((k) => raw(s, k))).toEqual(['a', 'd', 'b', 'c']);
    expect(t.cells.C1.st).toEqual({ b: true });
    expect(t.colWidths).toEqual({ 2: 150 });
    expect(t.filter).toMatchObject({ c1: 0, c2: 3, cols: { 2: { hidden: ['x'] } } });
    expect(raw(s, 'E1')).toBe('=SUM(C2:D2)');
    expect(raw(s, 'B2')).toBe('=$C$2*10');
    expect(s.value('t1', 1, 1)).toBe(10);
    expect(raw(s, 'A1', 't2')).toBe('=Sheet1!C2');
    expect(raw(s, 'B1', 't2')).toBe('=SUM(Sheet1!A:A)'); // B left the range A:B

    // Moving left within a range keeps the range; moving a column into a range widens it.
    s.transact((tx) => moveColumns(tx, 't1', 3, 3, 2)); // order: a d c b
    expect(['A1', 'B1', 'C1', 'D1'].map((k) => raw(s, k))).toEqual(['a', 'd', 'c', 'b']);
    expect(raw(s, 'E1')).toBe('=SUM(C2:D2)');
    expect(raw(s, 'A1', 't2')).toBe('=Sheet1!D2');
    expect(adjustForMove('=SUM(A1:C1)', 'S', 'S', 'col', { from: 5, to: 5, before: 1 })).toBe('=SUM(A1:D1)');

    s.undo();
    s.undo();
    expect(['A1', 'B1', 'C1', 'D1'].map((k) => raw(s, k))).toEqual(['a', 'b', 'c', 'd']);
    expect(raw(s, 'A1', 't2')).toBe('=Sheet1!B2');
    expect(s.transact((tx) => moveColumns(tx, 't1', 1, 2, 3))).toBe(false);
  });

  it('renames tabs and rewrites references', () => {
    const s = makeStore({ A1: '=Other!B1*2' }, { B1: '4' });
    s.transact((tx) => renameTab(tx, 't2', 'Data Set'));
    expect(raw(s, 'A1')).toBe("='Data Set'!B1*2");
    expect(s.value('t1', 0, 0)).toBe(8);
  });
});

describe('fill', () => {
  it('extends numeric series, text counters and formulas', () => {
    const s = makeStore({ A1: '1', A2: '3', B1: 'Item 1', C1: '=A1*2', D1: '1/30/2024' });
    s.transact((tx) => fillRange(tx, 't1', { r1: 0, c1: 0, r2: 1, c2: 0 }, { r1: 0, c1: 0, r2: 4, c2: 0 }));
    expect([raw(s, 'A3'), raw(s, 'A4'), raw(s, 'A5')]).toEqual(['5', '7', '9']);
    s.transact((tx) => fillRange(tx, 't1', { r1: 0, c1: 1, r2: 0, c2: 3 }, { r1: 0, c1: 1, r2: 2, c2: 3 }));
    expect(raw(s, 'B3')).toBe('Item 3');
    expect(raw(s, 'C3')).toBe('=A3*2');
    expect(raw(s, 'D3')).toBe('2/1/2024');
  });

  it('fills upward', () => {
    const s = makeStore({ A3: '10', A4: '20' });
    s.transact((tx) => fillRange(tx, 't1', { r1: 2, c1: 0, r2: 3, c2: 0 }, { r1: 0, c1: 0, r2: 3, c2: 0 }));
    expect([raw(s, 'A1'), raw(s, 'A2')]).toEqual(['-10', '0']);
  });
});

describe('sort, paste, move', () => {
  it('sorts rows keeping formulas with their row', () => {
    const s = makeStore({ A1: 'b', B1: '2', C1: '=B1*10', A2: 'a', B2: '1', C2: '=B2*10', B3: '9' });
    s.transact((tx) => sortRange(tx, s as WorkbookStore<unknown>, 't1', { r1: 0, c1: 0, r2: 2, c2: 2 }, 0, true));
    expect([raw(s, 'A1'), raw(s, 'A2'), raw(s, 'A3')]).toEqual(['a', 'b', undefined]);
    expect(raw(s, 'C1')).toBe('=B1*10');
    expect(s.value('t1', 0, 2)).toBe(10);
    expect(raw(s, 'B3')).toBe('9'); // blank sort key stays last
  });

  it('pastes with relative shifting and tiling', () => {
    const s = makeStore({ A1: '1', B1: '=A1+1' });
    const clip = readClip(s.getTab('t1')!, { r1: 0, c1: 0, r2: 0, c2: 1 });
    s.transact((tx) => pasteClip(tx, 't1', { r1: 2, c1: 0, r2: 3, c2: 1 }, clip));
    expect(raw(s, 'B3')).toBe('=A3+1');
    expect(raw(s, 'B4')).toBe('=A4+1');
  });

  it('moves ranges', () => {
    const s = makeStore({ A1: '1', A2: '=A1' });
    s.transact((tx) => moveRange(tx, 't1', { r1: 0, c1: 0, r2: 1, c2: 0 }, 't1', 0, 2));
    expect(raw(s, 'A1')).toBeUndefined();
    expect(raw(s, 'C1')).toBe('1');
    expect(raw(s, 'C2')).toBe('=A1');
  });

  it('clears contents but keeps formatting', () => {
    const s = makeStore({ A1: '1' });
    s.transact((tx) => applyStyle(tx, 't1', [{ r1: 0, c1: 0, r2: 0, c2: 0 }], { b: true }));
    s.transact((tx) => clearContents(tx, 't1', [{ r1: 0, c1: 0, r2: 0, c2: 0 }]));
    expect(s.getTab('t1')!.cells.A1).toEqual({ v: '', st: { b: true } });
  });
});

describe('filters', () => {
  it('hides rows by value and condition', () => {
    const s = makeStore({ A1: 'Fruit', B1: 'Qty', A2: 'apple', B2: '5', A3: 'pear', B3: '10', A4: 'fig', B4: '15' });
    const tab = s.getTab('t1')!;
    expect(detectDataRegion(tab, 1, 1)).toEqual({ r1: 0, c1: 0, r2: 3, c2: 1 });
    tab.filter = { r1: 0, c1: 0, r2: 3, c2: 1, cols: { 0: { hidden: ['pear'] }, 1: { cond: { type: 'gt', value: '6' } } } };
    expect([...computeHiddenRows(s as WorkbookStore<unknown>, tab)].sort()).toEqual([1, 2]);
  });
});

describe('appendTabs', () => {
  it('adds imported tabs, renaming clashes and fixing references between them', () => {
    const s = makeStore({ A1: 'mine' }, { A1: 'existing other' });
    const imp1 = newTab('x1', 'Sheet1');
    imp1.cells.A1 = { v: '5' };
    const imp2 = newTab('x2', 'Report');
    imp2.cells.A1 = { v: '=Sheet1!A1*2' };
    imp2.cells.A2 = { v: '=Other!A1' }; // "Other" also exists in the imported file below
    const imp3 = newTab('x3', 'other');
    imp3.cells.A1 = { v: 'imported other' };

    let res: ReturnType<typeof appendTabs> | undefined;
    s.transact((tx) => {
      res = appendTabs(tx, [imp1, imp2, imp3]);
    });
    const names = s.workbook.tabs.map((t) => t.name);
    expect(names).toEqual(['Sheet1', 'Other', 'Sheet1 2', 'Report', 'other 2']);
    expect(res!.renamed).toEqual([
      { from: 'Sheet1', to: 'Sheet1 2' },
      { from: 'other', to: 'other 2' },
    ]);
    // New ids, originals untouched.
    expect(res!.ids).not.toContain('x1');
    expect(s.getTab('t1')!.cells.A1.v).toBe('mine');

    const report = s.workbook.tabs[3];
    expect(report.cells.A1.v).toBe("='Sheet1 2'!A1*2");
    expect(report.cells.A2.v).toBe("='other 2'!A1");
    expect(s.value(report.id, 0, 0)).toBe(10);
    expect(s.value(report.id, 1, 0)).toBe('imported other');

    s.undo();
    expect(s.workbook.tabs.map((t) => t.name)).toEqual(['Sheet1', 'Other']);
  });
});

describe('cell images', () => {
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  const B2 = { r1: 1, c1: 1, r2: 1, c2: 1 };

  it('stores an image in a cell, undoably, and clears it with the contents', () => {
    const s = makeStore({ A1: 'x' });
    s.transact((tx) => applyStyle(tx, 't1', [B2], { bg: '#ff0' }));
    s.transact((tx) => setImage(tx, 't1', 1, 1, png));
    expect(s.getTab('t1')!.cells.B2).toEqual({ v: '', img: png, st: { bg: '#ff0' } });
    // Formatting changes keep the image.
    s.transact((tx) => applyStyle(tx, 't1', [B2], { b: true }));
    expect(s.getTab('t1')!.cells.B2.img).toBe(png);
    s.transact((tx) => clearFormatting(tx, 't1', [B2]));
    expect(s.getTab('t1')!.cells.B2).toEqual({ v: '', img: png });
    s.transact((tx) => clearContents(tx, 't1', [{ r1: 0, c1: 0, r2: 5, c2: 5 }]));
    expect(s.getTab('t1')!.cells.B2).toBeUndefined();
    s.undo();
    expect(s.getTab('t1')!.cells.B2).toEqual({ v: '', img: png });
    s.undo();
    s.undo();
    s.undo();
    expect(s.getTab('t1')!.cells.B2).toEqual({ v: '', st: { bg: '#ff0' } });
  });

  it('treats image cells as non-empty and moves them with sort and paste', () => {
    const s = makeStore({ A1: '2', A2: '1' });
    s.transact((tx) => setImage(tx, 't1', 0, 1, png));
    expect(hasContent(s.getTab('t1')!.cells.B1)).toBe(true);
    expect(detectDataRegion(s.getTab('t1')!, 1, 0)).toEqual({ r1: 0, c1: 0, r2: 1, c2: 1 });
    s.transact((tx) => sortRange(tx, s, 't1', { r1: 0, c1: 0, r2: 1, c2: 1 }, 0, true));
    expect(s.getTab('t1')!.cells.B2.img).toBe(png);
    const clip = readClip(s.getTab('t1')!, B2, new Set());
    s.transact((tx) => pasteClip(tx, 't1', { r1: 4, c1: 4, r2: 4, c2: 4 }, clip));
    expect(s.getTab('t1')!.cells.E5).toEqual({ v: '', img: png });
  });

  it('keeps links through sort, copy/paste and saving', () => {
    const url = 'https://en.wikipedia.org/wiki/Eat_a_Peach';
    const s = makeStore({ A1: '2', B1: url, A2: '1', B2: '=HYPERLINK("https://example.com/x", "Ex")' });
    s.transact((tx) => sortRange(tx, s, 't1', { r1: 0, c1: 0, r2: 1, c2: 1 }, 0, true));
    expect(s.link('t1', 0, 1)).toBe('https://example.com/x');
    expect(s.display('t1', 0, 1)).toBe('Ex');
    expect(s.link('t1', 1, 1)).toBe(url);
    const clip = readClip(s.getTab('t1')!, { r1: 0, c1: 1, r2: 1, c2: 1 }, new Set());
    s.transact((tx) => pasteClip(tx, 't1', { r1: 4, c1: 4, r2: 4, c2: 4 }, clip));
    expect(s.link('t1', 4, 4)).toBe('https://example.com/x');
    expect(s.link('t1', 5, 4)).toBe(url);
    const saved = new WorkbookStore(JSON.parse(JSON.stringify(s.workbook)));
    expect(saved.link('t1', 4, 4)).toBe('https://example.com/x');
    expect(saved.display('t1', 4, 4)).toBe('Ex');
  });

  it('validates image sources', () => {
    expect(checkCellImage(png)).toBeNull();
    expect(checkCellImage('https://example.com/a.jpg')).toBeNull();
    expect(checkCellImage('data:text/html;base64,PGI+')).toMatch(/PNG/);
    expect(checkCellImage('/api/images/0b5d3b9e-7f6a-4c1e-9d2a-3f4e5a6b7c8d')).toBeNull();
    expect(checkCellImage('/api/images/../app.db')).toMatch(/PNG/);
    // About 50 MB of image data inline is fine; over 100 MB is refused.
    expect(checkCellImage('data:image/png;base64,' + 'A'.repeat(Math.ceil((50 * 1024 * 1024) / 3) * 4))).toBeNull();
    expect(checkCellImage('data:image/png;base64,' + 'A'.repeat(MAX_CELL_IMAGE_CHARS))).toBe('Image is too large (100 MB maximum)');
  });

  it('fits images inside the cell, keeping the aspect ratio', () => {
    // 200x100 image in a 101x51 cell (minus 1px grid line and 2px padding): limited by height.
    expect(fitImage(200, 100, 0, 0, 101, 51)).toEqual({ x: 4, y: 2, w: 92, h: 46 });
    // Narrow column: limited by width, centered vertically.
    expect(fitImage(100, 100, 10, 20, 25, 105)).toEqual({ x: 12, y: 62, w: 20, h: 20 });
  });
});
