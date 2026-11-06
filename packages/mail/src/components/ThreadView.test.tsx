import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { MessageDetail, ThreadDetail, ThreadMessage } from '../api';
import { ThreadView, type ThreadViewHandle, type ThreadViewProps } from './ThreadView';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no ResizeObserver; a body's frame measures itself with one.
(globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };

const me = 'ann@example.com';
const m = (uid: number, extra: Partial<ThreadMessage> = {}): ThreadMessage => ({
  uid, folder: 'INBOX', messageId: `<m${uid}@x>`, from: { name: 'Bob Martin', address: 'bob@acme.test' }, to: [{ name: 'Ann', address: me }], cc: [], replyTo: [], bcc: [], subject: `Re: Plan ${uid}`,
  snippet: `snippet ${uid}`, date: `2026-11-0${uid}T10:00:00.000Z`, seen: true, flagged: false, answered: false, hasAttachments: false, size: 10, inReplyTo: null, references: [],
  html: null, text: `body of ${uid}`, attachments: [], ...extra,
});
const thread: ThreadDetail = { threadId: 't:1', messages: [m(1), m(2, { from: { name: 'Ann', address: me }, folder: 'Sent' }), m(3), m(4), m(5, { seen: false, html: '<p>the <b>last</b> word</p>' })] };

let root: Root, host: HTMLDivElement;
const replied: MessageDetail[] = [];
const needed: number[] = [];
const handle = createRef<ThreadViewHandle>();
const render = (props: Partial<ThreadViewProps> = {}) =>
  act(() =>
    root.render(
      createElement(ThreadView, {
        handle, accountId: 'acc', me, folder: 'INBOX', thread, loading: false, error: null, folders: [], canArchive: true,
        onReply: (x: MessageDetail) => replied.push(x), onReplyAll() {}, onForward() {}, onArchive() {}, onMove() {}, onDelete() {}, onToggleSeen() {}, onToggleFlag() {}, onFlagMessage() {}, onNeedBody: (x: ThreadMessage) => needed.push(x.uid),
        ...props,
      }),
    ),
  );
const articles = () => [...host.querySelectorAll<HTMLElement>('article[data-uid]')];
const article = (uid: number) => host.querySelector<HTMLElement>(`article[data-uid="${uid}"]`)!;

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  replied.length = 0;
  needed.length = 0;
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.clearAllMocks();
});

describe('ThreadView', () => {
  it('shows the subject once, the unread and last messages open, and the rest as lines; a body is only mounted when open', async () => {
    await render();
    expect(host.querySelector('h2')?.textContent).toContain('Plan 5');
    expect(host.querySelector('h2')?.textContent).not.toContain('Re:');
    // Four read messages before the unread last one fold into one line.
    expect(articles().map((a) => a.dataset.uid)).toEqual(['5']);
    expect(host.textContent).toContain('4 older messages');
    expect(article(5).getAttribute('aria-expanded')).toBe('true');
    expect(host.querySelectorAll('iframe')).toHaveLength(1);
    await act(() => host.querySelector<HTMLButtonElement>('button[class*="border-dashed"]')!.click());
    expect(articles().map((a) => a.dataset.uid)).toEqual(['1', '2', '3', '4', '5']);
    expect(article(3).getAttribute('aria-expanded')).toBe('false');
    expect(article(3).textContent).toContain('snippet 3');
    expect(article(3).textContent).not.toContain('body of 3');
    // The sender's own message says "me".
    expect(article(2).textContent).toContain('me');
  });

  it('a click expands a message and shows its body; another collapses it', async () => {
    await render();
    await act(() => host.querySelector<HTMLButtonElement>('button[class*="border-dashed"]')!.click());
    await act(() => article(3).querySelector<HTMLElement>('div[class*="cursor-pointer"]')!.click());
    expect(article(3).getAttribute('aria-expanded')).toBe('true');
    expect(article(3).textContent).toContain('body of 3');
    await act(() => article(3).querySelector<HTMLElement>('div[class*="cursor-pointer"]')!.click());
    expect(article(3).textContent).not.toContain('body of 3');
  });

  it('Details opens the addresses under the header and leaves the message open', async () => {
    await render();
    const summary = article(5).querySelector<HTMLElement>('summary')!;
    expect(summary.textContent).toBe('Details');
    await act(() => summary.click());
    expect(article(5).getAttribute('aria-expanded')).toBe('true');
    expect(article(5).querySelector('details')?.open).toBe(true);
    expect(article(5).textContent).toContain('From:');
    expect(article(5).textContent).toContain('In:INBOX');
    // A click on the addresses themselves does not fold the message either.
    await act(() => article(5).querySelector<HTMLElement>('details > div')!.click());
    expect(article(5).getAttribute('aria-expanded')).toBe('true');
  });

  it('reply answers the last message from the toolbar and the end buttons, and a message\'s own button answers it', async () => {
    await render();
    await act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Reply (r)"]')!.click());
    expect(replied.map((x) => x.uid)).toEqual([5]);
    await act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Reply to Bob Martin"]')!.click());
    expect(replied.map((x) => x.uid)).toEqual([5, 5]);
    await act(() => host.querySelector<HTMLButtonElement>('button[class*="border-dashed"]')!.click());
    await act(() => article(3).querySelector<HTMLElement>('div[class*="cursor-pointer"]')!.click());
    await act(() => article(3).querySelector<HTMLButtonElement>('button[aria-label="Reply to Bob Martin"]')!.click());
    expect(replied.map((x) => x.uid)).toEqual([5, 5, 3]);
  });

  it('n and p step through the messages, opening each', async () => {
    await render();
    await act(() => handle.current!.step(1));
    expect(articles().map((a) => a.dataset.uid)).toEqual(['1', '2', '3', '4', '5']);
    expect(article(1).getAttribute('aria-expanded')).toBe('true');
    await act(() => handle.current!.step(1));
    expect(article(2).getAttribute('aria-expanded')).toBe('true');
    await act(() => handle.current!.step(-1));
    expect(article(1).className).toContain('ring-2');
  });

  it('a message whose body is still to come says so, lists its files once open, is not answered, and asks for its body when opened', async () => {
    const pending = m(2, { html: null, text: null, bodyPending: true, attachments: [{ index: 0, filename: 'flyer.png', mimeType: 'image/png', size: 44, contentId: '<a@b>', inline: true }, { index: 1, filename: 'plan.pdf', mimeType: 'application/pdf', size: 9, contentId: null, inline: false }] });
    await render({ thread: { threadId: 't:2', messages: [m(1), pending, m(3, { bodyPending: true, html: null, text: null })] } });
    expect(article(3).textContent).toContain('Loading…');
    expect([...article(2).querySelectorAll('button[aria-label^="Preview"]')].map((b) => b.getAttribute('aria-label'))).toEqual([]);
    await act(() => article(2).querySelector<HTMLElement>('div[class*="cursor-pointer"]')!.click());
    expect(needed).toEqual([2]);
    // The picture the body shows by cid is listed too (a flyer pasted into the body is a file worth saving).
    expect([...article(2).querySelectorAll('button[aria-label^="Preview"]')].map((b) => b.getAttribute('aria-label'))).toEqual(['Preview flyer.png, 44 B', 'Preview plan.pdf, 9 B']);
    await act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Reply (r)"]')!.click());
    expect(replied.map((x) => x.uid)).toEqual([1]);
  });

  it('an open message lists the pictures its HTML shows by cid, so they can be saved', async () => {
    const flyer = m(1, { html: '<p>See the flyer</p><img src="cid:a@b">', attachments: [{ index: 0, filename: 'flyer.png', mimeType: 'image/png', size: 44, contentId: 'a@b', inline: true }] });
    await render({ thread: { threadId: 't:4', messages: [flyer] } });
    expect([...article(1).querySelectorAll('button[aria-label^="Preview"]')].map((b) => b.getAttribute('aria-label'))).toEqual(['Preview flyer.png, 44 B']);
  });

  it('a body that could not be read offers Retry', async () => {
    await render({ thread: { threadId: 't:3', messages: [m(1, { html: null, text: null, bodyPending: true, bodyFailed: true })] } });
    expect(article(1).textContent).toContain("Couldn't load this message");
    await act(() => [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Retry')!.click());
    expect(needed).toEqual([1]);
  });
});
