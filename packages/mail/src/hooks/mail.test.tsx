import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Category, MailFolder, MessagePage } from '../api';

vi.mock('../api', async (orig) => {
  const real = await orig<typeof import('../api')>();
  return {
    ...real,
    mailApi: { ...real.mailApi, setFlags: vi.fn(async () => ({ ok: true })), move: vi.fn(async () => ({ ok: true })), remove: vi.fn(async () => ({ ok: true })), moveToTab: vi.fn(async () => ({ ok: true, senders: [], previous: [] })), messages: vi.fn() },
  };
});
const { keys, nextPageParam, REFRESH_DELAY_MS, replaceLastPage, SORTING_RETRY_MS, useMessageActions, useMessages } = await import('./mail');
const { mailApi } = await import('../api');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const summary = (uid: number, seen: boolean, category?: Category) => ({
  uid, folder: 'INBOX', messageId: null, from: null, to: [], cc: [], subject: `m${uid}`, snippet: '', date: '2026-11-03T00:00:00.000Z',
  seen, flagged: false, answered: false, hasAttachments: false, size: 1, ...(category ? { category } : {}),
});
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
  root = createRoot(document.createElement('div'));
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
  vi.mocked(mailApi.messages).mockReset();
});

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
