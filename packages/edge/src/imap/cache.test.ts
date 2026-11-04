import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { FetchMessageObject } from 'imapflow';
import { ACTIVE_CADENCE_MS, ACTIVE_MS, BODY, MailCache, cadenceMs, flagDiff, nextAlarmAt, threadPageSql, walkDown, type Flags, type NewRow, type Sql } from './cache';
import { effectiveSql } from './categorize';
import { toSummary } from './convert';

/** The object's SqlStorage, on node:sqlite. */
function memory(): Sql & { db: DatabaseSync } {
  const db = new DatabaseSync(':memory:');
  return {
    db,
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
    expect(one).toMatchObject({ threadId: 's:17', emailId: 'e1', summary: { threadId: 's:17' } });
    expect(two.threadId).toMatch(/^l:/);
    expect(two.emailId).toBeNull();
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

describe('MailCache bodies', () => {
  const plan = { simple: true, texts: [{ section: '1', type: 'text/plain', encoding: '7bit', parameters: {}, disposition: null, id: null, size: 10 }], attachments: [], tree: null } as never;
  const detail = (uid: number) => ({ ...toSummary(fetched(uid), F), replyTo: [], bcc: [], inReplyTo: null, references: [], attachments: [] });
  const withPlan = (uid: number, o: Parameters<typeof fetched>[1] = {}): NewRow => ({ ...row(fetched(uid, o)), plan });

  it('keeps a body and opens the message from it, with the flags as last known', () => {
    const cache = cacheWith([withPlan(1), withPlan(2)]);
    expect(cache.body(A, F, V, 1)).toBeNull();
    cache.setBody(A, F, 1, { detail: detail(1), html: '<p>hi</p>', text: 'hi', plan }, BODY.cached);
    cache.setFlags(A, F, [1], { seen: true }, 2000);
    const got = cache.body(A, F, V, 1)!;
    expect(got.state).toBe(BODY.cached);
    expect(got.detail).toMatchObject({ uid: 1, folder: F, html: '<p>hi</p>', text: 'hi', seen: true, subject: 'Message 1', threadId: cache.threadOf(A, F, 1) });
    expect(got.plan).toEqual(plan);
    expect(cache.plan(A, F, 1)).toEqual(plan);
    expect(cache.bodyBytes(A, F)).toBe(11);
    // Marked too large: nothing kept, and the message opens from the server.
    cache.setBody(A, F, 2, null, BODY.tooLarge);
    expect(cache.body(A, F, V, 2)).toBeNull();
    expect(cache.bodyStates(A, F, V, [1, 2])).toEqual(new Map([[1, BODY.cached], [2, BODY.tooLarge]]));
  });

  it('on a server with message ids, a copy in another folder stands in for the body', () => {
    const cache = cacheWith([withPlan(1, { emailId: 'e1' })]);
    cache.touchFolder(A, 'All', 'all', 1000, false);
    cache.resetFolder(A, 'All', V);
    cache.insert(A, 'All', V, [{ ...row(fetched(9, { emailId: 'e1', flags: ['\\Seen'] })), plan }], 1000);
    cache.setBody(A, 'All', 9, { detail: { ...detail(9), folder: 'All' }, html: null, text: 'same message', plan }, BODY.cached);
    const got = cache.body(A, F, V, 1)!;
    expect(got.detail).toMatchObject({ uid: 1, folder: F, text: 'same message', seen: false });
    // And the queue does not fetch it again: it is marked cached from there.
    expect(cache.bodyQueue(A, F, V, 10)).toEqual([]);
    expect(cache.bodyStates(A, F, V, [1]).get(1)).toBe(BODY.cached);
  });

  it('queues unread first, then newest, only rows with a plan, up to the limit', () => {
    const cache = cacheWith([withPlan(5, { flags: ['\\Seen'] }), withPlan(4), row(fetched(3)), withPlan(2, { flags: ['\\Seen'] }), withPlan(1)]);
    expect(cache.bodyQueue(A, F, V, 10).map((q) => q.uid)).toEqual([4, 1, 5, 2]);
    expect(cache.bodyQueue(A, F, V, 2).map((q) => q.uid)).toEqual([4, 1]);
    const q = cache.bodyQueue(A, F, V, 1)[0];
    expect(q.summary.subject).toBe('Message 4');
    expect(q.headers).toContain('From: Ann');
    cache.setBody(A, F, 4, { detail: detail(4), html: null, text: 'x', plan }, BODY.cached);
    expect(cache.bodyQueue(A, F, V, 10).map((q) => q.uid)).toEqual([1, 5, 2]);
  });

  it('evicts the oldest bodies past the budget, keeping the rows', () => {
    const cache = cacheWith([withPlan(1), withPlan(2), withPlan(3)]);
    for (const u of [1, 2, 3]) cache.setBody(A, F, u, { detail: detail(u), html: null, text: 'x'.repeat(100), plan }, BODY.cached);
    expect(cache.bodyBytes(A, F)).toBe(300);
    expect(cache.evictBodies(A, F, 250)).toBe(1);
    expect(cache.bodyBytes(A, F)).toBe(200);
    expect(cache.body(A, F, V, 1)).toBeNull();
    expect(cache.bodyStates(A, F, V, [1]).get(1)).toBe(BODY.evicted);
    expect(cache.body(A, F, V, 3)).not.toBeNull();
    expect(cache.count(A, F, V)).toBe(3);
    expect(cache.evictBodies(A, F, 250)).toBe(0);
  });

  it('marks the message with a Message-ID answered, and finds rows by UID', () => {
    const cache = cacheWith([withPlan(1), withPlan(2)]);
    cache.setAnswered(A, '<m1@example.com>', 3000);
    const rows = cache.byUids(A, F, V, [1, 2, 7]);
    expect([...rows.keys()]).toEqual([1, 2]);
    expect(rows.get(1)?.summary.answered).toBe(true);
    expect(rows.get(2)?.summary.answered).toBe(false);
    expect(rows.get(1)?.flagsAt).toBe(3000);
  });
});

describe('MailCache threads', () => {
  const withRefs = (uid: number, o: { subject?: string; inReplyTo?: number; references?: number[]; from?: string; to?: string; listId?: boolean; threadId?: string; date?: Date } = {}): NewRow => {
    const m = fetched(uid, { subject: o.subject, from: o.from, threadId: o.threadId, date: o.date });
    if (o.to) (m.envelope as { to: { address: string }[] }).to = [{ address: o.to }];
    const lines = [`From: ${o.from ?? 'ann@example.com'}`];
    if (o.inReplyTo) lines.push(`In-Reply-To: <m${o.inReplyTo}@example.com>`);
    if (o.references?.length) lines.push(`References: ${o.references.map((r) => `<m${r}@example.com>`).join(' ')}`);
    if (o.listId) lines.push('List-Id: <hikers.googlegroups.com>');
    return { m, summary: toSummary(m, F, ''), headers: lines.join('\r\n') + '\r\n', plan: null };
  };
  const threadOf = (cache: MailCache, uid: number, folder = F) => cache.threadOf(A, folder, uid);

  it('threads a reply with what it answers, in either order, and across folders', () => {
    const cache = cacheWith([withRefs(1, { subject: 'Plans' })]);
    cache.insert(A, F, V, [withRefs(2, { subject: 'Re: Plans', inReplyTo: 1, references: [1] })], 1000);
    expect(threadOf(cache, 2)).toBe(threadOf(cache, 1));
    // The reply to the reply arrives first, in Sent; the message it answers joins its thread when cached later.
    cache.touchFolder(A, 'Sent', 'sent', 1000, false);
    cache.resetFolder(A, 'Sent', V);
    cache.insert(A, 'Sent', V, [withRefs(7, { subject: 'Re: Re: Plans', inReplyTo: 3, references: [1, 3] })], 1000);
    expect(threadOf(cache, 7, 'Sent')).toBe(threadOf(cache, 1));
    cache.insert(A, F, V, [withRefs(3, { subject: 'Re: Plans', inReplyTo: 2, references: [1, 2] })], 1000);
    expect(threadOf(cache, 3)).toBe(threadOf(cache, 1));
    expect(cache.threadRows(A, [threadOf(cache, 1)!]).map((r) => `${r.folder}:${r.uid}`)).toEqual(['INBOX:1', 'INBOX:2', 'INBOX:3', 'Sent:7']);
    // Cached again (a page re-fetched), a message keeps its thread.
    const before = threadOf(cache, 2);
    cache.insert(A, F, V, [withRefs(2, { subject: 'Re: Plans' })], 2000);
    expect(threadOf(cache, 2)).toBe(before);
  });

  it('merges two threads a message links, and remembers threads of rows that left', () => {
    const cache = cacheWith([withRefs(1, { subject: 'A' }), withRefs(2, { subject: 'B' })]);
    const [a, b] = [threadOf(cache, 1), threadOf(cache, 2)];
    expect(a).not.toBe(b);
    cache.insert(A, F, V, [withRefs(3, { subject: 'Re: A', references: [2, 1] })], 1000);
    expect(threadOf(cache, 1)).toBe(threadOf(cache, 2));
    expect(threadOf(cache, 3)).toBe(threadOf(cache, 1));
    const t = threadOf(cache, 1)!;
    // Trimmed out of the window, message 1 still leads a late reply to its thread.
    cache.setMarks(A, F, { high: 3, low: 1 });
    cache.trim(A, F, V, 2);
    expect(cache.uids(A, F, V)).toEqual([3, 2]);
    cache.insert(A, F, V, [withRefs(4, { subject: 'Re: A', inReplyTo: 1 })], 1000);
    expect(threadOf(cache, 4)).toBe(t);
    cache.remove(A, F, [2, 3, 4]);
    cache.insert(A, F, V, [withRefs(5, { subject: 'Re: A', inReplyTo: 4 })], 1000);
    expect(threadOf(cache, 5)).toBe(t);
  });

  it('threads a reply by its subject when its references lead nowhere, not a list post', () => {
    const cache = cacheWith([withRefs(1, { subject: 'Lunch', from: 'ann@example.com', to: 'bo@example.com' })]);
    cache.insert(A, F, V, [withRefs(2, { subject: 'Re: Lunch', inReplyTo: 99, from: 'bo@example.com', to: 'ann@example.com' })], 1000);
    expect(threadOf(cache, 2)).toBe(threadOf(cache, 1));
    cache.insert(A, F, V, [withRefs(3, { subject: 'Re: Lunch', from: 'cy@other.test', to: 'dee@other.test' })], 1000);
    expect(threadOf(cache, 3)).not.toBe(threadOf(cache, 1));
    cache.insert(A, F, V, [withRefs(4, { subject: 'Re: Lunch', from: 'bo@example.com', to: 'ann@example.com', listId: true })], 1000);
    expect(threadOf(cache, 4)).not.toBe(threadOf(cache, 1));
    cache.insert(A, F, V, [withRefs(5, { subject: 'Lunch', from: 'bo@example.com', to: 'ann@example.com' })], 1000);
    expect(threadOf(cache, 5)).not.toBe(threadOf(cache, 1));
    // Ann is the account: being on both messages, as everything is, counts for nothing.
    cache.insert(A, F, V, [withRefs(6, { subject: 'Re: Lunch', from: 'cy@other.test', to: 'ann@example.com' })], 1000, 'ann@example.com');
    expect(threadOf(cache, 6)).not.toBe(threadOf(cache, 1));
  });

  it('pages threads by their newest message in the folder, each thread once', () => {
    const cache = cacheWith([withRefs(1, { subject: 'A' }), withRefs(2, { subject: 'B' }), withRefs(3, { subject: 'Re: A', inReplyTo: 1 }), withRefs(4, { subject: 'C' }), withRefs(5, { subject: 'Re: B', inReplyTo: 2 })]);
    cache.setMarks(A, F, { high: 5, low: 1 });
    const page = (cursor: number, limit: number) => cache.threadPage(A, F, V, cursor, 1, limit).map((p) => p.uid);
    expect(page(Number.MAX_SAFE_INTEGER, 10)).toEqual([5, 4, 3]);
    expect(page(Number.MAX_SAFE_INTEGER, 2)).toEqual([5, 4]);
    // Below the cursor: thread A's newest is 3; thread B (newest 5) is not listed again by its older message 2.
    expect(page(4, 10)).toEqual([3]);
    const t = cache.threadOf(A, F, 1)!;
    const rows = cache.threadRows(A, [t]);
    expect(rows.map((r) => r.uid)).toEqual([1, 3]);
    expect(rows[0].key).toBe('m1@example.com');
  });

  it('describes a message whose body is not cached yet for a conversation', () => {
    const cache = cacheWith([withRefs(2, { subject: 'Re: Plans', inReplyTo: 1, references: [1] })]);
    const d = cache.pendingDetail(A, F, 2)!;
    expect(d).toMatchObject({ uid: 2, subject: 'Re: Plans', inReplyTo: 'm1@example.com', references: ['m1@example.com'], attachments: [], replyTo: [], bcc: [] });
    expect(cache.pendingDetail(A, F, 9)).toBeNull();
  });
});

describe("a tab's thread page", () => {
  it('finds each top message\'s category by its key, never scanning the categories (a long-used inbox has tens of thousands)', () => {
    const sql = memory();
    const cache = new MailCache(sql);
    cache.init();
    // The tabs' tables, as object.ts's DDL makes them.
    sql.db.exec(`CREATE TABLE mail_categories (account_id TEXT NOT NULL, folder TEXT NOT NULL, uid_validity TEXT NOT NULL, uid INTEGER NOT NULL, sender TEXT NOT NULL, from_name TEXT NOT NULL, subject TEXT NOT NULL, date INTEGER NOT NULL, category TEXT NOT NULL, reason TEXT NOT NULL, PRIMARY KEY (account_id, folder, uid_validity, uid));
      CREATE TABLE mail_category_overrides (account_id TEXT NOT NULL, sender TEXT NOT NULL, category TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (account_id, sender))`);
    cache.touchFolder(A, F, 'inbox', 1000, true);
    cache.resetFolder(A, F, V);
    cache.insert(A, F, V, [1, 2, 3, 4].map((u) => row(fetched(u, { threadId: String(u % 2) }))), 1000);
    const ins = sql.db.prepare('INSERT INTO mail_categories VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    for (let u = 1; u <= 20_000; u++) ins.run(A, F, V, u, 'ann@example.com', 'Ann', 's', u, u % 2 ? 'primary' : 'promotions', 'r');
    const e = effectiveSql(['promotions']);
    const plan = sql.db.prepare(`EXPLAIN QUERY PLAN ${threadPageSql(e.sql)}`).all(A, F, V, 1, Number.MAX_SAFE_INTEGER, A, F, V, ...e.params, 'promotions', 10).map((r) => String(r.detail));
    expect(plan.some((d) => /SEARCH c USING .*uid=\?/.test(d))).toBe(true);
    expect(plan.some((d) => /^SCAN c\b/.test(d))).toBe(false);
    expect(cache.threadPage(A, F, V, Number.MAX_SAFE_INTEGER, 1, 10, { tab: e.sql, params: e.params, category: 'promotions' })).toEqual([{ threadId: 's:0', uid: 4 }]);
    expect(cache.threadPage(A, F, V, Number.MAX_SAFE_INTEGER, 1, 10, { tab: e.sql, params: e.params, category: 'primary' })).toEqual([{ threadId: 's:1', uid: 3 }]);
    expect(cache.threadPage(A, F, V, Number.MAX_SAFE_INTEGER, 1, 10).map((p) => p.uid)).toEqual([4, 3]);
  });
});
