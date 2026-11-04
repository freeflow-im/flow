import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { MessageSummary } from '../api';
import { MessageList, type MessageListProps } from './MessageList';

// Docs' preview of an Office file is not asked for here.
vi.mock('../api', async (orig) => ({ ...(await orig<typeof import('../api')>()), previewApi: { create: vi.fn(() => new Promise(() => {})), save: vi.fn() } }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const msg = (uid: number, extra: Partial<MessageSummary> = {}): MessageSummary => ({
  uid, folder: 'INBOX', messageId: null, from: { name: 'Bob', address: 'bob@acme.test' }, to: [], cc: [], subject: `Subject ${uid}`, snippet: 'hello',
  date: new Date().toISOString(), seen: false, flagged: false, answered: false, hasAttachments: false, size: 100, ...extra,
});
const file = (index: number, filename: string, mimeType: string) => ({ index, filename, mimeType, size: 2048 });
const FOUR = [file(1, 'report.pdf', 'application/pdf'), file(2, 'notes.docx', 'application/octet-stream'), file(3, 'photo.jpg', 'image/jpeg'), file(5, 'data.xlsx', 'application/octet-stream')];

let root: Root, host: HTMLDivElement;
const opened: number[] = [];
const render = (props: Partial<MessageListProps> = {}) =>
  act(() =>
    root.render(
      createElement(MessageList, {
        accountId: 'acc', title: 'Inbox', loading: false, error: null, refreshing: false, onRefresh() {}, hasMore: false, loadingMore: false, onLoadMore() {}, tab: 'all', onTab() {},
        query: '', onClearQuery() {}, openUid: null, cursorUid: null, onOpen: (uid: number) => opened.push(uid), checked: new Set<number>(), onCheck() {}, onCheckAll() {},
        onFlag() {}, onBulk() {}, onBulkMove() {}, folders: [], currentFolder: 'INBOX',
        messages: [msg(10, { hasAttachments: true, attachments: FOUR }), msg(9, { hasAttachments: true }), msg(8)],
        ...props,
      }),
    ),
  );
const row = (uid: number) => host.querySelector(`[data-uid="${uid}"]`)!;
const chipsOf = (uid: number) => [...row(uid).querySelectorAll('[role="group"] button')].map((b) => b.textContent);

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  opened.length = 0;
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.clearAllMocks();
});

describe.each([false, true])('attachment chips in the list (dense: %s)', (dense) => {
  it('show up to three files and the rest as +N; a row whose files are not known keeps the paperclip', async () => {
    await render({ dense });
    // Every width's chips are rendered; CSS (container queries) shows the ones that fit.
    expect(chipsOf(10)).toEqual(['PDFreport.pdf', 'Wnotes.docx', 'photo.jpg', '+3', '+2', '+1']);
    expect(row(9).querySelector('[role="group"]')).toBeNull();
    expect(row(9).querySelector('[aria-label="Has attachments"]')).not.toBeNull();
    expect(row(8).querySelector('[aria-label="Has attachments"]')).toBeNull();
  });

  it('a chip opens the preview of that file without opening the message', async () => {
    await render({ dense });
    const chip = row(10).querySelector<HTMLButtonElement>('button[aria-label^="Preview photo.jpg"]')!;
    await act(() => chip.click());
    expect(opened).toEqual([]);
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain('photo.jpg');
    expect(dialog.textContent).toContain('3 of 4');
    // The download is the message's attachment by the index the server gave (not the chip's position).
    expect(dialog.querySelector('a[aria-label="Download"]')?.getAttribute('href')).toBe('/v1/mail/accounts/acc/messages/10/attachments/3?folder=INBOX');
    await act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    // "+N" opens the first file not shown; the row itself still opens the message.
    await act(() => row(10).querySelector<HTMLButtonElement>('button[aria-label="1 more attachment"]')!.click());
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('data.xlsx');
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('4 of 4');
    expect(opened).toEqual([]);
    await act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    await act(() => (row(10) as HTMLElement).click());
    expect(opened).toEqual([10]);
  });
});
