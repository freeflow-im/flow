import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChatItem } from '../../../shared/agent/protocol.ts';
import { ChatMarkdown, chatUrl, picturesOf } from './ChatMarkdown.tsx';

const render = (text: string) => renderToStaticMarkup(createElement(ChatMarkdown, { text }));

describe('assistant chat Markdown', () => {
  it('renders bold headings, inline bold and bulleted lists', () => {
    const html = render('**How I’d rewrite your opening**\n\nI’d lead with **founding CTO** experience.\n\n- Cut the summary\n- Lead with impact\n  - nested point');
    expect(html).toContain('<strong>How I’d rewrite your opening</strong>');
    expect(html).toContain('<strong>founding CTO</strong>');
    expect(html).not.toContain('**');
    expect(html).toMatch(/<ul>\s*<li>Cut the summary<\/li>/);
    expect(html).toMatch(/<li>Lead with impact\s*<ul>\s*<li>nested point<\/li>/);
  });

  it('renders headings, italics, ordered lists, quotes, breaks and code', () => {
    const html = render('## Plan\n\n*one* and _two_\n\n1. first\n2. second\n\n> quoted\n\nline one  \nline two\n\nUse `a*b*c` here.\n\n```js\nconst x = 2 ** 3; // **not bold**\n```');
    expect(html).toContain('<h2>Plan</h2>');
    expect(html).toContain('<em>one</em> and <em>two</em>');
    expect(html).toMatch(/<ol>\s*<li>first<\/li>/);
    expect(html).toContain('<blockquote>');
    expect(html).toContain('line one<br/>');
    expect(html).toContain('<code>a*b*c</code>');
    expect(html).toContain('<pre><code class="language-js">const x = 2 ** 3; // **not bold**');
  });

  it('opens links safely in a new tab', () => {
    const html = render('See [docs](https://example.com/a) and <https://example.org>.');
    expect(html).toContain('href="https://example.com/a" target="_blank" rel="noopener noreferrer"');
    expect(html).toContain('href="https://example.org"');
  });

  it('does not render raw HTML or unsafe URLs', () => {
    const html = render('<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">\n\nhi <b>there</b> [x](javascript:alert(1)) [y](data:text/html,hi) ![pic](https://evil.example/t.png)');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('<b>');
    expect(html).not.toContain('javascript:');
    expect(html).not.toContain('data:');
    expect(html).not.toContain('<img');
    expect(html).toContain('[pic]');
    expect(chatUrl('vbscript:x')).toBe('');
    expect(chatUrl('mailto:a@b.c')).toBe('mailto:a@b.c');
    expect(chatUrl('/sheets/1')).toBe('/sheets/1');
  });

  it('loads a picture only from the app or from an image search in the chat; any other picture is a link', () => {
    const items: ChatItem[] = [
      { kind: 'tool', id: 't1', name: 'image_search', input: { query: 'tabby cat' }, status: 'ok', result: JSON.stringify({ note: 'untrusted', results: [{ title: 'Tabby', image_url: 'https://upload.example/a/tabby.jpg', source_page_url: null }] }) },
      { kind: 'tool', id: 't2', name: 'image_search', input: { query: 'x' }, status: 'error', result: '{"results":[{"image_url":"https://upload.example/failed.jpg"}]}' },
      { kind: 'tool', id: 't3', name: 'web_search', input: { query: 'x' }, status: 'ok', result: '{"results":[{"image_url":"https://upload.example/web.jpg"}]}' },
      { kind: 'tool', id: 't4', name: 'image_search', input: { query: 'x' }, status: 'ok', result: 'not json' },
    ];
    const pictures = picturesOf(items);
    expect([...pictures]).toEqual(['https://upload.example/a/tabby.jpg']);
    const text = '![A tabby](https://upload.example/a/tabby.jpg)\n\n![Mine](/api/images/abc)\n\n![Other](https://evil.example/t.png?secret=1)\n\n![Also](//evil.example/t.png)';
    const html = renderToStaticMarkup(createElement(ChatMarkdown, { text, pictures }));
    expect(html.match(/<img /g)).toHaveLength(2);
    expect(html).toContain('<a class="agent-md-picture" href="https://upload.example/a/tabby.jpg" target="_blank" rel="noopener noreferrer"><img src="https://upload.example/a/tabby.jpg" alt="A tabby" loading="lazy" referrerPolicy="no-referrer"/></a>');
    expect(html).toContain('<img src="/api/images/abc" alt="Mine"');
    expect(html).toContain('<a class="agent-md-img" href="https://evil.example/t.png?secret=1" target="_blank" rel="noopener noreferrer">[Other]</a>');
    expect(html).toContain('>[Also]</a>');
    // Without the chat's pictures, the same picture is a link.
    expect(render('![A tabby](https://upload.example/a/tabby.jpg)')).not.toContain('<img');
  });

  it('renders every prefix of a streamed reply without throwing', () => {
    const full = '# Title\n\n**Bold** and `code` with [a link](https://e.com).\n\n- one\n  1. nested\n\n```ts\nlet a = 1;\n```\n\n| a | b |\n|---|---|\n| 1 | 2 |\n';
    for (let i = 0; i <= full.length; i++) expect(() => render(full.slice(0, i))).not.toThrow();
    expect(render('**unfinished bold')).toContain('**unfinished bold');
    expect(render(full)).toContain('<div class="agent-md-table"><table>');
  });

  it('handles long content', () => {
    const long = Array.from({ length: 500 }, (_, i) => `- item **${i}** ${'word '.repeat(20)}`).join('\n');
    const html = render(long);
    expect(html.match(/<li>/g)).toHaveLength(500);
  });
});
