import { describe, expect, it } from 'vitest';
import type { MessageDetail } from '../api';
import { forwardSubject, isDraftEmpty, prefill, replySubject } from './compose';

const msg = (over: Partial<MessageDetail> = {}): MessageDetail => ({
  uid: 7,
  folder: 'INBOX',
  messageId: '<m7@x.test>',
  from: { name: 'Bob', address: 'bob@x.test' },
  to: [{ name: 'Ann', address: 'ann@example.com' }, { name: 'Chen', address: 'chen@x.test' }],
  cc: [{ name: '', address: 'dana@x.test' }, { name: '', address: 'ANN@example.com' }],
  replyTo: [],
  bcc: [],
  subject: 'Plans',
  snippet: '',
  date: '2026-11-02T10:00:00Z',
  seen: true,
  flagged: false,
  answered: false,
  hasAttachments: true,
  size: 1,
  inReplyTo: '<m6@x.test>',
  references: ['<m5@x.test>', '<m6@x.test>'],
  html: '<p>See <b>this</b></p><script>bad()</script><img src="https://t.test/p.gif">',
  text: 'See this',
  attachments: [
    { index: 0, filename: 'plan.pdf', mimeType: 'application/pdf', size: 10, contentId: null, inline: false },
    { index: 1, filename: 'logo.png', mimeType: 'image/png', size: 5, contentId: '<logo>', inline: true },
  ],
  ...over,
});

describe('subjects', () => {
  it('adds Re: and Fwd: once', () => {
    expect(replySubject('Plans')).toBe('Re: Plans');
    expect(replySubject('RE: Plans')).toBe('RE: Plans');
    expect(forwardSubject('Plans')).toBe('Fwd: Plans');
    expect(forwardSubject('Fw: Plans')).toBe('Fw: Plans');
  });
});

describe('prefill', () => {
  it('replies to the sender, threading the message and quoting it cleaned', () => {
    const d = prefill('reply', msg(), 'ann@example.com');
    expect(d.to).toEqual([{ name: 'Bob', address: 'bob@x.test' }]);
    expect(d.cc).toEqual([]);
    expect(d.subject).toBe('Re: Plans');
    expect(d.inReplyTo).toBe('<m7@x.test>');
    expect(d.references).toEqual(['<m5@x.test>', '<m6@x.test>', '<m7@x.test>']);
    expect(d.html).toContain('wrote:</p><blockquote><p>See <b>this</b></p>');
    expect(d.html).not.toContain('script');
    expect(d.html).not.toMatch(/\ssrc="https:/);
  });

  it('replies to Reply-To when there is one', () => {
    expect(prefill('reply', msg({ replyTo: [{ name: 'List', address: 'list@x.test' }] }), 'ann@example.com').to).toEqual([{ name: 'List', address: 'list@x.test' }]);
  });

  it('replies to everyone but me, once each', () => {
    const d = prefill('replyAll', msg(), 'ann@example.com');
    expect(d.to.map((a) => a.address)).toEqual(['bob@x.test']);
    expect(d.cc.map((a) => a.address)).toEqual(['chen@x.test', 'dana@x.test']);
  });

  it('replying to my own message goes to its recipients', () => {
    const d = prefill('reply', msg({ from: { name: 'Ann', address: 'ann@example.com' }, to: [{ name: 'Bob', address: 'bob@x.test' }] }), 'ann@example.com');
    expect(d.to.map((a) => a.address)).toEqual(['bob@x.test']);
  });

  it('forwards with no recipients, the original’s header and its attachments', () => {
    const d = prefill('forward', msg(), 'ann@example.com');
    expect(d.to).toEqual([]);
    expect(d.subject).toBe('Fwd: Plans');
    expect(d.inReplyTo).toBeUndefined();
    expect(d.html).toContain('Forwarded message');
    expect(d.html).toContain('From: Bob &lt;bob@x.test&gt;');
    expect(d.forwardAttachments).toEqual([{ index: 0, filename: 'plan.pdf', mimeType: 'application/pdf', size: 10 }]);
  });

  it('quotes a plain-text message escaped', () => {
    const d = prefill('reply', msg({ html: null, text: '<hi> & bye' }), 'ann@example.com');
    expect(d.html).toContain('<blockquote><p>&lt;hi&gt; &amp; bye</p></blockquote>');
  });
});

describe('isDraftEmpty', () => {
  const blank = { to: [], cc: [], bcc: [], subject: '', text: '', bodyChanged: false, attachments: 0 };
  it('a new message is empty until something is in it', () => {
    expect(isDraftEmpty(blank, null)).toBe(true);
    expect(isDraftEmpty({ ...blank, subject: 'x' }, null)).toBe(false);
    expect(isDraftEmpty({ ...blank, attachments: 1 }, null)).toBe(false);
  });
  it('a reply only opened is empty; one written in is not', () => {
    const d = prefill('reply', msg(), 'ann@example.com');
    const state = { ...blank, to: d.to, subject: d.subject, text: 'quoted text' };
    expect(isDraftEmpty(state, d)).toBe(true);
    expect(isDraftEmpty({ ...state, bodyChanged: true }, d)).toBe(false);
    expect(isDraftEmpty({ ...state, to: [] }, d)).toBe(false);
  });
});
