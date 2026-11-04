import { describe, expect, it } from 'vitest';
import type { Address, MessageSummary, ThreadMessage, ThreadSummary } from '../api';
import { dragThreadUids, expandedByDefault, foldRuns, groupByThread, participantsLabel, replyTarget, soloThreadId, soloUid, threadOfMessage } from './threads';

const ann: Address = { name: 'Ann Lee', address: 'ann@example.com' };
const bob: Address = { name: 'Bob Martin', address: 'bob@acme.test' };
const chen: Address = { name: 'Chen Wei', address: 'chen@acme.test' };
const msg = (uid: number, extra: Partial<MessageSummary> = {}): MessageSummary => ({
  uid, folder: 'INBOX', messageId: `<m${uid}@x>`, from: bob, to: [ann], cc: [], subject: `S${uid}`, snippet: `snip ${uid}`, date: `2026-11-0${Math.min(9, uid)}T00:00:00.000Z`,
  seen: true, flagged: false, answered: false, hasAttachments: false, size: 1, ...extra,
});

describe('groupByThread', () => {
  it('turns a search\'s messages into one row per thread, where its newest message was, counting what is listed', () => {
    const rows = groupByThread([msg(9, { threadId: 't:a', seen: false }), msg(8, { threadId: 't:b' }), msg(7), msg(6, { threadId: 't:a', from: chen, flagged: true, folder: 'Sent' })]);
    expect(rows.map((r) => r.threadId)).toEqual(['t:a', 't:b', soloThreadId(7)]);
    const a = rows[0]!;
    expect(a).toMatchObject({ uid: 9, uids: [9, 6], count: 2, unread: 1, flagged: true, date: '2026-11-09T00:00:00.000Z', folders: ['INBOX', 'Sent'] });
    expect(a.participants.map((p) => p.name)).toEqual(['Chen Wei', 'Bob Martin']);
    expect(a.latest.uid).toBe(9);
    expect(rows[2]).toMatchObject({ uid: 7, uids: [7], count: 1, unread: 0 });
  });

  it('a message of its own keeps its tab, and its solo id names it', () => {
    const t = threadOfMessage(msg(3, { category: 'updates', categoryReason: 'Gmail category:updates' }));
    expect(t).toMatchObject({ threadId: 'm:3', category: 'updates', categoryReason: 'Gmail category:updates', participants: [bob] });
    expect(soloUid('m:3')).toBe(3);
    expect(soloUid('t:abc')).toBeNull();
  });
});

describe('participantsLabel', () => {
  it('first names in order, "me" for the account, each once, the ends of a long list', () => {
    expect(participantsLabel([bob, ann, chen], 'ann@example.com')).toBe('Bob, me, Chen');
    expect(participantsLabel([bob, { name: '', address: 'bob@acme.test' }], 'ann@example.com')).toBe('Bob');
    expect(participantsLabel([{ name: '', address: 'x@y.z' }], 'ann@example.com')).toBe('x');
    expect(participantsLabel([], 'ann@example.com')).toBe('(no sender)');
    expect(participantsLabel([bob, chen, ann, { name: 'Dana Ortiz', address: 'd@x' }, { name: 'Eli Novak', address: 'e@x' }], 'ann@example.com')).toBe('Bob, …, Dana, Eli');
  });
});

describe('an open thread', () => {
  const seen = (...flags: boolean[]) => flags.map((s) => ({ seen: s }));

  it('starts with its unread messages and its last one expanded', () => {
    expect([...expandedByDefault(seen(true, false, true, true))]).toEqual([1, 3]);
    expect([...expandedByDefault(seen(true))]).toEqual([0]);
    expect([...expandedByDefault([])]).toEqual([]);
  });

  it('folds three or more collapsed read messages into one line; the last message never folds', () => {
    const messages = seen(true, true, true, true, false, true, true, true);
    const expanded = expandedByDefault(messages);
    expect(foldRuns(messages, expanded)).toEqual([
      { kind: 'fold', indexes: [0, 1, 2, 3] },
      { kind: 'message', index: 4 },
      { kind: 'message', index: 5 },
      { kind: 'message', index: 6 },
      { kind: 'message', index: 7 },
    ]);
    // Two read ones stay as lines; an expanded one breaks a run.
    expect(foldRuns(seen(true, true, false), expandedByDefault(seen(true, true, false))).map((s) => s.kind)).toEqual(['message', 'message', 'message']);
    // An unread message never folds, even collapsed; among read ones, what is expanded breaks the run.
    expect(foldRuns(messages, new Set([1, 7])).map((s) => s.kind)).toEqual(Array(8).fill('message'));
    expect(foldRuns(seen(true, true, true, true, true, true, true, true), new Set([1, 7])).map((s) => (s.kind === 'fold' ? s.indexes : s.index))).toEqual([0, 1, [2, 3, 4, 5, 6], 7]);
  });

  it('answers the last message, the one in the open folder when there is one, never one still loading', () => {
    const m = (uid: number, folder: string, bodyPending?: true): ThreadMessage => ({ ...msg(uid, { folder }), replyTo: [], bcc: [], inReplyTo: null, references: [], html: null, text: 't', attachments: [], ...(bodyPending ? { bodyPending } : {}) });
    expect(replyTarget([m(1, 'INBOX'), m(2, 'Sent'), m(3, 'INBOX')], 'INBOX')?.uid).toBe(3);
    expect(replyTarget([m(1, 'INBOX'), m(2, 'Sent')], 'INBOX')?.uid).toBe(1);
    expect(replyTarget([m(1, 'INBOX'), m(2, 'Sent')], 'Archive')?.uid).toBe(2);
    expect(replyTarget([m(1, 'INBOX'), m(2, 'INBOX', true)], 'INBOX')?.uid).toBe(1);
    expect(replyTarget([m(2, 'INBOX', true)], 'INBOX')?.uid).toBe(2);
    expect(replyTarget([], 'INBOX')).toBeUndefined();
  });
});

describe('dragThreadUids', () => {
  const rows: ThreadSummary[] = [{ ...threadOfMessage(msg(9)), threadId: 't:a', uids: [9, 4] }, threadOfMessage(msg(8)), threadOfMessage(msg(7))];
  it('carries the row\'s messages, or every checked row\'s when it is checked', () => {
    expect(dragThreadUids('t:a', new Set(), rows)).toEqual([9, 4]);
    expect(dragThreadUids('m:8', new Set(['t:a', 'm:7']), rows)).toEqual([8]);
    expect(dragThreadUids('m:7', new Set(['t:a', 'm:7']), rows)).toEqual([9, 4, 7]);
  });
});
