import PostalMime from 'postal-mime';
import { describe, expect, it } from 'vitest';
import type { MessageDetail } from './convert';
import { compileMime, outgoingMessage } from './drafts';
import { bodyText, htmlToText, markdownToHtml, parseAddress, prefill, truncateText } from './mailText';

describe('htmlToText', () => {
  it('keeps what a reader sees, with links as text (address)', () => {
    const html = `<html><head><title>Ignored</title><style>p{color:red}</style></head><body>
      <div style="display:none">preheader text</div>
      <h1>Order shipped</h1><p>Hi Ann,<br>your order is on its way.</p>
      <p>Track it <a href="https://ship.test/t?id=1&amp;x=2">here</a> or see <a href="https://ship.test">https://ship.test</a>.</p>
      <ul><li>One</li><li>Two</li></ul>
      <p>Write to <a href="mailto:help@ship.test">help@ship.test</a>. <a href="javascript:alert(1)">Click</a> <img src="https://t.test/p.gif" alt="Logo"><img src="x.gif"></p>
      <script>alert(1)</script><!-- note --><p>Caf&eacute; &amp; &#x2014; &nbsp;done</p></body></html>`;
    const text = htmlToText(html);
    expect(text).toBe(
      'Order shipped\n\nHi Ann,\nyour order is on its way.\n\nTrack it here (https://ship.test/t?id=1&x=2) or see https://ship.test.\n\n- One\n- Two\n\nWrite to help@ship.test. Click [Logo]\n\nCaf&eacute; & — done',
    );
    expect(text).not.toMatch(/preheader|alert|Ignored|color/);
  });

  it('reads a message: its HTML when it has one, else its text', () => {
    expect(bodyText({ html: '<p>A</p><p>B</p>', text: 'plain' })).toBe('A\n\nB');
    expect(bodyText({ html: null, text: 'line 1\r\nline 2\r\n' })).toBe('line 1\nline 2');
  });

  it('cuts a long body near a line or word', () => {
    expect(truncateText('short', 10)).toEqual({ text: 'short', truncated: false });
    const r = truncateText('word '.repeat(100), 52);
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(52);
    expect(r.text.endsWith('word')).toBe(true);
  });
});

describe('markdownToHtml', () => {
  it('formats Markdown and never passes raw HTML through', () => {
    const html = markdownToHtml('Hi **Bo**,\n\n- one\n- [two](https://x.test)\n\n<script>alert(1)</script><img src=x onerror=alert(1)>');
    expect(html).toContain('<strong>Bo</strong>');
    expect(html).toContain('<li><a href="https://x.test">two</a></li>');
    expect(html).not.toMatch(/<script|<img|onerror=alert\(1\)>/);
    expect(markdownToHtml('[x](javascript:alert(1))')).not.toContain('javascript:');
  });
});

describe('addresses', () => {
  it('reads what an agent writes', () => {
    expect(parseAddress('ann@example.com')).toEqual({ name: '', address: 'ann@example.com' });
    expect(parseAddress('"Lee, Ann" <ann@example.com>')).toEqual({ name: 'Lee, Ann', address: 'ann@example.com' });
    expect(parseAddress('Ann')).toBeNull();
  });
});

const original: MessageDetail = {
  uid: 7, folder: 'INBOX', messageId: '<orig@example.com>', from: { name: 'Bo', address: 'bo@example.com' },
  to: [{ name: 'Ann', address: 'ann@test.local' }, { name: 'Dee', address: 'dee@example.com' }], cc: [{ name: '', address: 'cy@example.com' }],
  subject: 'Re: Plans', snippet: '', date: '2026-11-01T10:00:00.000Z', seen: true, flagged: false, answered: false, hasAttachments: false, size: 1,
  replyTo: [], bcc: [], inReplyTo: '<root@example.com>', references: ['<root@example.com>'], html: null, text: 'Line one\nLine two', attachments: [],
};

describe('prefill', () => {
  it('replies to the sender, or everyone, threaded and quoted, as Mail’s compose does', () => {
    const r = prefill('reply', original, 'ann@test.local');
    expect(r).toMatchObject({ to: [{ name: 'Bo', address: 'bo@example.com' }], cc: [], subject: 'Re: Plans', inReplyTo: '<orig@example.com>', references: ['<root@example.com>', '<orig@example.com>'] });
    expect(r.quoteText).toBe('On Sun, 01 Nov 2026 10:00:00 GMT, Bo <bo@example.com> wrote:\n> Line one\n> Line two');
    expect(r.quoteHtml).toContain('<blockquote><p>Line one<br>Line two</p></blockquote>');
    const all = prefill('replyAll', original, 'ann@test.local');
    expect(all.cc.map((a) => a.address)).toEqual(['dee@example.com', 'cy@example.com']);
  });

  it('forwards with the original’s headers, unthreaded', () => {
    const f = prefill('forward', original, 'ann@test.local');
    expect(f.subject).toBe('Fwd: Re: Plans');
    expect(f.to).toEqual([]);
    expect(f.inReplyTo).toBeUndefined();
    expect(f.quoteText).toMatch(/^---------- Forwarded message ---------\nFrom: Bo <bo@example.com>\n/);
  });
});

describe('a draft’s MIME', () => {
  it('has both bodies, the threading headers, Bcc kept for the sender’s copy, and the files', async () => {
    const message = outgoingMessage(
      { email: 'ann@test.local', displayName: 'Ann' },
      { to: [{ name: 'Bo', address: 'bo@example.com' }], bcc: [{ name: '', address: 'boss@test.local' }], subject: 'Re: Plans', html: '<p>Sounds <strong>good</strong></p>', text: 'Sounds **good**', inReplyTo: 'orig@example.com', references: ['<root@example.com>', 'orig@example.com'] },
      [{ filename: 'plan.csv', contentType: 'text/csv', content: Buffer.from('a,b\n') }],
      new Date('2026-11-03T09:00:00Z'),
    );
    expect(message.messageId).toMatch(/^<[0-9a-f-]+@test\.local>$/);
    const raw = await compileMime(message, true);
    const text = raw.toString('utf8');
    expect(text).toMatch(/^In-Reply-To: <orig@example\.com>$/m);
    expect(text).toMatch(/^References: <root@example\.com> <orig@example\.com>$/m);
    expect(text).toMatch(/^Bcc: boss@test\.local$/m);
    expect(text).toMatch(/^From: Ann <ann@test\.local>$/m);
    const parsed = await PostalMime.parse(raw);
    expect(parsed.subject).toBe('Re: Plans');
    expect(parsed.html).toContain('<strong>good</strong>');
    expect(parsed.text?.trim()).toBe('Sounds **good**');
    expect(parsed.attachments.map((a) => a.filename)).toEqual(['plan.csv']);
    expect(parsed.messageId).toBe(message.messageId);
    // A copy that is sent leaves Bcc out.
    expect((await compileMime(message, false)).toString('utf8')).not.toMatch(/^Bcc:/m);
  });
});
