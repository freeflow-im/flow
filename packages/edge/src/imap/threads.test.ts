import { describe, expect, it } from 'vitest';
import { SUBJECT_WINDOW_MS, assignThread, dedupeKey, idsIn, isReplySubject, normalizeSubject, participants, type Incoming, type Known, type ThreadStore } from './threads';

const DAY = 24 * 60 * 60_000;
const T0 = Date.UTC(2026, 10, 1);

/** A store over a few known messages. */
function fake(o: { known?: Record<string, Known>; referencing?: Record<string, string[]>; subjects?: { norm: string; threadId: string; participants: string[]; date?: number }[] } = {}): ThreadStore & { made: number } {
  const store = {
    made: 0,
    threadsOf: (ids: readonly string[]) => new Map(ids.filter((id) => o.known?.[id]).map((id) => [id, o.known![id]])),
    referencing: (id: string) => o.referencing?.[id] ?? [],
    bySubject: (norm: string, since: number) => (o.subjects ?? []).filter((s) => s.norm === norm && since <= T0).map(({ threadId, participants: p, date }) => ({ threadId, date: date ?? T0 - DAY, participants: p })),
    newId: () => { store.made++; return `l:new${store.made}`; },
  };
  return store;
}
const msg = (o: Partial<Incoming> = {}): Incoming => ({ messageId: 'm9', inReplyTo: null, references: [], subject: 'Plans', date: T0, serverThreadId: null, list: false, draft: false, participants: ['ann@x.test', 'bo@x.test'], ...o });

describe('subjects', () => {
  it('normalizes reply and forward prefixes, tags, case and spacing', () => {
    expect(normalizeSubject('Re: Re: Fwd:  Plans  for  Friday')).toBe('plans for friday');
    expect(normalizeSubject('RE[2]: AW: [team] Plans')).toBe('plans');
    expect(normalizeSubject('[hikers] Trail report')).toBe('trail report');
    expect(normalizeSubject('Reply needed')).toBe('reply needed');
    expect(normalizeSubject('')).toBe('');
    expect(isReplySubject('Re: Plans')).toBe(true);
    expect(isReplySubject('Fwd: Plans')).toBe(true);
    expect(isReplySubject('Plans')).toBe(false);
    expect(isReplySubject('Reply: no')).toBe(false);
  });
  it('reads ids out of References', () => {
    expect(idsIn(' <a@x> <b@x>\r\n <c@x>')).toEqual(['a@x', 'b@x', 'c@x']);
    expect(idsIn(null)).toEqual([]);
  });
});

describe('assignThread', () => {
  it("takes the server's thread id first, whatever the headers say", () => {
    const got = assignThread(msg({ serverThreadId: '17', inReplyTo: 'a' }), fake({ known: { a: { threadId: 'l:a', date: T0 } } }));
    expect(got).toEqual({ threadId: 's:17', by: 'server', merge: [] });
  });

  it('joins the thread of what it answers or references, or of what references it', () => {
    const store = fake({ known: { a: { threadId: 'l:a', date: T0 - DAY } } });
    expect(assignThread(msg({ inReplyTo: 'a' }), store).threadId).toBe('l:a');
    expect(assignThread(msg({ references: ['zz', 'a'] }), store).threadId).toBe('l:a');
    expect(assignThread(msg({ messageId: 'p' }), fake({ referencing: { p: ['l:later'] } }))).toMatchObject({ threadId: 'l:later', by: 'references' });
    // A copy of the same message (another folder) shares its thread.
    expect(assignThread(msg({ messageId: 'a' }), store).threadId).toBe('l:a');
    expect(store.made).toBe(0);
  });

  it('merges the threads a message links, into the oldest', () => {
    const store = fake({ known: { a: { threadId: 'l:a', date: T0 - 2 * DAY }, b: { threadId: 'l:b', date: T0 - DAY } }, referencing: { m9: ['l:c'] } });
    const got = assignThread(msg({ references: ['b', 'a'] }), store);
    expect(got.threadId).toBe('l:a');
    expect(got.merge.sort()).toEqual(['l:b', 'l:c']);
  });

  it('falls back to the subject only for a reply, with someone in common, lately', () => {
    const subjects = [{ norm: 'plans', threadId: 'l:s', participants: ['ann@x.test'] }];
    expect(assignThread(msg({ subject: 'Re: Plans', inReplyTo: 'gone' }), fake({ subjects }))).toMatchObject({ threadId: 'l:s', by: 'subject' });
    expect(assignThread(msg({ subject: 'Re: Plans' }), fake({ subjects })).threadId).toBe('l:s');
    // No one in common: not the same conversation.
    expect(assignThread(msg({ subject: 'Re: Plans', participants: ['cy@y.test'] }), fake({ subjects })).by).toBe('new');
    // Not a reply: two fresh "Plans" never join.
    expect(assignThread(msg({ subject: 'Plans' }), fake({ subjects })).by).toBe('new');
    // A mailing list's reply, or a draft: never by subject.
    expect(assignThread(msg({ subject: 'Re: Plans', list: true }), fake({ subjects })).by).toBe('new');
    expect(assignThread(msg({ subject: 'Re: Plans', draft: true }), fake({ subjects })).by).toBe('new');
    // Among several, the newest not later than the reply: what it answers, not a message that came after it.
    const two = [{ norm: 'plans', threadId: 'l:later', participants: ['ann@x.test'], date: T0 + DAY }, { norm: 'plans', threadId: 'l:before', participants: ['ann@x.test'], date: T0 - DAY }, { norm: 'plans', threadId: 'l:older', participants: ['ann@x.test'], date: T0 - 2 * DAY }];
    expect(assignThread(msg({ subject: 'Re: Plans' }), fake({ subjects: two })).threadId).toBe('l:before');
    expect(assignThread(msg({ subject: 'Re: Plans', date: T0 - 3 * DAY }), fake({ subjects: two })).threadId).toBe('l:later');
    // Too long ago.
    const old = { ...fake({ subjects }), bySubject: (norm: string, since: number) => (since > T0 - SUBJECT_WINDOW_MS - 1 ? [] : subjects.map((x) => ({ ...x, date: T0 - DAY }))) };
    expect(assignThread(msg({ subject: 'Re: Plans' }), old).by).toBe('new');
  });

  it('starts a new thread otherwise, never keyed by the Message-ID', () => {
    const store = fake();
    const got = assignThread(msg({ messageId: '' }), store);
    expect(got).toEqual({ threadId: 'l:new1', by: 'new', merge: [] });
    expect(assignThread(msg(), store).threadId).toBe('l:new2');
  });
});

describe('threads as listed', () => {
  it('counts a message once however many folders hold it', () => {
    expect(dedupeKey({ emailId: 'e1', messageId: 'm', folder: 'INBOX', uid: 1 })).toBe('e1');
    expect(dedupeKey({ emailId: null, messageId: 'm', folder: 'INBOX', uid: 1 })).toBe('m');
    expect(dedupeKey({ emailId: null, messageId: '', folder: 'INBOX', uid: 1 })).toBe('INBOX:1');
  });
  it('lists the people once, oldest first, me as me', () => {
    const rows = [
      { from: { name: 'Bo', address: 'bo@x.test' }, date: '2026-11-02T00:00:00Z' },
      { from: { name: 'Ann', address: 'ann@x.test' }, date: '2026-11-01T00:00:00Z' },
      { from: { name: '', address: 'Me@X.test' }, date: '2026-11-03T00:00:00Z' },
      { from: { name: 'Ann again', address: 'ann@x.test' }, date: '2026-11-04T00:00:00Z' },
      { from: null, date: '2026-11-05T00:00:00Z' },
    ];
    expect(participants(rows, 'me@x.test')).toEqual([{ name: 'Ann', address: 'ann@x.test' }, { name: 'Bo', address: 'bo@x.test' }, { name: 'me', address: 'me@x.test' }]);
  });
});
