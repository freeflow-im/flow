// Inline markdown rendering (agent replies): assertions on static HTML output.
import { describe, expect, it, vi } from 'vitest';

// The real image fetches through the connection runtime; the renderer only
// has to hand the emoji to it.
vi.mock('../components/CustomEmoji', () => ({
  CustomEmojiImage: ({ emoji }: { emoji: { shortcode: string } }) => <img data-custom-emoji={emoji.shortcode} alt="" />,
}));
import { renderToStaticMarkup } from 'react-dom/server';
import { CustomEmojiContext, fenceLanguage, InlineLinkContext, renderBlocks, renderBody, segmentBody } from './format';

const html = (body: string) => renderToStaticMarkup(<>{renderBlocks(body, {}, undefined)}</>);

describe('inline markdown', () => {
  it('renders bold, italic, strike, and inline code', () => {
    expect(html('**Projects / code**')).toBe('<strong>Projects / code</strong>');
    expect(html('a *b* c')).toBe('a <em>b</em> c');
    expect(html('a _b_ c')).toBe('a <em>b</em> c');
    expect(html('~~gone~~')).toBe('<s>gone</s>');
    const code = html('run `pnpm test` now');
    expect(code).toContain('<code');
    expect(code).toContain('pnpm test</code>');
  });

  it('nests emphasis but keeps code spans literal inside', () => {
    expect(html('**bold with *inner* text**')).toContain('<strong>bold with <em>inner</em> text</strong>');
    expect(html('`**not bold**`')).toContain('**not bold**</code>');
  });

  it('leaves ambiguous emphasis alone', () => {
    expect(html('2 * 3 * 4')).toBe('2 * 3 * 4');
    expect(html('snake_case_name and file_name')).toBe('snake_case_name and file_name');
  });

  it('renders markdown links and bare URLs', () => {
    expect(html('[docs](https://example.com/a)')).toContain('href="https://example.com/a"');
    expect(html('[docs](https://example.com/a)')).toContain('>docs</a>');
    expect(html('see https://example.com/path.')).toContain('href="https://example.com/path"');
  });

  it('auto-links a URL in a channel topic and leaves the words around it plain (#194)', () => {
    // ChannelView's header renders the topic through renderBody, so the topic
    // gets the same bare-URL rule a message body has — no second URL regex.
    const topic = renderToStaticMarkup(
      <>{renderBody('Claude skill: https://app.flowtoo.org/flow-agent-member-SKILL.md', {}, undefined)}</>,
    );
    expect(topic).toContain('href="https://app.flowtoo.org/flow-agent-member-SKILL.md"');
    expect(topic).toContain('target="_blank"');
    expect(topic).toContain('Claude skill: ');
    // The prose either side stays text, not part of the anchor.
    expect(topic.indexOf('Claude skill: ')).toBeLessThan(topic.indexOf('<a '));
  });

  it('offers a "Pin as artifact" affordance on links when a handler is in context', () => {
    // With a pin handler in context, every inline link gains the 📌 button;
    // without one (the default), links render bare.
    const withPin = renderToStaticMarkup(
      <InlineLinkContext.Provider value={{ onPinLink: () => {} }}>
        {renderBlocks('see https://example.com/x', {}, undefined)}
      </InlineLinkContext.Provider>,
    );
    expect(withPin).toContain('data-testid="inline-link-pin"');
    expect(withPin).toContain('href="https://example.com/x"');
    // Default context (no handler): a plain anchor, no pin button.
    expect(html('see https://example.com/x')).not.toContain('inline-link-pin');
  });

  it('never formats inside fenced code blocks', () => {
    const out = html('```\n**raw** `x`\n```');
    expect(out).toContain('**raw** `x`');
    expect(out).not.toContain('<strong>');
  });

  it('applies inline markdown inside quotes and around mention pills', () => {
    expect(html('> **quoted**')).toContain('<strong>quoted</strong>');
    const withPill = renderToStaticMarkup(
      <>{renderBody('**hi** <@01234567-89ab-cdef-0123-456789abcdef> `ok`', { '01234567-89ab-cdef-0123-456789abcdef': 'Ann' }, undefined)}</>,
    );
    expect(withPill).toContain('<strong>hi</strong>');
    expect(withPill).toContain('@Ann');
    expect(withPill).toContain('ok</code>');
  });

});

describe('block markdown', () => {
  it('renders ATX headings at the right level with inline content', () => {
    expect(html('# Big **title**')).toContain('<h1');
    expect(html('# Big **title**')).toContain('<strong>title</strong>');
    expect(html('### small')).toContain('<h3');
    expect(html('####### too many')).toBe('####### too many'); // 7 hashes is not a heading
  });

  it('renders unordered lists from -, *, and +', () => {
    const out = html('- one\n* two\n+ three');
    expect(out).toContain('<ul');
    expect(out.match(/<li>/g)?.length).toBe(3);
    expect(out).toContain('<li>one</li>');
  });

  it('renders ordered lists preserving the start index', () => {
    const out = html('3. third\n4. fourth');
    expect(out).toContain('<ol');
    expect(out).toContain('start="3"');
    expect(out).toContain('<li>third</li>');
  });

  it('renders a GFM pipe table with header, rows, and alignment', () => {
    const out = html('| Name | Score |\n|:-----|------:|\n| Ann | 10 |\n| Bo | 7 |');
    expect(out).toContain('<table');
    expect(out).toContain('<th');
    expect(out).toContain('Score');
    expect(out).toContain('text-right'); // second column right-aligned
    expect(out.match(/<tr>/g)?.length).toBe(3); // header + 2 body rows
    expect(out).toContain('<td');
  });

  it('normalizes ragged table rows to the header column count', () => {
    const out = html('| A | B |\n|---|---|\n| only-one |');
    // two <td> in the body row even though only one cell was given
    const bodyTds = out.split('<tbody>')[1] ?? '';
    expect(bodyTds.match(/<td/g)?.length).toBe(2);
  });

  it('renders horizontal rules but not tables from a plain line + dashes', () => {
    expect(html('---')).toContain('<hr');
    expect(html('***')).toContain('<hr');
    // "a | b" then "---" is NOT a table (separator lacks a pipe) — stays plain + rule
    const out = html('a | b\n---');
    expect(out).not.toContain('<table');
    expect(out).toContain('<hr');
  });

  it('keeps table/list/heading markup out of fenced code', () => {
    const out = html('```\n# not a heading\n- not a list\n| not | a table |\n```');
    expect(out).not.toContain('<h1');
    expect(out).not.toContain('<ul');
    expect(out).not.toContain('<table');
    expect(out).toContain('# not a heading');
  });
});

describe('mermaid blocks (#229)', () => {
  const kinds = (body: string) => segmentBody(body).map((s) => s.kind);

  it('reads the fence info string, case- and space-insensitively', () => {
    expect(fenceLanguage('```mermaid')).toBe('mermaid');
    expect(fenceLanguage('```Mermaid  ')).toBe('mermaid');
    expect(fenceLanguage('```mermaid theme=forest')).toBe('mermaid');
    expect(fenceLanguage('```ts')).toBe('ts');
    expect(fenceLanguage('```')).toBe('');
  });

  it('makes a ```mermaid fence its own segment, keeping the source verbatim', () => {
    const source = 'flowchart LR\n  A[Client] --> B[Bridge]';
    const segments = segmentBody('```mermaid\n' + source + '\n```');
    expect(segments).toEqual([{ kind: 'mermaid', content: source }]);
  });

  it('leaves every other fence a code block', () => {
    expect(kinds('```\nplain\n```')).toEqual(['code']);
    expect(kinds('```ts\nconst x = 1;\n```')).toEqual(['code']);
    // An empty diagram has nothing to draw, so it stays code.
    expect(kinds('```mermaid\n\n```')).toEqual(['code']);
  });

  it('renders the diagram in a sandboxed frame, never in this document', () => {
    const out = html('```mermaid\nflowchart LR\n  A --> B\n```');
    expect(out).toContain('data-testid="mermaid-block"');
    expect(out).toContain('src="/mermaid/sandbox.html"');
    // No allow-same-origin: the frame gets an opaque origin and cannot reach
    // this document. Losing that is the whole isolation, so assert it.
    expect(out).toContain('sandbox="allow-scripts"');
    expect(out).not.toContain('allow-same-origin');
    // The source is not written into this document as markup.
    expect(out).not.toContain('flowchart LR');
  });

  it('offers a copy-source control', () => {
    expect(html('```mermaid\nflowchart LR\n  A --> B\n```')).toContain('data-testid="mermaid-copy"');
  });

  it('does not disturb neighbouring blocks', () => {
    expect(kinds('# T\n```mermaid\npie\n```\n- a')).toEqual(['heading', 'mermaid', 'ulist']);
  });
});

describe('emoji in text', () => {
  it('sizes unicode emoji up like Slack, keeping ZWJ sequences, tones and flags whole', () => {
    const out = html('great 🙂 and 👍🏽 and 👩‍💻 and 🇺🇸!');
    expect(out.match(/data-emoji/g)?.length).toBe(4);
    expect(out).toContain('>👍🏽</span>');
    expect(out).toContain('>👩‍💻</span>');
    expect(out).toContain('>🇺🇸</span>');
    expect(out).toContain('great ');
    expect(html('no emoji here 10:30')).toBe('no emoji here 10:30');
  });
});

describe('custom emoji in text', () => {
  it('draws a known :shortcode: inline and leaves unknown ones, times and code as text', () => {
    const party = { id: 'e1', workspaceId: 'w1', shortcode: 'partyparrot', emoji: ':partyparrot:', fileId: 'emoji:partyparrot', createdBy: '', createdAt: '' };
    const out = renderToStaticMarkup(
      <CustomEmojiContext.Provider value={{ ':partyparrot:': party }}>
        {renderBlocks('HaPpY **bday** :partyparrot: :nope: at 10:30:45 `:partyparrot:`', {}, undefined)}
      </CustomEmojiContext.Provider>,
    );
    expect(out).toContain('data-custom-emoji="partyparrot"');
    expect(out).not.toContain(' :partyparrot: ');
    expect(out).toContain(':nope:');
    expect(out).toContain('10:30:45');
    expect(out).toContain('<code');
    expect(out).toContain(':partyparrot:</code>');
    expect(html('plain :partyparrot: text')).toBe('plain :partyparrot: text');
  });
});
