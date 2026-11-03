import { describe, expect, it } from 'vitest';
import { buildSrcdoc, contentPolicy, linkify, sanitizeEmailHtml, textToHtml } from './sanitize';

const clean = (html: string, allowRemote = false, cidUrl?: (cid: string) => string | null) => sanitizeEmailHtml(html, { allowRemote, ...(cidUrl ? { cidUrl } : {}) });

describe('sanitizeEmailHtml', () => {
  it('removes scripts, event handlers, forms, frames and javascript: links', () => {
    const { html } = clean(`<p onclick="steal()" onmouseover="x()">Hi</p><script>alert(1)</script><img src="x.png" onerror="alert(2)">
      <form action="https://evil.test"><input name="pw"><button>Go</button></form><iframe src="https://evil.test"></iframe>
      <object data="x.swf"></object><embed src="x"><a href="javascript:alert(3)">click</a><svg><script>alert(4)</script></svg>
      <meta http-equiv="refresh" content="0;url=https://evil.test"><base href="https://evil.test/"><link rel="stylesheet" href="https://evil.test/x.css">`);
    expect(html).not.toMatch(/<script|onclick|onmouseover|onerror|<form|<input|<button|<iframe|<object|<embed|javascript:|<svg|<meta|<base|<link/i);
    expect(html).toContain('<p>Hi</p>');
  });

  it('keeps ordinary formatting, tables and style sheets', () => {
    const { html } = clean('<style>.a{color:red}</style><table><tr><td class="a" style="color:blue"><b>Bold</b></td></tr></table>');
    expect(html).toContain('<style>.a{color:red}</style>');
    expect(html).toContain('<b>Bold</b>');
    expect(html).toContain('style="color:blue"');
  });

  it('opens links in a new tab without a referrer or opener', () => {
    const { html } = clean('<a href="https://example.com">x</a>');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('holds back remote images, backgrounds and CSS urls until allowed', () => {
    const src = `<img src="https://tracker.test/open.gif"><img src="//cdn.test/a.png"><table background="http://x.test/bg.png"><tr><td style="background:url('https://x.test/c.png')">x</td></tr></table><style>.h{background:url(https://x.test/h.png)}</style>`;
    const blocked = clean(src);
    expect(blocked.hasRemote).toBe(true);
    expect(blocked.html).not.toMatch(/\ssrc="(https?:|\/\/)/);
    expect(blocked.html).not.toContain('https://x.test');
    expect(blocked.html).toContain('data-remote-src="https://tracker.test/open.gif"');
    const allowed = clean(src, true);
    expect(allowed.hasRemote).toBe(true);
    expect(allowed.html).toContain('src="https://tracker.test/open.gif"');
    expect(allowed.html).toContain('background="http://x.test/bg.png"');
    expect(allowed.html).toContain('https://x.test/h.png');
  });

  it('reports no remote content for a message without any', () => {
    const r = clean('<p>Hello</p><img src="data:image/png;base64,AAAA">');
    expect(r.hasRemote).toBe(false);
    expect(r.html).toContain('src="data:image/png;base64,AAAA"');
  });

  it('points cid: images at the attachment, inline, and drops unknown ones', () => {
    const urls: Record<string, string> = { 'logo@news': '/v1/mail/accounts/a/messages/7/attachments/2?folder=INBOX&inline=1' };
    const { html, hasRemote } = clean('<img src="cid:logo@news"><img src="cid:missing@x">', false, (cid) => urls[cid] ?? null);
    expect(html).toContain('src="/v1/mail/accounts/a/messages/7/attachments/2?folder=INBOX&amp;inline=1"');
    expect(html.match(/<img/g)).toHaveLength(2);
    expect(html).not.toContain('cid:');
    expect(hasRemote).toBe(false);
  });
});

describe('the iframe document', () => {
  it('has a policy that forbids scripts and only allows remote images when asked', () => {
    const blocked = contentPolicy(false, 'https://app.test');
    expect(blocked).toContain("script-src 'none'");
    expect(blocked).toContain("default-src 'none'");
    expect(blocked).not.toMatch(/img-src[^;]*https:(?!\/\/app)/);
    expect(contentPolicy(true, 'https://app.test')).toMatch(/img-src[^;]*https:/);
    const doc = buildSrcdoc('<p>x</p>', false, 'https://app.test');
    expect(doc).toContain('http-equiv="Content-Security-Policy"');
    expect(doc).toContain('<base target="_blank">');
    expect(doc).toContain('<body><p>x</p></body>');
  });
});

describe('plain text', () => {
  it('finds web and email addresses', () => {
    expect(linkify('See https://example.com/a?b=1. Or write to ann@example.com, or www.test.org!')).toEqual([
      { kind: 'text', text: 'See ' },
      { kind: 'link', text: 'https://example.com/a?b=1', href: 'https://example.com/a?b=1' },
      { kind: 'text', text: '. Or write to ' },
      { kind: 'link', text: 'ann@example.com', href: 'mailto:ann@example.com' },
      { kind: 'text', text: ', or ' },
      { kind: 'link', text: 'www.test.org', href: 'https://www.test.org' },
      { kind: 'text', text: '!' },
    ]);
  });
  it('escapes text when quoting it as HTML', () => {
    expect(textToHtml('<b>hi</b>\nthere\n\nnext')).toBe('<p>&lt;b&gt;hi&lt;/b&gt;<br>there</p><p>next</p>');
  });
});
