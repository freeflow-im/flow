import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Category, MailFolder, MessagePage, ThreadDetail, ThreadPage, ThreadSummary } from '../api';

vi.mock('../api', async (orig) => {
  const real = await orig<typeof import('../api')>();
  return {
    ...real,
    mailApi: { ...real.mailApi, setFlags: vi.fn(async () => ({ ok: true })), move: vi.fn(async () => ({ ok: true })), remove: vi.fn(async () => ({ ok: true })), moveToTab: vi.fn(async () => ({ ok: true, senders: [], previous: [] })), messages: vi.fn(), threads: vi.fn(), thread: vi.fn() },
  };
});
const { fetchBody, keys, nextPageParam, REFRESH_DELAY_MS, replaceLastPage, SORTING_RETRY_MS, useMessageActions, useMessages, useThread, useThreads } = await import('./mail');
const { mailApi } = await import('../api');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const summary = (uid: number, seen: boolean, category?: Category) => ({
  uid, folder: 'INBOX', messageId: null, from: null, to: [], cc: [], subject: `m${uid}`, snippet: '', date: '2026-11-03T00:00:00.000Z',
  seen, flagged: false, answered: false, hasAttachments: false, size: 1, ...(category ? { category } : {}),
});
const thread = (threadId: string, uids: number[], latest: ReturnType<typeof summary>, extra: Partial<ThreadSummary> = {}): ThreadSummary => ({
  threadId, folder: 'INBOX', uid: uids[0]!, uids, latest, count: uids.length, unread: latest.seen ? 0 : 1, flagged: false, participants: [], date: latest.date, folders: ['INBOX'], ...extra,
});
const detail = (uid: number, seen: boolean) => ({ ...summary(uid, seen), replyTo: [], bcc: [], inReplyTo: null, references: [], html: null, text: 't', attachments: [] });
const folders: MailFolder[] = [
  { path: 'INBOX', name: 'Inbox', delimiter: '/', specialUse: 'inbox', unread: 5, total: 20 },
  { path: 'Archive', name: 'Archive', delimiter: '/', specialUse: 'archive', unread: 0, total: 3 },
  { path: 'Trash', name: 'Trash', delimiter: '/', specialUse: 'trash', unread: 0, total: 0 },
];

let qc: QueryClient, root: Root, actions: ReturnType<typeof useMessageActions>;
function Harness() {
  actions = useMessageActions('acc', 'INBOX');
  return null;
}
const mount = (el: ReturnType<typeof createElement>) => act(() => root.render(createElement(QueryClientProvider, { client: qc }, el)));

beforeEach(() => {
  vi.useFakeTimers();
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(keys.folders('acc'), folders);
  qc.setQueryData(keys.messages('acc', 'INBOX', '', 'promotions'), { pages: [{ messages: [summary(11, false, 'promotions'), summary(10, false, 'promotions'), summary(9, true, 'promotions')], next: null } as MessagePage], pageParams: [0] });
  qc.setQueryData(keys.messages('acc', 'INBOX', '', 'primary'), { pages: [{ messages: [summary(8, false, 'primary')], next: null } as MessagePage], pageParams: [0] });
  // The folder's conversations: one of three messages (two unread, one starred), one of one.
  qc.setQueryData(keys.threads('acc', 'INBOX', null), { pages: [{ threads: [thread('t:a', [30, 20, 13], summary(30, false), { unread: 2, flagged: true, count: 3 }), thread('t:b', [7], summary(7, true))], next: null } as ThreadPage], pageParams: [0] });
  qc.setQueryData(keys.thread('acc', 't:a'), { threadId: 't:a', messages: [detail(13, true), detail(20, false), detail(30, false)] } as ThreadDetail);
  root = createRoot(document.createElement('div'));
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  vi.mocked(mailApi.messages).mockReset();
  vi.mocked(mailApi.threads).mockReset();
  vi.mocked(mailApi.thread).mockReset();
});
const threadRows = () => qc.getQueryData<{ pages: ThreadPage[] }>(keys.threads('acc', 'INBOX', null))!.pages.flatMap((p) => p.threads);
const threadMessages = () => qc.getQueryData<ThreadDetail>(keys.thread('acc', 't:a'))!.messages;

const unreadOf = (path: string) => qc.getQueryData<MailFolder[]>(keys.folders('acc'))!.find((f) => f.path === path)!.unread;
const uidsOf = (tab: Category) => qc.getQueryData<{ pages: MessagePage[] }>(keys.messages('acc', 'INBOX', '', tab))!.pages.flatMap((p) => p.messages.map((m) => m.uid));

describe('message actions and the counts', () => {
  beforeEach(() => mount(createElement(Harness)));

  it("marking read moves the folder's count at once, and refreshes it once, later, for a burst", async () => {
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    await act(async () => {
      actions.flags.mutate({ uids: [11], seen: true });
      actions.flags.mutate({ uids: [10], seen: true });
      actions.flags.mutate({ uids: [9], seen: true }); // already read: no change
      actions.flags.mutate({ uids: [8], seen: true });
    });
    expect(unreadOf('INBOX')).toBe(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(REFRESH_DELAY_MS - 100); });
    expect(invalidate).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(invalidate.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey))).toEqual([JSON.stringify(keys.folders('acc'))]);
  });

  it('archiving an unread message moves its count to Archive, and deleting one to Trash', async () => {
    await act(async () => { actions.move.mutate({ uids: [11], to: 'Archive' }); });
    expect([unreadOf('INBOX'), unreadOf('Archive')]).toEqual([4, 1]);
    await act(async () => { actions.remove.mutate({ uids: [8] }); });
    expect([unreadOf('INBOX'), unreadOf('Trash')]).toEqual([3, 1]);
    expect(uidsOf('promotions')).toEqual([10, 9]);
  });

  it('puts the count back when the server refuses', async () => {
    vi.mocked(mailApi.setFlags).mockRejectedValueOnce(new Error('no'));
    await act(async () => { actions.flags.mutate({ uids: [11], seen: true }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(unreadOf('INBOX')).toBe(5);
  });

  it('moving to a tab (a drop, or the menu) takes the messages out of the open tab at once, and into the one they go to', async () => {
    await act(async () => { actions.moveToTab.mutate({ uids: [11, 10], category: 'primary' }); });
    expect(uidsOf('promotions')).toEqual([9]);
    expect(uidsOf('primary')).toEqual([8]); // not listed there yet: it is read again with the quiet refresh
    expect(vi.mocked(mailApi.moveToTab)).toHaveBeenCalledWith('acc', { folder: 'INBOX', uids: [11, 10], category: 'primary' });
  });
});

describe('a tab page that comes back short while the server sorts', () => {
  const page = (uids: number[], next: number | null, sorting = false): MessagePage => ({ messages: uids.map((u) => summary(u, true, 'forums')), next, ...(sorting ? { sorting: true as const } : {}) });

  it('does not go on to older pages while sorting, and does once the page is done', () => {
    expect(nextPageParam(page([], 221, true))).toBeUndefined();
    expect(nextPageParam(page([90, 80], 80))).toBe(80);
    expect(nextPageParam(page([90], null))).toBeUndefined();
  });

  it('replaces only the last page, and only while it is still the one asked for', () => {
    const data = { pages: [page([99, 98], 98), page([90], 50, true)], pageParams: [0, 98] };
    expect(replaceLastPage(data, 98, page([90, 70], 70))!.pages.map((p) => p.messages.map((m) => m.uid))).toEqual([[99, 98], [90, 70]]);
    expect(replaceLastPage(data, 0, page([1], null))).toBe(data);
    expect(replaceLastPage(undefined, 0, page([1], null))).toBeUndefined();
  });

  it('shows the short page at once, and asks for it again until it is full', async () => {
    let tab: ReturnType<typeof useMessages> | undefined;
    function List() {
      tab = useMessages('acc', 'INBOX', '', 'forums');
      return null;
    }
    vi.mocked(mailApi.messages)
      .mockResolvedValueOnce(page([], 221, true))
      .mockResolvedValueOnce(page([300], 221, true))
      .mockResolvedValueOnce(page([300, 290, 280], 280));
    mount(createElement(List));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(tab!.data?.pages).toEqual([page([], 221, true)]);
    expect(tab!.hasNextPage).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(SORTING_RETRY_MS); });
    expect(tab!.data?.pages[0]?.messages.map((m) => m.uid)).toEqual([300]);
    await act(async () => { await vi.advanceTimersByTimeAsync(SORTING_RETRY_MS); });
    expect(tab!.data?.pages).toEqual([page([300, 290, 280], 280)]);
    expect(tab!.hasNextPage).toBe(true);
    // Done sorting: no more asking.
    await act(async () => { await vi.advanceTimersByTimeAsync(SORTING_RETRY_MS * 3); });
    expect(vi.mocked(mailApi.messages)).toHaveBeenCalledTimes(3);
    expect(vi.mocked(mailApi.messages).mock.calls.every((c) => c[1].category === 'forums' && c[1].before === undefined)).toBe(true);
  });
});

describe('thread rows and the open thread follow the actions', () => {
  beforeEach(() => mount(createElement(Harness)));

  it('marking a whole thread read empties its unread count, its newest message and the open thread agree, and the folder count moves by the messages that were unread', async () => {
    await act(async () => { actions.flags.mutate({ uids: [30, 20, 13], seen: true }); });
    expect(threadRows()[0]).toMatchObject({ unread: 0, latest: { seen: true } });
    expect(threadMessages().map((m) => m.seen)).toEqual([true, true, true]);
    expect(unreadOf('INBOX')).toBe(3);
    expect(vi.mocked(mailApi.setFlags)).toHaveBeenCalledWith('acc', { folder: 'INBOX', uids: [30, 20, 13], seen: true });
  });

  it('marking one message of a thread unread raises its count; starring and unstarring the thread set its star', async () => {
    await act(async () => { actions.flags.mutate({ uids: [13], seen: false }); });
    expect(threadRows()[0]).toMatchObject({ unread: 3, latest: { seen: false } });
    expect(threadMessages()[0]?.seen).toBe(false);
    await act(async () => { actions.flags.mutate({ uids: [30, 20, 13], flagged: false }); });
    expect(threadRows()[0]?.flagged).toBe(false);
    await act(async () => { actions.flags.mutate({ uids: [7], flagged: true }); });
    expect(threadRows()[1]).toMatchObject({ flagged: true, latest: { flagged: true } });
  });

  it('archiving part of a thread keeps its row with what is left; archiving the rest drops it, and the open thread loses those messages', async () => {
    await act(async () => { actions.move.mutate({ uids: [30], to: 'Archive' }); });
    expect(threadRows()[0]).toMatchObject({ threadId: 't:a', uid: 20, uids: [20, 13], count: 3, unread: 1 });
    expect(threadMessages().map((m) => m.uid)).toEqual([13, 20]);
    expect([unreadOf('INBOX'), unreadOf('Archive')]).toEqual([4, 1]);
    await act(async () => { actions.remove.mutate({ uids: [20, 13] }); });
    expect(threadRows().map((t) => t.threadId)).toEqual(['t:b']);
    expect(threadMessages()).toEqual([]);
    expect(unreadOf('INBOX')).toBe(3);
  });

  it('puts the rows back when the server refuses', async () => {
    vi.mocked(mailApi.move).mockRejectedValueOnce(new Error('no'));
    await act(async () => { actions.move.mutate({ uids: [30, 20, 13], to: 'Archive' }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(threadRows().map((t) => t.threadId)).toEqual(['t:a', 't:b']);
    expect(threadMessages()).toHaveLength(3);
  });

  it('moving a thread to a tab takes it out of the open tab at once', async () => {
    qc.setQueryData(keys.threads('acc', 'INBOX', 'promotions'), { pages: [{ threads: [thread('t:a', [30], summary(30, false, 'promotions')), thread('t:c', [5], summary(5, true, 'promotions'))], next: null } as ThreadPage], pageParams: [0] });
    await act(async () => { actions.moveToTab.mutate({ uids: [30], category: 'primary' }); });
    expect(qc.getQueryData<{ pages: ThreadPage[] }>(keys.threads('acc', 'INBOX', 'promotions'))!.pages[0]!.threads.map((t) => t.threadId)).toEqual(['t:c']);
    expect(threadRows()[0]?.category).toBe('primary');
  });
});

describe('thread pages and the open thread ask again while the server is not done', () => {
  const page = (uids: number[], next: number | null, sorting = false): ThreadPage => ({ threads: uids.map((u) => thread(`t:${u}`, [u], summary(u, true, 'forums'))), next, ...(sorting ? { sorting: true as const } : {}) });

  it('a short tab page is shown at once and asked for again until it is full', async () => {
    let tab: ReturnType<typeof useThreads> | undefined;
    function List() {
      tab = useThreads('acc', 'INBOX', 'forums');
      return null;
    }
    vi.mocked(mailApi.threads).mockResolvedValueOnce(page([], 221, true)).mockResolvedValueOnce(page([300, 290, 280], 280));
    mount(createElement(List));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(tab!.data?.pages).toEqual([page([], 221, true)]);
    expect(tab!.hasNextPage).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(SORTING_RETRY_MS); });
    expect(tab!.data?.pages[0]?.threads.map((t) => t.uid)).toEqual([300, 290, 280]);
    expect(tab!.hasNextPage).toBe(true);
    expect(vi.mocked(mailApi.threads).mock.calls.every((c) => c[1].category === 'forums' && c[1].before === undefined)).toBe(true);
  });

  it('a thread with a body still to come is asked for again, a few times, then left', async () => {
    let open: ReturnType<typeof useThread> | undefined;
    function Pane() {
      open = useThread('acc', 't:x', 'INBOX');
      return null;
    }
    const pending: ThreadDetail = { threadId: 't:x', messages: [detail(1, true), { ...detail(2, false), text: null, bodyPending: true }] };
    const done: ThreadDetail = { threadId: 't:x', messages: [detail(1, true), detail(2, false)] };
    vi.mocked(mailApi.thread).mockResolvedValueOnce(pending).mockResolvedValueOnce(pending).mockResolvedValue(done);
    mount(createElement(Pane));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(open!.data?.messages[1]?.bodyPending).toBe(true);
    await act(async () => { await vi.advanceTimersByTimeAsync(SORTING_RETRY_MS + 10); });
    await act(async () => { await vi.advanceTimersByTimeAsync(SORTING_RETRY_MS + 10); });
    expect(open!.data).toEqual(done);
    await act(async () => { await vi.advanceTimersByTimeAsync(SORTING_RETRY_MS * 3); });
    expect(vi.mocked(mailApi.thread)).toHaveBeenCalledTimes(3);
    expect(vi.mocked(mailApi.thread)).toHaveBeenCalledWith('acc', 't:x', 'INBOX');
  });

  it('an open thread\'s expanded message with a body still to come is read at once, and shows it; the collapsed ones wait for the thread', async () => {
    let open: ReturnType<typeof useThread> | undefined;
    function Pane() {
      open = useThread('acc', 't:y', 'INBOX');
      return null;
    }
    const pending: ThreadDetail = { threadId: 't:y', messages: [{ ...detail(1, true), text: null, bodyPending: true }, { ...detail(2, false), text: null, bodyPending: true }] };
    vi.mocked(mailApi.thread).mockResolvedValue(pending);
    const message = vi.spyOn(mailApi, 'message').mockResolvedValue({ ...detail(2, false), text: 'the body', html: '<p>the body</p>' });
    mount(createElement(Pane));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    // Only the last (unread) message is read on its own; the first, collapsed, waits for the thread's re-asks.
    expect(message.mock.calls).toEqual([['acc', 'INBOX', 2]]);
    expect(open!.data?.messages[1]).toMatchObject({ uid: 2, text: 'the body', html: '<p>the body</p>' });
    expect(open!.data?.messages[1]?.bodyPending).toBeUndefined();
    expect(open!.data?.messages[0]?.bodyPending).toBe(true);
    // A re-ask of the thread that still says the body is pending does not lose the one read here, nor read it again.
    await act(async () => { await vi.advanceTimersByTimeAsync(SORTING_RETRY_MS + 10); });
    expect(vi.mocked(mailApi.thread)).toHaveBeenCalledTimes(2);
    expect(message).toHaveBeenCalledTimes(1);
    expect(open!.data?.messages[1]?.text).toBe('the body');
    // A read that fails marks the message, and Retry (fetchBody again) clears the mark on success.
    message.mockRejectedValueOnce(new Error('no'));
    // (The hook hears of a cache change on the next tick.)
    await act(async () => { await fetchBody(qc, 'acc', 't:y', { folder: 'INBOX', uid: 1 }); await vi.advanceTimersByTimeAsync(10); });
    expect(open!.data?.messages[0]).toMatchObject({ bodyPending: true, bodyFailed: true });
    await act(async () => { await fetchBody(qc, 'acc', 't:y', { folder: 'INBOX', uid: 1 }); await vi.advanceTimersByTimeAsync(10); });
    expect(open!.data?.messages[0]?.bodyFailed).toBeUndefined();
    expect(open!.data?.messages[0]?.text).toBe('the body');
  });

  it('a message the server does not place in a thread opens as a thread of one', async () => {
    let open: ReturnType<typeof useThread> | undefined;
    function Pane() {
      open = useThread('acc', 'm:9', 'INBOX');
      return null;
    }
    vi.spyOn(mailApi, 'message').mockResolvedValueOnce(detail(9, false));
    mount(createElement(Pane));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(open!.data).toEqual({ threadId: 'm:9', messages: [detail(9, false)] });
    expect(vi.mocked(mailApi.thread)).not.toHaveBeenCalled();
  });
});
