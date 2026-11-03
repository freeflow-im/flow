import { describe, expect, it } from 'vitest';
import { searchCompiler } from 'imapflow/lib/search-compiler.js';
import type { TabCategory } from './categorize';
import { CONFIRM_CHUNK, GMAIL_NONE, RANGE_CHUNK, rangeChunks, recheckRows, setChunks, sortBatch, type CachedTab, type GmailSearcher } from './gmailTabs';

/** The UIDs a UID set names (`1:3,7,9:10`). */
function parseSet(set: string): (uid: number) => boolean {
  const parts = set.split(',').map((p) => {
    const [a, b] = p.split(':').map(Number);
    return [a, b ?? a] as const;
  });
  return (uid) => parts.some(([a, b]) => uid >= Math.min(a, b) && uid <= Math.max(a, b));
}

/**
 * A fake Gmail: `truth` is each message's category (absent: none). `tamper` can drop results, throw or refuse, per query.
 * Every query is kept, to check the commands sent.
 */
function fakeGmail(truth: Map<number, TabCategory>, tamper?: (q: { uid: string; gmraw: string }, got: number[]) => number[] | false | 'throw') {
  const queries: { uid: string; gmraw: string }[] = [];
  const c: GmailSearcher = {
    async search(q) {
      queries.push(q);
      const tab = q.gmraw.replace('category:', '');
      const inSet = parseSet(q.uid);
      const got = [...truth].filter(([uid, t]) => t === tab && inSet(uid)).map(([uid]) => uid);
      const out = tamper ? tamper(q, got) : got;
      if (out === 'throw') throw new Error('connection reset');
      return out;
    },
  };
  return { c, queries };
}

const uids = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
/** How many UIDs a command's set spans, from its lowest to its highest. */
const span = (set: string) => {
  const nums = set.split(/[,:]/).map(Number);
  return Math.max(...nums) - Math.min(...nums) + 1;
};

describe('Gmail re-check', () => {
  it('a range search that leaves rows out does not demote them: the search by UID finds them', async () => {
    // 600 cached Updates messages; the range searches come back with only the first 100 of each range.
    const truth = new Map<number, TabCategory>(uids(1, 600).map((u) => [u, 'updates']));
    const { c, queries } = fakeGmail(truth, (q, got) => (q.uid.includes(':') && !q.uid.includes(',') ? got.slice(0, 100) : got));
    const rows: CachedTab[] = uids(1, 600).map((uid) => ({ uid, category: 'updates' }));
    const result = await recheckRows(c, rows);
    expect(result.error).toBeNull();
    expect(result.demoted).toBe(0);
    expect(result.changes).toEqual([]);
    expect(result.confirmed).toBe(600 - 3 * 100);
    // The confirmation named the UIDs it asked about, CONFIRM_CHUNK at most per command.
    const confirming = queries.slice(3 * 4);
    expect(confirming.length).toBe(Math.ceil(300 / CONFIRM_CHUNK) * 4);
  });

  it('a search that throws changes nothing', async () => {
    const truth = new Map<number, TabCategory>(uids(1, 50).map((u) => [u, 'promotions']));
    const { c } = fakeGmail(truth, (q, got) => (q.gmraw === 'category:social' ? 'throw' : got));
    const rows: CachedTab[] = uids(1, 50).map((uid) => ({ uid, category: uid <= 25 ? 'promotions' : 'primary' }));
    const result = await recheckRows(c, rows);
    expect(result.error).toMatch(/social/);
    expect(result.changes).toEqual([]);
  });

  it('a refused search (imapflow answers false) changes nothing', async () => {
    const truth = new Map<number, TabCategory>(uids(1, 50).map((u) => [u, 'updates']));
    const { c } = fakeGmail(truth, (q, got) => (q.gmraw === 'category:updates' ? false : got));
    const result = await recheckRows(c, uids(1, 50).map((uid) => ({ uid, category: 'updates' })));
    expect(result.error).toMatch(/refused/);
    expect(result.changes).toEqual([]);
  });

  it('a failed confirmation changes nothing either', async () => {
    const truth = new Map<number, TabCategory>([[1, 'updates'], [2, 'social']]);
    const { c } = fakeGmail(truth, (q, got) => (q.uid.includes(',') ? 'throw' : got));
    // Row 3 is cached as Updates and left out: confirming it fails, and the promotion of 2 is not stored either.
    const result = await recheckRows(c, [{ uid: 1, category: 'updates' }, { uid: 2, category: 'primary' }, { uid: 3, category: 'updates' }, { uid: 5, category: 'updates' }]);
    expect(result.error).toMatch(/confirming/);
    expect(result.changes).toEqual([]);
  });

  it('a category with many cached rows coming back empty is not believed', async () => {
    const truth = new Map<number, TabCategory>(uids(1, 100).map((u) => [u, 'updates']));
    const { c } = fakeGmail(truth, (q, got) => (q.gmraw === 'category:updates' ? [] : got));
    const result = await recheckRows(c, uids(1, 100).map((uid) => ({ uid, category: 'updates' })));
    expect(result.error).toMatch(/updates/);
    expect(result.changes).toEqual([]);
  });

  it('a row returned under a new category moves, and a Primary row a category returns is promoted', async () => {
    const truth = new Map<number, TabCategory>([[10, 'promotions'], [11, 'updates'], [12, 'updates']]);
    const { c } = fakeGmail(truth);
    const result = await recheckRows(c, [{ uid: 10, category: 'updates' }, { uid: 11, category: 'primary' }, { uid: 12, category: 'updates' }, { uid: 13, category: 'primary' }]);
    expect(result.error).toBeNull();
    expect(result.changes).toEqual([
      { uid: 10, category: 'promotions', reason: 'Gmail category:promotions' },
      { uid: 11, category: 'updates', reason: 'Gmail category:updates' },
    ]);
    expect(result).toMatchObject({ moved: 1, promoted: 1, demoted: 0 });
  });

  it('a row no search returns, even by its UID, goes to Primary', async () => {
    const truth = new Map<number, TabCategory>([[1, 'updates']]);
    const { c, queries } = fakeGmail(truth);
    const result = await recheckRows(c, [{ uid: 1, category: 'updates' }, { uid: 7, category: 'social' }]);
    expect(result.changes).toEqual([{ uid: 7, category: 'primary', reason: GMAIL_NONE }]);
    expect(result.demoted).toBe(1);
    // The four range searches, then the four by UID for 7 alone.
    expect(queries.slice(4).map((q) => q.uid)).toEqual(['7', '7', '7', '7']);
  });

  it('the repair only promotes', async () => {
    const truth = new Map<number, TabCategory>([[3, 'forums']]);
    const { c, queries } = fakeGmail(truth);
    const result = await recheckRows(c, [{ uid: 3, category: 'primary' }, { uid: 4, category: 'primary' }, { uid: 5, category: 'updates' }], { demote: false });
    expect(result.changes).toEqual([{ uid: 3, category: 'forums', reason: 'Gmail category:forums' }]);
    expect(queries.length).toBe(4);
  });

  it('keeps each command to a bounded set of cached UIDs', async () => {
    // 2000 cached rows spread over a wide UID range, with gaps: each range search covers at most RANGE_CHUNK of them,
    // between real cached UIDs (never `<floor>:*`).
    const cached = uids(1, 2000).map((i) => i * 7);
    const { c, queries } = fakeGmail(new Map());
    await recheckRows(c, cached.map((uid) => ({ uid, category: 'primary' })));
    expect(queries.length).toBe(Math.ceil(2000 / RANGE_CHUNK) * 4);
    for (const q of queries) {
      expect(q.uid).not.toContain('*');
      const [a, b] = q.uid.split(':').map(Number);
      expect(cached.includes(a) && cached.includes(b)).toBe(true);
      expect(cached.filter((u) => u >= a && u <= b).length).toBeLessThanOrEqual(RANGE_CHUNK);
      expect(span(q.uid)).toBeLessThanOrEqual(RANGE_CHUNK * 7);
    }
  });
});

describe('Gmail sorting of new mail', () => {
  it('takes the categories the range searches return', async () => {
    const { c, queries } = fakeGmail(new Map([[5, 'social'], [6, 'updates']]));
    const got = await sortBatch(c, [6, 5, 4]);
    expect([...got.tabs]).toEqual([[5, 'social'], [6, 'updates']]);
    expect(got.confirmed).toBe(false);
    expect(queries.map((q) => q.uid)).toEqual(['4:6', '4:6', '4:6', '4:6']);
  });

  it('throws when a search fails, so nothing of the batch is stored', async () => {
    const { c } = fakeGmail(new Map([[5, 'social']]), (q, got) => (q.gmraw === 'category:forums' ? false : got));
    await expect(sortBatch(c, [5, 4])).rejects.toThrow(/forums/);
  });

  it('a large batch that gets nothing back at all is asked about again by UID', async () => {
    const truth = new Map<number, TabCategory>(uids(1, 200).map((u) => [u, 'promotions']));
    const { c, queries } = fakeGmail(truth, (q, got) => (q.uid.includes(',') || !q.uid.includes(':') ? got : []));
    const got = await sortBatch(c, uids(1, 200).filter((u) => u % 3 !== 0));
    expect(got.confirmed).toBe(true);
    expect(got.tabs.size).toBe(uids(1, 200).filter((u) => u % 3 !== 0).length);
    expect(queries.length).toBe(4 + 2 * 4);
  });

  it('a small batch with nothing back is simply Primary', async () => {
    const { c, queries } = fakeGmail(new Map());
    const got = await sortBatch(c, uids(1, 30));
    expect(got.tabs.size).toBe(0);
    expect(queries.length).toBe(4);
  });
});

describe('UID chunks', () => {
  it('ranges between real UIDs, at most the chunk size of them each', () => {
    expect(rangeChunks([9, 1, 5, 3, 7], 2)).toEqual(['1:3', '5:7', '9']);
    expect(rangeChunks([])).toEqual([]);
  });
  it('sets naming each UID', () => {
    expect(setChunks([1, 2, 3, 7, 9, 10], 4)).toEqual(['1:3,7', '9:10']);
  });
  it('compile, with imapflow, to UID <set> X-GM-RAW "category:..."', async () => {
    const asked: { uid: string; gmraw: string }[] = [];
    await sortBatch({ search: async (q) => (asked.push(q), []) }, [640, 500]);
    const compiled = searchCompiler({ capabilities: new Set(['X-GM-EXT-1']), enabled: new Set() } as never, asked[1]);
    expect(compiled.map((a) => String((a as { value: unknown }).value))).toEqual(['UID', '500:640', 'X-GM-RAW', 'category:social']);
    const targeted = searchCompiler({ capabilities: new Set(['X-GM-EXT-1']), enabled: new Set() } as never, { uid: setChunks([3, 4, 9])[0], gmraw: 'category:updates' });
    expect(targeted.map((a) => String((a as { value: unknown }).value))).toEqual(['UID', '3:4,9', 'X-GM-RAW', 'category:updates']);
  });
});
