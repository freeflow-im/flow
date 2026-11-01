import { describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { MessageDTO, MessagePage } from '@flow/shared';
import {
  applyMessageEvent,
  applyTopLevel,
  markSendFailed,
  pendingId,
  removeMessageFromCache,
  removePendingMessage,
  type LocalMessage,
  type MessagesData,
  type ThreadData,
} from './messageCache';

let seq = 0;
function msg(over: Partial<MessageDTO> = {}): MessageDTO {
  seq += 1;
  return {
    id: over.id ?? `01948-${String(seq).padStart(4, '0')}`,
    channelId: 'chan-1',
    userId: 'user-a',
    threadRootId: null,
    clientMsgId: over.clientMsgId ?? `cmid-${seq}-${Math.random().toString(36).slice(2)}`,
    body: 'hello',
    createdAt: '2026-07-20T00:00:00.000Z',
    editedAt: null,
    deletedAt: null,
    pinnedAt: null,
    pinnedBy: null,
    systemKind: null,
    scheduled: false,
    replyCount: 0,
    lastReplyAt: null,
    replyParticipantUserIds: [],
    reactions: [],
    unfurls: [],
    files: [],
    ...over,
  };
}

const page = (messages: MessageDTO[], hasMore = false): MessagePage => ({ messages, hasMore });
const data = (...pages: MessagePage[]): MessagesData => ({
  pages,
  pageParams: pages.map((_, i) => (i === 0 ? '' : `cursor-${i}`)),
});

const channelCache = (qc: QueryClient): MessageDTO[] =>
  (qc.getQueryData<MessagesData>(['messages', 'chan-1'])?.pages ?? []).flatMap((p) => p.messages);

describe('applyTopLevel', () => {
  it('prepends a new message to the newest page', () => {
    const older = msg();
    const incoming = msg();
    const r = applyTopLevel(data(page([older], true), page([msg()])), incoming, true);
    expect(r.inserted).toBe(true);
    expect(r.data.pages[0]!.messages.map((m) => m.id)).toEqual([incoming.id, older.id]);
    expect(r.data.pages[0]!.hasMore).toBe(true); // page metadata untouched
  });

  it('reconciles a pending row by clientMsgId in place', () => {
    const real = msg({ clientMsgId: 'cm-recon' });
    const optimistic = { ...real, id: pendingId('cm-recon'), pending: true };
    const newer = msg();
    const r = applyTopLevel(data(page([newer, optimistic])), real, true);
    expect(r.inserted).toBe(false);
    expect(r.data.pages[0]!.messages.map((m) => m.id)).toEqual([newer.id, real.id]);
  });

  it('does not materialize unknown rows when insert=false (edit of unloaded message)', () => {
    const existing = msg();
    const r = applyTopLevel(data(page([existing])), msg(), false);
    expect(r.data.pages[0]!.messages).toHaveLength(1);
  });
});

describe('applyTopLevel with ids that carry no clientMsgId', () => {
  const page = (...ids: string[]): MessagesData => ({ pages: [{ messages: ids.map((id) => msg({ id, clientMsgId: '' })), hasMore: false }], pageParams: [''] });

  it('a duplicate delivery of the same id replaces in place — one row', () => {
    const data = page('01948-0003', '01948-0002', '01948-0001');
    const twice = applyTopLevel(applyTopLevel(data, msg({ id: '01948-0004', clientMsgId: '' }), true).data, msg({ id: '01948-0004', clientMsgId: '' }), true).data;
    expect(twice.pages[0]!.messages.map((m) => m.id)).toEqual(['01948-0004', '01948-0003', '01948-0002', '01948-0001']);
  });

  it('ids keep arrival order on top', () => {
    const data = page('01948-0002', '01948-0001');
    const next = applyTopLevel(data, msg({ id: '01948-0000', clientMsgId: '' }), true).data;
    expect(next.pages[0]!.messages[0]!.id).toBe('01948-0000');
  });
});

describe('applyMessageEvent', () => {
  it('optimistic insert then POST response then WS echo yields exactly one row', () => {
    const qc = new QueryClient();
    qc.setQueryData<MessagesData>(['messages', 'chan-1'], data(page([msg()])));
    const real = msg({ clientMsgId: 'cm-once' });
    const optimistic = { ...real, id: pendingId('cm-once'), pending: true };
    applyMessageEvent(qc, optimistic, true);
    applyMessageEvent(qc, real, true); // POST response
    applyMessageEvent(qc, real, true); // WS echo
    const rows = channelCache(qc).filter((m) => m.clientMsgId === 'cm-once');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(real.id);
  });

  it('leaves never-loaded channels untouched', () => {
    const qc = new QueryClient();
    applyMessageEvent(qc, msg({ channelId: 'chan-unloaded' }), true);
    expect(qc.getQueryData(['messages', 'chan-unloaded'])).toBeUndefined();
  });

  it('a thread reply appends to the thread and bumps the root rollup exactly once', () => {
    const qc = new QueryClient();
    const root = msg({ id: 'root-1' });
    qc.setQueryData<MessagesData>(['messages', 'chan-1'], data(page([root])));
    qc.setQueryData<ThreadData>(['thread', 'root-1'], { root, messages: [], hasMore: false });

    const real = msg({ threadRootId: 'root-1', clientMsgId: 'cm-reply', userId: 'user-b' });
    const optimistic = { ...real, id: pendingId('cm-reply'), pending: true };
    applyMessageEvent(qc, optimistic, true);
    applyMessageEvent(qc, real, true); // response
    applyMessageEvent(qc, real, true); // echo

    const thread = qc.getQueryData<ThreadData>(['thread', 'root-1'])!;
    expect(thread.messages.map((m) => m.id)).toEqual([real.id]);
    expect(thread.root.replyCount).toBe(1);
    const chanRoot = channelCache(qc).find((m) => m.id === 'root-1')!;
    expect(chanRoot.replyCount).toBe(1);
    expect(chanRoot.replyParticipantUserIds).toEqual(['user-b']);
    expect(chanRoot.lastReplyAt).toBe(real.createdAt);
  });

  it('message.updated replaces in place without inserting', () => {
    const qc = new QueryClient();
    const original = msg();
    qc.setQueryData<MessagesData>(['messages', 'chan-1'], data(page([original])));
    applyMessageEvent(qc, { ...original, body: 'edited', editedAt: '2026-07-20T01:00:00.000Z' }, false);
    const rows = channelCache(qc);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.body).toBe('edited');
  });
});

describe('markSendFailed', () => {
  it('keeps a failed top-level row in place, flagged failed (not pending)', () => {
    const qc = new QueryClient();
    qc.setQueryData<MessagesData>(['messages', 'chan-1'], data(page([msg()])));
    const optimistic: LocalMessage = { ...msg({ id: pendingId('cm-fail'), clientMsgId: 'cm-fail' }), pending: true };
    applyMessageEvent(qc, optimistic, true);
    markSendFailed(qc, 'chan-1', 'cm-fail');
    const row = channelCache(qc).find((m) => m.id === pendingId('cm-fail')) as LocalMessage | undefined;
    expect(row).toBeDefined();
    expect(row!.failed).toBe(true);
    expect(row!.pending).toBe(false);
  });

  it('a failed reply un-bumps the root (keeping the row) and a retry re-bumps', () => {
    const qc = new QueryClient();
    const root = msg({ id: 'root-2' });
    qc.setQueryData<MessagesData>(['messages', 'chan-1'], data(page([root])));
    qc.setQueryData<ThreadData>(['thread', 'root-2'], { root, messages: [], hasMore: false });

    const optimistic = msg({
      id: pendingId('cm-refail'),
      clientMsgId: 'cm-refail',
      threadRootId: 'root-2',
    });
    applyMessageEvent(qc, optimistic, true);
    markSendFailed(qc, 'chan-1', 'cm-refail', 'root-2');
    expect(qc.getQueryData<ThreadData>(['thread', 'root-2'])!.root.replyCount).toBe(0);
    expect(channelCache(qc).find((m) => m.id === 'root-2')!.replyCount).toBe(0);
    // the failed reply is still in the thread, flagged failed
    const reply = qc
      .getQueryData<ThreadData>(['thread', 'root-2'])!
      .messages.find((m) => m.id === pendingId('cm-refail')) as LocalMessage | undefined;
    expect(reply?.failed).toBe(true);

    // retry with the same clientMsgId re-bumps (dedupe key was freed)
    applyMessageEvent(qc, optimistic, true);
    expect(channelCache(qc).find((m) => m.id === 'root-2')!.replyCount).toBe(1);
  });
});

describe('removePendingMessage', () => {
  it('drops a discarded top-level row', () => {
    const qc = new QueryClient();
    qc.setQueryData<MessagesData>(['messages', 'chan-1'], data(page([msg()])));
    const optimistic = msg({ id: pendingId('cm-fail'), clientMsgId: 'cm-fail' });
    applyMessageEvent(qc, optimistic, true);
    removePendingMessage(qc, 'chan-1', 'cm-fail');
    expect(channelCache(qc).some((m) => m.id === pendingId('cm-fail'))).toBe(false);
  });

  it('drops a discarded reply without touching the (already un-bumped) rollup', () => {
    const qc = new QueryClient();
    const root = msg({ id: 'root-3', replyCount: 0 });
    qc.setQueryData<MessagesData>(['messages', 'chan-1'], data(page([root])));
    qc.setQueryData<ThreadData>(['thread', 'root-3'], { root, messages: [], hasMore: false });
    const optimistic = msg({ id: pendingId('cm-d'), clientMsgId: 'cm-d', threadRootId: 'root-3' });
    applyMessageEvent(qc, optimistic, true);
    markSendFailed(qc, 'chan-1', 'cm-d', 'root-3'); // rollup back to 0
    removePendingMessage(qc, 'chan-1', 'cm-d', 'root-3');
    expect(qc.getQueryData<ThreadData>(['thread', 'root-3'])!.messages).toHaveLength(0);
    expect(channelCache(qc).find((m) => m.id === 'root-3')!.replyCount).toBe(0);
  });
});

describe('removeMessageFromCache', () => {
  it('permanently removes a root and its cached thread', () => {
    const qc = new QueryClient();
    const root = msg({ id: 'root-purge', replyCount: 1 });
    const reply = msg({ id: 'reply-purge', threadRootId: root.id });
    qc.setQueryData<MessagesData>(['messages', 'chan-1'], data(page([root])));
    qc.setQueryData<ThreadData>(['thread', root.id], { root, messages: [reply], hasMore: false });

    removeMessageFromCache(qc, root);

    expect(channelCache(qc)).toHaveLength(0);
    expect(qc.getQueryData(['thread', root.id])).toBeUndefined();
  });

  it('removes one reply and exactly recomputes the cached root rollup', () => {
    const qc = new QueryClient();
    const root = msg({ id: 'root-reply-purge', replyCount: 2 });
    const first = msg({
      id: 'reply-first',
      threadRootId: root.id,
      userId: 'user-b',
      createdAt: '2026-08-25T01:00:00.000Z',
    });
    const last = msg({
      id: 'reply-last',
      threadRootId: root.id,
      userId: 'user-c',
      createdAt: '2026-08-25T02:00:00.000Z',
    });
    qc.setQueryData<MessagesData>(['messages', 'chan-1'], data(page([root])));
    qc.setQueryData<ThreadData>(['thread', root.id], { root, messages: [first, last], hasMore: false });

    removeMessageFromCache(qc, last);
    removeMessageFromCache(qc, last); // API response + websocket echo

    const thread = qc.getQueryData<ThreadData>(['thread', root.id])!;
    expect(thread.messages.map((m) => m.id)).toEqual([first.id]);
    expect(thread.root.replyCount).toBe(1);
    expect(thread.root.lastReplyAt).toBe(first.createdAt);
    expect(thread.root.replyParticipantUserIds).toEqual(['user-b']);
    expect(channelCache(qc).find((m) => m.id === root.id)!.replyCount).toBe(1);
  });

  it('decrements a partially loaded thread without replacing the server reply count', () => {
    const qc = new QueryClient();
    const root = msg({ id: 'root-partial', replyCount: 250, lastReplyAt: '2026-08-25T03:00:00.000Z' });
    const loaded = msg({ id: 'reply-loaded', threadRootId: root.id });
    qc.setQueryData<MessagesData>(['messages', 'chan-1'], data(page([root])));
    qc.setQueryData<ThreadData>(['thread', root.id], { root, messages: [loaded], hasMore: true });

    removeMessageFromCache(qc, loaded);

    const cachedRoot = qc.getQueryData<ThreadData>(['thread', root.id])!.root;
    expect(cachedRoot.replyCount).toBe(249);
    expect(cachedRoot.lastReplyAt).toBe(root.lastReplyAt);
  });

  it('decrements a channel-only reply rollup once for the API response and websocket echo', () => {
    const qc = new QueryClient();
    const root = msg({ id: 'root-channel-only', replyCount: 4 });
    const reply = msg({ id: 'reply-channel-only', threadRootId: root.id });
    qc.setQueryData<MessagesData>(['messages', 'chan-1'], data(page([root])));

    removeMessageFromCache(qc, reply);
    removeMessageFromCache(qc, reply);

    expect(channelCache(qc).find((m) => m.id === root.id)!.replyCount).toBe(3);
  });

  it('uses loaded survivors as the exact count when the deleted reply is already absent', () => {
    const qc = new QueryClient();
    const root = msg({ id: 'root-refetched', replyCount: 1 });
    const survivor = msg({ id: 'reply-survivor', threadRootId: root.id });
    const delayedEvent = msg({ id: 'reply-already-gone', threadRootId: root.id });
    qc.setQueryData<MessagesData>(['messages', 'chan-1'], data(page([root])));
    qc.setQueryData<ThreadData>(['thread', root.id], { root, messages: [survivor], hasMore: false });

    removeMessageFromCache(qc, delayedEvent);

    expect(qc.getQueryData<ThreadData>(['thread', root.id])!.root.replyCount).toBe(1);
    expect(channelCache(qc).find((m) => m.id === root.id)!.replyCount).toBe(1);
  });
});
