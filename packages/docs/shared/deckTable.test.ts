import { describe, expect, it } from 'vitest';
import { THEMES, validateElement, type TableElement } from './deck.ts';
import { cellLook, cellsFromTexts, deleteCols, deleteRows, insertCols, insertRows, mixColor, newTable, tableColors, textOn } from './deckTable.ts';

const table = (rows: string[][], extra: Partial<TableElement> = {}): TableElement => ({ id: 't', ...newTable(rows.length, rows[0].length), rows: cellsFromTexts(rows), ...extra });

describe('slide tables', () => {
  it('adds and removes rows and columns, keeping the rows their height and the columns their shares', () => {
    const t = table([
      ['a', 'b'],
      ['c', 'd'],
    ]);
    const more = insertRows(t, 1, 2);
    expect(more.rows.map((r) => r.map((c) => c.text))).toEqual([['a', 'b'], ['', ''], ['', ''], ['c', 'd']]);
    expect(more.h).toBe(160);
    expect(deleteRows(more, 1, 2)).toMatchObject({ h: 80, rows: t.rows });
    expect(deleteRows(t, 0, 2)).toBeNull();

    const wide = insertCols({ ...t, cols: [0.75, 0.25] }, 2);
    expect(wide.rows[0].map((c) => c.text)).toEqual(['a', 'b', '']);
    // The new column takes an average share (1 / the columns before).
    expect(wide.cols).toEqual([0.5, 0.1667, 0.3333]);
    expect(wide.w).toBe(t.w);
    // Back to equal columns, the shares are dropped.
    expect(deleteCols(insertCols(t, 0), 0)!.cols).toBeUndefined();
    expect(deleteCols(t, 0, 2)).toBeNull();
  });

  it('draws the header on the accent with readable text, bands the rows below it, and lets cells override', () => {
    const t = table(
      [
        ['h1', 'h2'],
        ['a', 'b'],
        ['c', 'd'],
      ],
      { banded: true },
    );
    t.rows[2][1] = { text: 'd', fill: '#000000' };
    const light = tableColors(t, THEMES.light);
    expect(cellLook(t, 0, 0, light)).toEqual({ fill: '#1a73e8', color: '#ffffff', bold: true, italic: false, align: 'left' });
    expect(cellLook(t, 1, 0, light)).toMatchObject({ fill: undefined, color: THEMES.light.text, bold: false });
    expect(cellLook(t, 2, 0, light).fill).toBe(mixColor(THEMES.light.accent, THEMES.light.bg, 0.1));
    expect(cellLook(t, 2, 1, light)).toMatchObject({ fill: '#000000', color: '#ffffff' });
    // A light accent (the dark theme's) takes dark header text.
    expect(cellLook(t, 0, 0, tableColors(t, THEMES.dark)).color).toBe('#1f1f1f');
    expect(textOn('#ffffff')).toBe('#1f1f1f');
  });

  it('validates tables', () => {
    expect(validateElement(table([['a', 'b']]), 's')).toBeNull();
    expect(validateElement({ ...table([['a', 'b']]), rows: [[{ text: 'a' }, { text: 'b' }], [{ text: 'c' }]] }, 's')).toMatch(/every row/);
    expect(validateElement({ ...table([['a']]), rows: [] }, 's')).toMatch(/1 to 100 rows/);
    expect(validateElement(table([['a', 'b']], { cols: [1] }), 's')).toMatch(/column widths/);
    expect(validateElement(table([['a']], { style: { size: 1 } }), 's')).toMatch(/font size/);
  });
});
