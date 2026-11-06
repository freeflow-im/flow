import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { MailAccount, MessageDetail, ThreadDetail, ThreadMessage } from '../api';
import type { ComposeRequest, Outgoing } from '../lib/compose';
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

  describe('answering in the conversation (wide screens)', () => {
    const account = { id: 'acc', email: me, displayName: 'Ann' } as MailAccount;
    const sent: Outgoing[] = [];
    const detached: ComposeRequest[] = [];
    const inline = { account, onSend: (o: Outgoing) => sent.push(o), onDetach: (r: ComposeRequest) => detached.push(r) };
    const settle = () => act(async () => { await import('./InlineCompose'); for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); });
    const card = () => host.querySelector<HTMLElement>('[data-inline-compose]');
    const editorOf = () => (host.querySelector('.ProseMirror') as unknown as { editor: { commands: { insertContentAt(at: number, text: string): boolean } } }).editor;
    const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === label || b.getAttribute('aria-label') === label);
    beforeEach(() => { sent.length = 0; detached.length = 0; });

    it('r opens a reply under the last message, the recipient as one line, and the end buttons give way', async () => {
      await render({ inline });
      let opened = false;
      await act(() => { opened = handle.current!.compose('reply'); });
      await settle();
      expect(opened).toBe(true);
      expect(replied).toEqual([]);
      const c = card()!;
      expect(c).not.toBeNull();
      // Right after the last message's article.
      expect(article(5).nextElementSibling).toBe(c);
      expect(c.textContent).toContain('Bob Martin (bob@acme.test)');
      expect(c.querySelector('[aria-label="Message"]')?.innerHTML).toContain('wrote:');
      expect(button('Forward')).toBeUndefined();
      // Clicking the line opens the fields to edit.
      await act(() => button('Edit recipients')!.click());
      expect(c.querySelector('input[aria-label="To"]') ?? c.querySelector('input')).not.toBeNull();
    });

    it('the mode menu switches to Forward, which has nobody to send to yet', async () => {
      await render({ inline });
      await act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Reply all (a)"]')!.click());
      await settle();
      const trigger = card()!.querySelector<HTMLButtonElement>('button[aria-label="Reply all: change"]')!;
      expect(trigger).not.toBeNull();
      await act(() => { trigger.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })); });
      const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => el.textContent?.includes('Forward'))!;
      await act(() => item.click());
      expect(card()!.querySelector('button[aria-label="Forward: change"]')).not.toBeNull();
      expect(button('Edit recipients')).toBeUndefined();
      expect(card()!.querySelector('[aria-label="Message"]')?.innerHTML).toContain('Forwarded message');
      // Sending with nobody to send to says so and stays.
      await act(() => button('Send')!.click());
      expect(card()!.textContent).toContain('Add at least one recipient.');
      expect(sent).toEqual([]);
    });

    it('discard closes an untouched reply at once, and asks once something is written', async () => {
      await render({ inline });
      await act(() => { handle.current!.compose('reply'); });
      await settle();
      await act(() => button('Discard draft')!.click());
      expect(card()).toBeNull();
      await act(() => { handle.current!.compose('reply'); });
      await settle();
      await act(() => { editorOf().commands.insertContentAt(1, 'Sounds good'); });
      // Escape asks, as the discard button does.
      await act(() => { host.querySelector('.ProseMirror')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
      expect(document.body.textContent).toContain('Discard this draft?');
      await act(() => button('Keep writing')!.click());
      expect(document.body.textContent).not.toContain('Discard this draft?');
      await act(() => button('Discard draft')!.click());
      expect(document.body.textContent).toContain('Discard this draft?');
      expect(card()).not.toBeNull();
      await act(() => button('Discard')!.click());
      expect(card()).toBeNull();
      expect(detached).toEqual([]);
    });

    it('Send hands the message over and the card closes', async () => {
      await render({ inline });
      await act(() => { handle.current!.compose('reply'); });
      await settle();
      await act(() => { editorOf().commands.insertContentAt(1, 'Sounds good'); });
      await act(() => button('Send')!.click());
      expect(card()).toBeNull();
      expect(sent).toHaveLength(1);
      const o = sent[0]!;
      expect(o.accountId).toBe('acc');
      expect(o.message.to).toEqual([{ name: 'Bob Martin', address: 'bob@acme.test' }]);
      expect(o.message.subject).toBe('Re: Plan 5');
      expect(o.message.inReplyTo).toBe('<m5@x>');
      expect(o.message.text).toContain('Sounds good');
      // What Open puts back after a failed send: the same reply, as written.
      expect(o.request.mode).toBe('reply');
      expect(o.request.draft.html).toContain('Sounds good');
      expect(o.request.threadId).toBe('t:1');
    });

    it('another conversation takes a written reply to the dialog; one composer at a time', async () => {
      await render({ inline });
      await act(() => { handle.current!.compose('reply'); });
      await settle();
      await act(() => { editorOf().commands.insertContentAt(1, 'Half a thought'); });
      // A second answer does not replace what is being written.
      await act(() => { handle.current!.compose('forward'); });
      expect(host.querySelectorAll('[data-inline-compose]')).toHaveLength(1);
      expect(card()!.querySelector('button[aria-label="Reply: change"]')).not.toBeNull();
      await render({ inline, thread: { threadId: 't:9', messages: [m(9)] } });
      await settle();
      expect(card()).toBeNull();
      expect(detached).toHaveLength(1);
      expect(detached[0]!.draft.html).toContain('Half a thought');
      expect(detached[0]!.restored).toBe(true);
    });
  });
});
