import { describe, expect, it } from 'vitest';
import { alignRows, diffWorkbooks, type WorkbookDiff } from '../../../shared/diff.ts';
import { newTab, type Workbook } from '../../../shared/types.ts';
import { applyStyle, deleteLines, insertLines, renameTab, setInput, addTab } from './ops.ts';
import { WorkbookStore, type Tx } from './store.ts';

function baseWb(): Workbook {
  const t = newTab('t1', 'Data');
  const rows = [
    ['Item', 'Qty', 'Price', 'Total'],
    ['Apples', '3', '1.5', '=B2*C2'],
    ['Pears', '5', '2.25', '=B3*C3'],
    ['Figs', '12', '0.8', '=B4*C4'],
    ['', '', 'Sum', '=SUM(D2:D4)'],
  ];
  rows.forEach((row, r) => row.forEach((v, c) => v && (t.cells[`${'ABCD'[c]}${r + 1}`] = { v })));
  const s = newTab('t2', 'Summary');
  s.cells.A1 = { v: '=Data!D5*2' };
  return { version: 1, tabs: [t, s] };
}

const clone = (wb: Workbook): Workbook => JSON.parse(JSON.stringify(wb));

/** Apply edits to a copy of `wb` using the same operations as the UI. */
function edit(wb: Workbook, fn: (tx: Tx) => void): Workbook {
  const store = new WorkbookStore(clone(wb));
  store.transact(fn);
  return store.workbook;
}

const summary = (d: WorkbookDiff) =>
  d.tabs.flatMap((t) => [
    ...(t.change ? [`${t.tabId} tab ${t.change} ${t.changeSide}`] : []),
    ...t.cells.map((c) => `${t.tabId} ${c.side} ${'ABCDEFG'[c.c]}${c.r + 1}${c.formatOnly ? ' format' : ''}`),
    ...t.rows.map((r) => `${t.tabId} ${r.side} row ${r.kind} at ${r.at + 1}${r.inBranch ? '' : ' (not in branch)'}`),
  ]);

describe('alignRows', () => {
  it('aligns inserted and deleted rows', () => {
    const sim = () => 0;
    expect(alignRows(['a', 'b', 'c'], ['a', 'x', 'b', 'c'], sim)).toEqual([[0, 0], [null, 1], [1, 2], [2, 3]]);
    expect(alignRows(['a', 'b', 'c'], ['a', 'c'], sim)).toEqual([[0, 0], [1, null], [2, 1]]);
    // A modified row pairs with its replacement.
    expect(alignRows(['a', 'b', 'c'], ['a', 'B', 'c'], sim)).toEqual([[0, 0], [1, 1], [2, 2]]);
  });
});

describe('diffWorkbooks', () => {
  it('reports nothing when nothing changed', () => {
    const b = baseWb();
    expect(diffWorkbooks(b, clone(b), clone(b)).tabs).toEqual([]);
  });

  it('classifies mine / theirs / conflict / identical edits', () => {
    const base = baseWb();
    const branch = edit(base, (tx) => {
      setInput(tx, 't1', 1, 1, '4'); // B2 mine
      setInput(tx, 't1', 3, 1, '20'); // B4 both, differently
      setInput(tx, 't1', 2, 0, 'Pear'); // A3 both, identically
    });
    const original = edit(base, (tx) => {
      setInput(tx, 't1', 2, 1, '6'); // B3 theirs
      setInput(tx, 't1', 3, 1, '13'); // B4 both
      setInput(tx, 't1', 2, 0, 'Pear');
    });
    const d = diffWorkbooks(base, branch, original);
    expect(summary(d)).toEqual(['t1 mine B2', 't1 theirs B3', 't1 conflict B4']);
    expect(d.counts).toEqual({ mine: 1, theirs: 1, conflict: 1 });
    const b4 = d.tabs[0].cells.find((c) => c.r === 3)!;
    expect([b4.base?.v, b4.branch?.v, b4.original?.v]).toEqual(['12', '20', '13']);
  });

  it('treats an inserted row as one change, not every formula below it', () => {
    const base = baseWb();
    // Insert a row above "Pears": formulas below (=B3*C3, =SUM(D2:D4), Summary's =Data!D5*2) all get rewritten.
    const branch = edit(base, (tx) => {
      insertLines(tx, 't1', 'row', 2, 1);
      setInput(tx, 't1', 2, 0, 'Kiwi');
    });
    expect(branch.tabs[0].cells.D6.v).toBe('=SUM(D2:D5)');
    expect(branch.tabs[1].cells.A1.v).toBe('=Data!D6*2');
    const d = diffWorkbooks(base, branch, clone(base));
    expect(summary(d)).toEqual(['t1 mine row added at 3']);
  });

  it('places rows the original added or removed relative to the branch', () => {
    const base = baseWb();
    const branch = edit(base, (tx) => insertLines(tx, 't1', 'row', 0, 2)); // branch shifted everything down 2 (empty rows)
    const original = edit(base, (tx) => {
      deleteLines(tx, 't1', 'row', 3, 3); // remove Figs
      insertLines(tx, 't1', 'row', 1, 1);
      setInput(tx, 't1', 1, 0, 'Banana'); // add above Apples
    });
    const d = diffWorkbooks(base, branch, original);
    // Branch row numbers: Apples is now row 4, Figs row 6.
    expect(summary(d)).toEqual(['t1 theirs row added at 4 (not in branch)', 't1 theirs row removed at 6']);
    // Formulas the original rewrote for its own row changes are not reported as edits.
    expect(d.tabs[0].cells).toEqual([]);
  });

  it('does not report ranges shrunk only by a deleted edge row', () => {
    const base = baseWb();
    base.tabs[0].cells.E1 = { v: '=SUM(B2:B3)' }; // ends just above Figs
    const original = edit(base, (tx) => deleteLines(tx, 't1', 'row', 3, 3)); // delete Figs (row 4)
    // =SUM(D2:D4) shrank to D2:D3 (side effect), =SUM(B2:B3) is untouched; neither is an edit.
    expect(summary(diffWorkbooks(base, clone(base), original))).toEqual(['t1 theirs row removed at 4']);
  });

  it('flags deleting a row the other side edited as a conflict', () => {
    const base = baseWb();
    const branch = edit(base, (tx) => deleteLines(tx, 't1', 'row', 2, 2)); // delete Pears
    const original = edit(base, (tx) => setInput(tx, 't1', 2, 1, '50')); // edit Pears
    const d = diffWorkbooks(base, branch, original);
    expect(summary(d)).toContain('t1 conflict row removed at 3 (not in branch)');
  });

  it('handles tab renames, additions and format-only edits', () => {
    const base = baseWb();
    const branch = edit(base, (tx) => {
      renameTab(tx, 't1', 'Sales'); // rewrites Summary!A1 to =Sales!D5*2
      applyStyle(tx, 't1', [{ r1: 0, c1: 0, r2: 0, c2: 0 }], { b: true });
    });
    let addedId = '';
    const original = edit(base, (tx) => {
      addedId = addTab(tx, 1);
    });
    const d = diffWorkbooks(base, branch, original);
    expect(summary(d)).toEqual(['t1 tab renamed mine', 't1 mine A1 format', `${addedId} tab added theirs`]);
  });

  it('works for a detached branch (original gone) by comparing against the base', () => {
    const base = baseWb();
    const branch = edit(base, (tx) => setInput(tx, 't1', 1, 1, '9'));
    expect(summary(diffWorkbooks(base, branch, base))).toEqual(['t1 mine B2']);
  });
});
