import { describe, expect, it } from 'vitest';
import { markdownToMrkdwn, mrkdwnToMarkdown } from '../../shared/src/mrkdwn.js';

describe('mrkdwnToMarkdown (inbound: Slack -> stored markdown)', () => {
  it('converts bold', () => {
    expect(mrkdwnToMarkdown('this is *bold* text')).toBe('this is **bold** text');
    expect(mrkdwnToMarkdown('*b*')).toBe('**b**');
  });

  it('leaves italic unchanged', () => {
    expect(mrkdwnToMarkdown('some _italic_ text')).toBe('some _italic_ text');
  });

  it('converts strikethrough', () => {
    expect(mrkdwnToMarkdown('a ~struck~ word')).toBe('a ~~struck~~ word');
  });

  it('does not treat spaced-out * or ~ as formatting', () => {
    expect(mrkdwnToMarkdown('2 * 3 * 4')).toBe('2 * 3 * 4');
    expect(mrkdwnToMarkdown('a ~ b ~ c')).toBe('a ~ b ~ c');
  });

  it('never converts inside inline code', () => {
    expect(mrkdwnToMarkdown('use `*argv` here')).toBe('use `*argv` here');
    expect(mrkdwnToMarkdown('`<http://x|y> and *bold*`')).toBe('`<http://x|y> and *bold*`');
  });

  it('never converts inside code fences', () => {
    const fence = '```\n*bold* <@U1> &amp; <http://a|b>\n```';
    expect(mrkdwnToMarkdown(fence)).toBe(fence);
    expect(mrkdwnToMarkdown(`before *x*\n${fence}\nafter ~y~`)).toBe(
      `before **x**\n${fence}\nafter ~~y~~`,
    );
  });

  it('converts labeled links', () => {
    expect(mrkdwnToMarkdown('see <https://example.com/a?b=1|the docs>')).toBe(
      'see [the docs](https://example.com/a?b=1)',
    );
  });

  it('unwraps bare links', () => {
    expect(mrkdwnToMarkdown('go to <https://example.com>')).toBe('go to https://example.com');
    expect(mrkdwnToMarkdown('<mailto:a@b.c>')).toBe('mailto:a@b.c');
  });

  it('decodes entities inside urls and labels', () => {
    expect(mrkdwnToMarkdown('<https://e.com/?a=1&amp;b=2|x &amp; y>')).toBe('[x & y](https://e.com/?a=1&b=2)');
  });

  it('passes user mentions through (stripping labels)', () => {
    expect(mrkdwnToMarkdown('hi <@0192aaaa-bbbb-7ccc-8ddd-eeeeffff0000>')).toBe(
      'hi <@0192aaaa-bbbb-7ccc-8ddd-eeeeffff0000>',
    );
    expect(mrkdwnToMarkdown('hi <@U123|nick>')).toBe('hi <@U123>');
  });

  it('passes group mentions through (stripping labels)', () => {
    expect(mrkdwnToMarkdown('<!channel> and <!here|attn> and <!everyone>')).toBe(
      '<!channel> and <!here> and <!everyone>',
    );
  });

  it('degrades channel links (documented lossy)', () => {
    expect(mrkdwnToMarkdown('join <#C0123|general> now')).toBe('join #general now');
    expect(mrkdwnToMarkdown('join <#C0123> now')).toBe('join #channel now');
  });

  it('degrades unknown special tokens to their fallback text', () => {
    expect(mrkdwnToMarkdown('at <!date^1392734382^{date_short}|Feb 18, 2014> ok')).toBe('at Feb 18, 2014 ok');
    expect(mrkdwnToMarkdown('<!subteam^S012|@devs>')).toBe('@devs');
  });

  it('decodes Slack entity escapes', () => {
    expect(mrkdwnToMarkdown('a &amp; b &lt;c&gt; d')).toBe('a & b <c> d');
  });

  it('handles a combined message', () => {
    expect(
      mrkdwnToMarkdown('*hey* <@U1>, see <https://x.io|this> &amp; `keep *this*` ~old~'),
    ).toBe('**hey** <@U1>, see [this](https://x.io) & `keep *this*` ~~old~~');
  });
});

describe('markdownToMrkdwn (outbound: stored markdown -> Slack)', () => {
  it('converts bold', () => {
    expect(markdownToMrkdwn('this is **bold** text')).toBe('this is *bold* text');
  });

  it('leaves italic unchanged', () => {
    expect(markdownToMrkdwn('some _italic_ text')).toBe('some _italic_ text');
  });

  it('converts strikethrough', () => {
    expect(markdownToMrkdwn('a ~~struck~~ word')).toBe('a ~struck~ word');
  });

  it('never converts inside inline code or fences', () => {
    expect(markdownToMrkdwn('run `a && b` now')).toBe('run `a && b` now');
    const fence = '```\n**bold** <tag> & [x](http://y)\n```';
    expect(markdownToMrkdwn(fence)).toBe(fence);
  });

  it('converts markdown links to <url|label>', () => {
    expect(markdownToMrkdwn('see [the docs](https://example.com/a?b=1)')).toBe(
      'see <https://example.com/a?b=1|the docs>',
    );
  });

  it('escapes & inside converted urls and labels', () => {
    expect(markdownToMrkdwn('[x & y](https://e.com/?a=1&b=2)')).toBe('<https://e.com/?a=1&amp;b=2|x &amp; y>');
  });

  it('wraps bare urls', () => {
    expect(markdownToMrkdwn('go to https://example.com/x now')).toBe('go to <https://example.com/x> now');
    expect(markdownToMrkdwn('end of sentence https://e.com.')).toBe('end of sentence <https://e.com>.');
  });

  it('does not wrap urls glued to a preceding word', () => {
    expect(markdownToMrkdwn('xhttps://not-a-link')).toBe('xhttps://not-a-link');
  });

  it('passes storage mention tokens through unescaped', () => {
    expect(markdownToMrkdwn('hi <@0192aaaa-bbbb-7ccc-8ddd-eeeeffff0000> and <!channel>')).toBe(
      'hi <@0192aaaa-bbbb-7ccc-8ddd-eeeeffff0000> and <!channel>',
    );
  });

  it('re-encodes literal < > & as entities', () => {
    expect(markdownToMrkdwn('a & b <c> d')).toBe('a &amp; b &lt;c&gt; d');
    expect(markdownToMrkdwn('5 < 6 > 4')).toBe('5 &lt; 6 &gt; 4');
  });

  it('handles a combined message', () => {
    expect(
      markdownToMrkdwn('**hey** <@U1>, see [this](https://x.io) & `keep **this**` ~~old~~'),
    ).toBe('*hey* <@U1>, see <https://x.io|this> &amp; `keep **this**` ~old~');
  });
});

describe('round-trip stability', () => {
  it('inbound then outbound returns the original mrkdwn for the common cases', () => {
    const samples = [
      'plain text',
      '*bold* and _italic_ and ~strike~',
      'link <https://example.com|label> and bare <https://example.com>',
      'mention <@U123> and <!here>',
      'code `x = *y*` stays',
      'a &amp; b',
    ];
    for (const s of samples) {
      // bare <url> comes back as <url>; everything else must be byte-identical
      expect(markdownToMrkdwn(mrkdwnToMarkdown(s))).toBe(s);
    }
  });
});
