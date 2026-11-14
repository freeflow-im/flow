import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { MailAccount } from '../api';
import type { ComposeRequest, Outgoing } from '../lib/compose';
import { Compose } from './Compose';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const account = { id: 'acc', email: 'ann@example.com', displayName: 'Ann' } as MailAccount;
let root: Root, host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
const button = (label: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === label || b.getAttribute('aria-label') === label);

describe('Compose (the dialog)', () => {
  it("keeps a reply's quote folded behind ⋯, sends it along all the same, and puts it in the editor when asked", async () => {
    const sent: Outgoing[] = [];
    const request: ComposeRequest = {
      mode: 'reply',
      draft: { to: [{ name: 'Bob', address: 'bob@x.test' }], cc: [], bcc: [], subject: 'Re: Lunch', html: '<p></p><p>On Nov 10, Bob wrote:</p><blockquote><p>Noon?</p></blockquote>' },
    };
    await act(() => root.render(createElement(Compose, { account, request, narrow: false, onClose: () => {}, onSend: (o: Outgoing) => sent.push(o) })));
    const editor = () => document.querySelector('.ProseMirror')!;
    expect(editor().textContent).not.toContain('Noon?');
    expect(button('Show quoted text')).toBeTruthy();
    await act(() => button('Send')!.click());
    expect(sent[0]!.message.html).toContain('<blockquote><p>Noon?</p></blockquote>');
    expect(sent[0]!.message.html).toContain('On Nov 10, Bob wrote:');
    expect(sent[0]!.message.text).toContain('On Nov 10, Bob wrote:\n\nNoon?');
    expect(sent[0]!.request.draft.html).toContain('<blockquote>');
    await act(() => button('Show quoted text')!.click());
    expect(editor().textContent).toContain('Noon?');
    expect(button('Show quoted text')).toBeUndefined();
  });
  it('shows what a forward forwards', async () => {
    const request: ComposeRequest = { mode: 'forward', draft: { to: [], cc: [], bcc: [], subject: 'Fwd: Lunch', html: '<p></p><p>---------- Forwarded message ---------<br>From: Bob</p><p>Noon?</p>' } };
    await act(() => root.render(createElement(Compose, { account, request, narrow: false, onClose: () => {}, onSend: () => {} })));
    expect(document.querySelector('.ProseMirror')!.textContent).toContain('Noon?');
    expect(button('Show quoted text')).toBeUndefined();
  });

  it('Send hands the message over at once, with what Open needs to put it back', async () => {
    const sent: Outgoing[] = [];
    let closed = 0;
    const request: ComposeRequest = { mode: 'new', draft: { to: [{ name: 'Bob', address: 'bob@x.test' }], cc: [], bcc: [], subject: 'Lunch', html: '<p>Noon?</p>' } };
    await act(() => root.render(createElement(Compose, { account, request, narrow: false, onClose: () => closed++, onSend: (o: Outgoing) => sent.push(o) })));
    expect(document.body.textContent).toContain('New message');
    await act(() => button('Send')!.click());
    expect(sent).toHaveLength(1);
    expect(sent[0]!.message).toMatchObject({ to: [{ name: 'Bob', address: 'bob@x.test' }], subject: 'Lunch', text: 'Noon?' });
    expect(sent[0]!.request).toMatchObject({ mode: 'new', restored: true, draft: { subject: 'Lunch', html: '<p>Noon?</p>' } });
    expect(closed).toBe(0);
  });

  it('a new message opened to someone (the person card) closes without asking while nothing is written; with a recipient typed in, it asks', async () => {
    let closed = 0;
    const request: ComposeRequest = { mode: 'new', draft: { to: [{ name: 'Bob', address: 'bob@x.test' }], cc: [], bcc: [], subject: '', html: '' } };
    await act(() => root.render(createElement(Compose, { account, request, narrow: false, onClose: () => closed++, onSend: () => {} })));
    await act(() => button('Discard draft')!.click());
    expect(document.body.textContent).not.toContain('Discard this draft?');
    expect(closed).toBe(1);
    act(() => root.unmount());
    root = createRoot(host);
    const blank: ComposeRequest = { mode: 'new', draft: { to: [], cc: [], bcc: [], subject: 'Hi', html: '' } };
    await act(() => root.render(createElement(Compose, { account, request: blank, narrow: false, onClose: () => closed++, onSend: () => {} })));
    await act(() => button('Discard draft')!.click());
    expect(document.body.textContent).toContain('Discard this draft?');
    expect(closed).toBe(1);
  });

  it('what is wrong stays in the composer; one opened again asks before it is dropped and keeps its files', async () => {
    const sent: Outgoing[] = [];
    let closed = 0;
    const request: ComposeRequest = { mode: 'new', draft: { to: [], cc: [], bcc: [], subject: 'Lunch', html: '<p>Noon?</p>' }, files: [{ name: 'menu.pdf', type: 'application/pdf', size: 3, file: new Blob(['pdf']), forwarded: false }], restored: true };
    await act(() => root.render(createElement(Compose, { account, request, narrow: false, onClose: () => closed++, onSend: (o: Outgoing) => sent.push(o) })));
    expect(document.body.textContent).toContain('menu.pdf');
    await act(() => button('Send')!.click());
    expect(sent).toEqual([]);
    expect(document.body.textContent).toContain('Add at least one recipient.');
    await act(() => button('Discard draft')!.click());
    expect(document.body.textContent).toContain('Discard this draft?');
    expect(closed).toBe(0);
  });

  it('a Docs file dropped on it is attached by default, and sent as a link to it when switched (side-panel.md §7.1)', async () => {
    // The file's bytes, as Docs exports them.
    vi.stubGlobal('fetch', async () => new Response(new Blob(['xlsx bytes']), { headers: { 'content-type': 'application/vnd.ms-excel' } }));
    const sent: Outgoing[] = [];
    const docs = [{ kind: 'sheet' as const, id: 's1', name: 'Budget', folder: '', shared: true }];
    const request: ComposeRequest = { mode: 'new', draft: { to: [{ name: 'Joe', address: 'joe@other.test' }], cc: [], bcc: [], subject: 'Numbers', html: '<p>Here</p>' }, docs };
    await act(() => root.render(createElement(Compose, { account, request, narrow: false, onClose: () => {}, onSend: (o: Outgoing) => sent.push(o) })));
    await act(async () => {});
    expect(button('Attachment')).toBeTruthy();
    await act(() => button('Attachment')!.click());
    expect(button('Link')).toBeTruthy();
    await act(async () => button('Send')!.click());
    expect(sent).toHaveLength(1);
    expect(sent[0]!.files).toHaveLength(0);
    expect(sent[0]!.message.html).toContain('/docs/s/s1">Budget</a>');
    expect(sent[0]!.message.text).toContain('Budget: ');
    expect(sent[0]!.request.docs).toEqual(docs);
    vi.unstubAllGlobals();
  });
});
