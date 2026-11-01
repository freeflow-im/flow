import { describe, expect, it } from 'vitest';
import { newDeck } from '../../../shared/deck.ts';
import type { LinkedTable } from '../../../shared/sheetTable.ts';
import type { LinkedChart } from '../../../shared/chart.ts';
import { DeckController } from './controller.ts';
import { LinkedTableSync, type LinkedTableIo } from './linkedTables.ts';

const range = (rev: string, rows: string[][]): LinkedTable => ({ title: 'Figures', rev, tabId: 't1', tab: 'Data', range: `A1:B${rows.length}`, tabs: ['Data'], rows: rows.map((r) => r.map((text) => ({ text }))) });

/** A fake server: one spreadsheet whose range and revision the test changes, and its revision feed. */
function fakeIo() {
  let current = range('r1', [['Item', 'Cost'], ['Pens', '5']]);
  const feeds = new Map<string, (rev: string) => void>();
  const fetched: string[] = [];
  const refs: unknown[] = [];
  let failing: string | null = null;
  const io: LinkedTableIo = {
    fetchChart: async () => Promise.reject(new Error('No charts in this test.')),
    fetch: async (id, ref) => {
      fetched.push(id);
      refs.push(ref);
      if (failing) throw new Error(failing);
      return current;
    },
    follow: (id, onRev) => {
      feeds.set(id, onRev);
      return () => feeds.delete(id);
    },
  };
  return {
    io,
    feeds,
    fetched,
    refs,
    fail: (msg: string | null) => (failing = msg),
    change(next: LinkedTable) {
      current = next;
      feeds.get('s1')?.(next.rev);
    },
  };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('tables linked to a spreadsheet range', () => {
  it('follows the spreadsheet: refreshes when it changes, keeps the rows their height, and stops when unlinked', async () => {
    const ctl = new DeckController(newDeck(), async () => {});
    const server = fakeIo();
    const id = ctl.addSheetTable('s1', range('r1', [['Item', 'Cost'], ['Pens', '5']]), true);
    const sync = new LinkedTableSync(ctl, server.io);
    expect([...server.feeds.keys()]).toEqual(['s1']);
    const table = () => ctl.slide.elements.find((e) => e.id === id)!;
    expect(table()).toMatchObject({ h: 80, source: { sheet: 's1', title: 'Figures', tabId: 't1', tab: 'Data', range: 'A1:B2', rev: 'r1' } });

    // The feed's first announcement is the revision the table was read from: nothing to do.
    server.feeds.get('s1')!('r1');
    await settle();
    expect(server.fetched).toEqual([]);

    server.change(range('r2', [['Item', 'Cost'], ['Pens', '6'], ['Ink', '2']]));
    await settle();
    expect(table()).toMatchObject({ h: 120, rows: [[{ text: 'Item' }, { text: 'Cost' }], [{ text: 'Pens' }, { text: '6' }], [{ text: 'Ink' }, { text: '2' }]], source: { rev: 'r2', range: 'A1:B3' } });
    // A refresh is a step of its own.
    ctl.undo();
    expect(table()).toMatchObject({ h: 80, source: { rev: 'r1' } });
    ctl.redo();

    // A range that cannot be read leaves the values and says why, until a retry works.
    server.fail('Sheet not found');
    server.change(range('r3', [['x']]));
    await settle();
    expect(sync.problems.get(id)).toBe('Sheet not found');
    expect(table()).toMatchObject({ source: { rev: 'r2' } });
    server.fail(null);
    await sync.retry(id);
    expect(sync.problems.has(id)).toBe(false);
    expect(table()).toMatchObject({ rows: [[{ text: 'x' }]], source: { rev: 'r3' } });

    // The cells are the spreadsheet's: not edited, styled, or given rows here.
    ctl.selectCell(id, 0, 0, true);
    expect(ctl.editing).toBeNull();
    ctl.setCellText(id, 0, 0, 'mine');
    ctl.insertTableRow('below');
    ctl.styleCells({ bold: true });
    expect(table()).toMatchObject({ rows: [[{ text: 'x' }]] });

    ctl.unlinkTable();
    expect(table()).not.toHaveProperty('source');
    expect(server.feeds.size).toBe(0);
    sync.dispose();
  });

  it('reads a fixed range, or the used part of the tab for a table that follows it', async () => {
    const ctl = new DeckController(newDeck(), async () => {});
    const server = fakeIo();
    const fixed = ctl.addSheetTable('s1', range('r1', [['a']]), true);
    const follows = ctl.addSheetTable('s1', range('r1', [['a']]), true, true);
    expect(ctl.slide.elements.find((e) => e.id === follows)).toMatchObject({ source: { used: true } });
    const sync = new LinkedTableSync(ctl, server.io);
    server.change(range('r2', [['a'], ['b']]));
    await settle();
    expect(server.refs).toEqual([
      { tabId: 't1', tab: 'Data', range: 'A1:B1' },
      { tabId: 't1', tab: 'Data' },
    ]);
    expect(ctl.slide.elements.find((e) => e.id === fixed)).not.toMatchObject({ source: { used: true } });
    sync.dispose();
  });

  it('does not ask again for a revision it could not put in (an Office file not yet open for editing)', async () => {
    const ctl = new DeckController(newDeck(), async () => {});
    const server = fakeIo();
    ctl.addSheetTable('s1', range('r1', [['a']]), true);
    const sync = new LinkedTableSync(ctl, server.io);
    ctl.store.guard = () => 'locked';
    server.change(range('r2', [['b']]));
    await settle();
    expect(server.fetched).toHaveLength(1);
    // Other changes to the presentation (a selection, say) do not read it again.
    ctl.select([]);
    ctl.goTo(0);
    await settle();
    expect(server.fetched).toHaveLength(1);
    sync.dispose();
  });

  it('follows a spreadsheet chart too: its look and data', async () => {
    const ctl = new DeckController(newDeck(), async () => {});
    const feeds = new Map<string, (rev: string) => void>();
    let current: LinkedChart = { title: 'Figures', rev: 'r1', tabId: 't1', tab: 'Data', w: 600, h: 371, chart: { id: 'c1', type: 'column', series: [{ values: 'B2:B3' }] }, data: { categories: ['a'], series: [{ name: 'S', color: '#4285f4', points: [{ y: 1 }] }] } };
    const io: LinkedTableIo = {
      fetch: async () => Promise.reject(new Error('no tables')),
      fetchChart: async () => current,
      follow: (id, onRev) => (feeds.set(id, onRev), () => feeds.delete(id)),
    };
    const id = ctl.addSheetChart('s1', 'c1', current, true);
    const sync = new LinkedTableSync(ctl, io);
    current = { ...current, rev: 'r2', chart: { ...current.chart, type: 'line', title: 'Now a line' }, data: { categories: ['a', 'b'], series: [{ name: 'S', color: '#4285f4', points: [{ y: 1 }, { y: 5 }] }] } };
    feeds.get('s1')!('r2');
    await settle();
    expect(ctl.slide.elements.find((e) => e.id === id)).toMatchObject({ chart: { type: 'line', title: 'Now a line' }, data: { categories: ['a', 'b'] }, source: { rev: 'r2', chart: 'c1' } });
    sync.dispose();
  });
});
