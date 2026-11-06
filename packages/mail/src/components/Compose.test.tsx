import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
});
