import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { FetchMessageObject } from 'imapflow';
import { ACTIVE_CADENCE_MS, ACTIVE_MS, MailCache, cadenceMs, flagDiff, nextAlarmAt, walkDown, type Flags, type NewRow, type Sql } from './cache';
import { toSummary } from './convert';

/** The object's SqlStorage, on node:sqlite. */
function memory(): Sql {
  const db = new DatabaseSync(':memory:');
  return {
    exec(query, ...bindings) {
      const statement = db.prepare(query);
      // A statement that returns nothing (DDL, DELETE) has no columns; `all()` on it is fine too, but keep the cost down.
      const rows = /^\s*(SELECT|WITH)/i.test(query) || /RETURNING/i.test(query) ? statement.all(...(bindings as never[])) : (statement.run(...(bindings as never[])), []);
      return { toArray: () => rows as never };
    },
  };
}

const A = 'acct', F = 'INBOX', V = '7';
const MIN = 60_000;

/** A fetched message with the fields a cached row reads. */
function fetched(uid: number, o: { flags?: string[]; subject?: string; from?: string; date?: Date; threadId?: string; emailId?: string; modseq?: bigint } = {}): FetchMessageObject {
  return {
    uid, seq: uid, flags: new Set(o.flags ?? []), size: 100 + uid, internalDate: o.date ?? new Date(Date.UTC(2026, 10, 1, 0, uid)),
    envelope: { subject: o.subject ?? `Message ${uid}`, from: [{ name: 'Ann', address: o.from ?? 'ann@example.com' }], to: [{ address: 'bo@example.com' }], messageId: `<m${uid}@example.com>`, date: o.date ?? new Date(Date.UTC(2026, 10, 1, 0, uid)) },
    ...(o.threadId ? { threadId: o.threadId } : {}), ...(o.emailId ? { emailId: o.emailId } : {}), ...(o.modseq !== undefined ? { modseq: o.modseq } : {}),
  } as unknown as FetchMessageObject;
}
const row = (m: FetchMessageObject, headers: string | null = 'From: Ann <ann@example.com>\r\n'): NewRow => ({ m, summary: toSummary(m, F, `snippet ${m.uid}`), headers, plan: null });

function cacheWith(rows: NewRow[], now = 1000): MailCache {
  const cache = new MailCache(memory());
  cache.init();
  cache.touchFolder(A, F, 'inbox', now, true);
  cache.resetFolder(A, F, V);
  cache.insert(A, F, V, rows, now);
  return cache;
}

describe('the alarm', () => {
  it('runs every 30 s while the person is active, less often after, and not at all after a day', () => {
    const t0 = 1_000_000_000;
    expect(cadenceMs(t0, t0 + 10_000)).toBe(ACTIVE_CADENCE_MS);
    expect(cadenceMs(t0, t0 + ACTIVE_MS - 1)).toBe(ACTIVE_CADENCE_MS);
    expect(cadenceMs(t0, t0 + ACTIVE_MS)).toBe(5 * MIN);
    expect(cadenceMs(t0, t0 + 59 * MIN)).toBe(5 * MIN);
    expect(cadenceMs(t0, t0 + 60 * MIN)).toBe(30 * MIN);
    expect(cadenceMs(t0, t0 + 23 * 60 * MIN)).toBe(30 * MIN);
    expect(cadenceMs(t0, t0 + 24 * 60 * MIN)).toBeNull();
    expect(cadenceMs(0, t0)).toBeNull();
  });

  it('is next due one cadence from now, and never with no accounts', () => {
    const t0 = 1_000_000_000;
    expect(nextAlarmAt(t0, t0 + 1000, true)).toBe(t0 + 1000 + ACTIVE_CADENCE_MS);
    expect(nextAlarmAt(t0, t0 + 1000, false)).toBeNull();
    expect(nextAlarmAt(0, t0, true)).toBeNull();
  });
});

describe('flagDiff', () => {
  const f = (seen: boolean, flagged = false): Flags => ({ seen, flagged, answered: false, draft: false });
  it('finds the flags that changed, and from a full fetch the messages gone', () => {
    const cached = new Map([[1, { ...f(false), flagsAt: 0 }], [2, { ...f(true), flagsAt: 0 }], [3, { ...f(false), flagsAt: 0 }]]);
    const got = flagDiff(cached, new Map([[1, f(true)], [2, f(true)]]), true, 500);
    expect(got.changed).toEqual([{ uid: 1, ...f(true) }]);
    expect(got.vanished).toEqual([3]);
  });
  it('from a changedSince fetch, an absent message is just unchanged', () => {
    const cached = new Map([[1, { ...f(false), flagsAt: 0 }], [3, { ...f(false), flagsAt: 0 }]]);
    const got = flagDiff(cached, new Map([[1, f(false, true)]]), false, 500);
    expect(got.changed).toEqual([{ uid: 1, ...f(false, true) }]);
    expect(got.vanished).toEqual([]);
  });
  it('keeps a flag written through after the fetch began', () => {
    const cached = new Map([[1, { ...f(true), flagsAt: 900 }]]);
    expect(flagDiff(cached, new Map([[1, f(false)]]), true, 500).changed).toEqual([]);
    expect(flagDiff(cached, new Map([[1, f(false)]]), true, 950).changed).toHaveLength(1);
  });
});

describe('walkDown', () => {
  it('picks the uncached UIDs, newest first, within the budget, and says how far down everything is cached', () => {
    expect(walkDown([9, 8, 7, 6, 5], new Set([8]), 2)).toEqual({ todo: [9, 7], last: 7, done: false });
    expect(walkDown([9, 8, 7], new Set([8]), 5)).toEqual({ todo: [9, 7], last: 7, done: true });
    expect(walkDown([9, 8, 7], new Set([9, 8, 7]), 1)).toEqual({ todo: [], last: 7, done: true });
    expect(walkDown([], new Set(), 1)).toEqual({ todo: [], last: 0, done: true });
    expect(walkDown([9, 8], new Set(), 0)).toEqual({ todo: [], last: 0, done: false });
  });
});

describe('MailCache', () => {
  it('pages the cached rows newest first, from low up, with the flags as last known', () => {
    const cache = cacheWith([5, 4, 3, 2, 1].map((u) => row(fetched(u, { flags: u === 4 ? ['\\Seen', '\\Flagged'] : [] }))));
    cache.setMarks(A, F, { high: 5, low: 2 });
    const page = cache.page(A, F, V, Number.MAX_SAFE_INTEGER, 2, 3);
    expect(page.map((r) => r.summary.uid)).toEqual([5, 4, 3]);
    expect(page[1].summary).toMatchObject({ seen: true, flagged: true, subject: 'Message 4', snippet: 'snippet 4', folder: F });
    expect(page[0].summary.seen).toBe(false);
    // Below the cursor, and never below `low` (1 is cached but outside the reach).
    expect(cache.page(A, F, V, 3, 2, 10).map((r) => r.summary.uid)).toEqual([2]);
    expect(cache.count(A, F, V)).toBe(5);
    expect(cache.uids(A, F, V)).toEqual([5, 4, 3, 2, 1]);
  });

  it('keeps the server thread and message ids, and the header block', () => {
    const cache = cacheWith([row(fetched(1, { threadId: '17', emailId: 'e1' })), row(fetched(2))]);
    const [two, one] = cache.page(A, F, V, Number.MAX_SAFE_INTEGER, 1, 10);
    expect(one).toMatchObject({ threadId: 's:17', emailId: 'e1' });
    expect(two).toMatchObject({ threadId: null, emailId: null });
    expect(cache.flags(A, F, V, [1, 2]).get(1)).toMatchObject({ seen: false, flagsAt: 1000 });
  });

  it('writes flags through, and tells cached from uncached UIDs', () => {
    const cache = cacheWith([row(fetched(1)), row(fetched(2))]);
    cache.setFlags(A, F, [2], { seen: true }, 2000);
    expect(cache.flags(A, F, V, [1, 2]).get(2)).toEqual({ seen: true, flagged: false, answered: false, draft: false, flagsAt: 2000 });
    expect(cache.flags(A, F, V, [1, 2]).get(1)?.seen).toBe(false);
    expect([...cache.cachedUids(A, F, V, [1, 2, 3])]).toEqual([1, 2]);
    cache.remove(A, F, [1]);
    expect(cache.uids(A, F, V)).toEqual([2]);
  });

  it('inserting a message again keeps what it already had where the new row has nothing', () => {
    const cache = cacheWith([row(fetched(1, { threadId: '17' }), 'X-Header: a\r\n')]);
    cache.insert(A, F, V, [row(fetched(1, { flags: ['\\Seen'] }), null)], 2000);
    expect(cache.page(A, F, V, Number.MAX_SAFE_INTEGER, 1, 1)[0]).toMatchObject({ threadId: 's:17', summary: { seen: true } });
  });

  it('trims to the newest rows and moves low up to the lowest kept', () => {
    const cache = cacheWith([5, 4, 3, 2, 1].map((u) => row(fetched(u))));
    cache.setMarks(A, F, { high: 5, low: 1 });
    expect(cache.trim(A, F, V, 3)).toBe(2);
    expect(cache.uids(A, F, V)).toEqual([5, 4, 3]);
    expect(cache.folder(A, F)?.low).toBe(3);
    expect(cache.trim(A, F, V, 3)).toBe(0);
  });

  it('lowers low only from the value that was read', () => {
    const cache = cacheWith([]);
    cache.setMarks(A, F, { high: 9, low: 5 });
    cache.lowerLow(A, F, V, 7, 2);
    expect(cache.folder(A, F)?.low).toBe(5);
    cache.lowerLow(A, F, V, 5, 2);
    expect(cache.folder(A, F)?.low).toBe(2);
  });

  it('a new UIDVALIDITY drops the rows and the marks', () => {
    const cache = cacheWith([row(fetched(1))]);
    cache.setMarks(A, F, { high: 1, low: 1, modseq: '44' });
    const reset = cache.resetFolder(A, F, '8');
    expect(reset).toMatchObject({ validity: '8', high: 0, low: 0, modseq: null, kind: 'inbox' });
    expect(cache.count(A, F, '8')).toBe(0);
    expect(cache.count(A, F, V)).toBe(0);
  });

  it('folders: the main ones first, a recent one forgotten a week after it was opened, the kind never downgraded', () => {
    const cache = new MailCache(memory());
    cache.init();
    const now = 10 * 24 * 60 * MIN;
    cache.touchFolder(A, 'Projects', 'recent', now - 8 * 24 * 60 * MIN, true);
    cache.touchFolder(A, 'Sent', 'sent', now, false);
    cache.touchFolder(A, F, 'inbox', now, true);
    cache.touchFolder(A, 'Lists', 'recent', now - MIN, true);
    cache.touchFolder(A, F, 'recent', now, true);
    expect(cache.folders(A).map((f) => `${f.folder}:${f.kind}`)).toEqual(['INBOX:inbox', 'Sent:sent', 'Lists:recent', 'Projects:recent']);
    expect(cache.expireFolders(A, now)).toEqual(['Projects']);
    expect(cache.folders(A).map((f) => f.folder)).toEqual([F, 'Sent', 'Lists']);
    expect(cache.folder(A, 'Sent')?.openedAt).toBe(0);
    cache.forgetAccount(A);
    expect(cache.folders(A)).toEqual([]);
  });

  it('remembers when the person was last active', () => {
    const cache = new MailCache(memory());
    cache.init();
    expect(cache.lastActiveAt()).toBe(0);
    cache.setState('last_active_at', '12345');
    expect(cache.lastActiveAt()).toBe(12345);
  });
});
