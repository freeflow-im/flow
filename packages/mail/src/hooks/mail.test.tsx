import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { MailFolder, MessagePage, TabCount } from '../api';

vi.mock('../api', async (orig) => {
  const real = await orig<typeof import('../api')>();
  return { ...real, mailApi: { ...real.mailApi, setFlags: vi.fn(async () => ({ ok: true })), move: vi.fn(async () => ({ ok: true })), remove: vi.fn(async () => ({ ok: true })) } };
});
const { keys, REFRESH_DELAY_MS, useMessageActions } = await import('./mail');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const summary = (uid: number, seen: boolean, category?: TabCount['id']) => ({
  uid, folder: 'INBOX', messageId: null, from: null, to: [], cc: [], subject: `m${uid}`, snippet: '', date: '2026-11-03T00:00:00.000Z',
  seen, flagged: false, answered: false, hasAttachments: false, size: 1, ...(category ? { category } : {}),
});
const folders: MailFolder[] = [
  { path: 'INBOX', name: 'Inbox', delimiter: '/', specialUse: 'inbox', unread: 5, total: 20 },
  { path: 'Archive', name: 'Archive', delimiter: '/', specialUse: 'archive', unread: 0, total: 3 },
  { path: 'Trash', name: 'Trash', delimiter: '/', specialUse: 'trash', unread: 0, total: 0 },
];
const counts: TabCount[] = [{ id: 'primary', unread: 3, new: 3, latest: null }, { id: 'promotions', unread: 2, new: 2, latest: null }];

let qc: QueryClient, root: Root, actions: ReturnType<typeof useMessageActions>;
function Harness() {
  actions = useMessageActions('acc', 'INBOX');
  return null;
}

beforeEach(() => {
  vi.useFakeTimers();
  qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  qc.setQueryData(keys.folders('acc'), folders);
  qc.setQueryData(['mail', 'categories', 'acc', ''], counts);
  qc.setQueryData(keys.messages('acc', 'INBOX', '', 'promotions'), { pages: [{ messages: [summary(11, false, 'promotions'), summary(10, false, 'promotions'), summary(9, true, 'promotions')], next: null } as MessagePage], pageParams: [0] });
  qc.setQueryData(keys.messages('acc', 'INBOX', '', 'primary'), { pages: [{ messages: [summary(8, false, 'primary')], next: null } as MessagePage], pageParams: [0] });
  const el = document.createElement('div');
  root = createRoot(el);
  act(() => root.render(createElement(QueryClientProvider, { client: qc }, createElement(Harness))));
});
afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});

const unreadOf = (path: string) => qc.getQueryData<MailFolder[]>(keys.folders('acc'))!.find((f) => f.path === path)!.unread;
const tabUnread = (id: string) => qc.getQueryData<TabCount[]>(['mail', 'categories', 'acc', ''])!.find((c) => c.id === id)!.unread;

describe('message actions and the counts', () => {
  it('marking read moves the folder and tab counts at once, and refreshes them once, later, for a burst', async () => {
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    await act(async () => {
      actions.flags.mutate({ uids: [11], seen: true });
      actions.flags.mutate({ uids: [10], seen: true });
      actions.flags.mutate({ uids: [9], seen: true }); // already read: no change
      actions.flags.mutate({ uids: [8], seen: true });
    });
    expect(unreadOf('INBOX')).toBe(2);
    expect(tabUnread('promotions')).toBe(0);
    expect(tabUnread('primary')).toBe(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(REFRESH_DELAY_MS - 100); });
    expect(invalidate).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    const asked = invalidate.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
    expect(asked.sort()).toEqual([JSON.stringify(['mail', 'categories', 'acc']), JSON.stringify(keys.folders('acc'))].sort());
  });

  it('archiving an unread message moves its count to Archive, and deleting one to Trash', async () => {
    await act(async () => { actions.move.mutate({ uids: [11], to: 'Archive' }); });
    expect([unreadOf('INBOX'), unreadOf('Archive'), tabUnread('promotions')]).toEqual([4, 1, 1]);
    await act(async () => { actions.remove.mutate({ uids: [8] }); });
    expect([unreadOf('INBOX'), unreadOf('Trash'), tabUnread('primary')]).toEqual([3, 1, 2]);
    expect(qc.getQueryData<{ pages: MessagePage[] }>(keys.messages('acc', 'INBOX', '', 'promotions'))!.pages[0]!.messages.map((m) => m.uid)).toEqual([10, 9]);
  });

  it('puts the counts back when the server refuses', async () => {
    const { mailApi } = await import('../api');
    vi.mocked(mailApi.setFlags).mockRejectedValueOnce(new Error('no'));
    await act(async () => { actions.flags.mutate({ uids: [11], seen: true }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(unreadOf('INBOX')).toBe(5);
    expect(tabUnread('promotions')).toBe(2);
  });
});
