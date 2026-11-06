import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { MessageDetail } from '../api';
import { MessageBody } from './MessageBody';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const message: MessageDetail = {
  uid: 1, folder: 'INBOX', messageId: '<m1@x>', from: { name: 'Bob', address: 'bob@acme.test' }, to: [], cc: [], replyTo: [], bcc: [], subject: 'Plan',
  snippet: '', date: '2026-11-01T10:00:00.000Z', seen: true, flagged: false, answered: false, hasAttachments: false, size: 10, inReplyTo: null, references: [],
  html: '<p>See <a href="https://example.test">the plan</a></p>', text: null, attachments: [],
};

let root: Root, host: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const press = (target: EventTarget, key: string, init: KeyboardEventInit = {}) => {
  const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(e);
  return e;
};

describe('MessageBody', () => {
  it("relays keys pressed in the message's frame to the window, so the shortcuts work after a click in the message", async () => {
    await act(() => root.render(createElement(MessageBody, { accountId: 'acc', message })));
    const doc = host.querySelector('iframe')!.contentDocument!;
    // jsdom does not load srcdoc; the frame watches its document once the body has content (the 250 ms tick).
    doc.body.innerHTML = '<p>See <a href="https://example.test">the plan</a></p><input id="f">';
    await act(() => vi.advanceTimersByTime(250));

    const seen: KeyboardEvent[] = [];
    const onKey = (e: KeyboardEvent) => { seen.push(e); if (e.key === 'j') e.preventDefault(); };
    window.addEventListener('keydown', onKey);
    try {
      const j = press(doc.querySelector('a')!, 'j', { shiftKey: true });
      // The window's own event (its target is no node of the frame), with the key's modifiers.
      expect(seen.map((e) => [e.key, e.shiftKey, e.target instanceof Node])).toEqual([['j', true, false]]);
      // The app acted on it: cancelled in the frame too, so it does not scroll the message.
      expect(j.defaultPrevented).toBe(true);
      const x = press(doc.body, 'x');
      expect(seen.map((e) => e.key)).toEqual(['j', 'x']);
      expect(x.defaultPrevented).toBe(false);
      // Typing in a field the message contains is not a shortcut.
      press(doc.querySelector('input')!, 'j');
      expect(seen.map((e) => e.key)).toEqual(['j', 'x']);
    } finally {
      window.removeEventListener('keydown', onKey);
    }
  });
});
