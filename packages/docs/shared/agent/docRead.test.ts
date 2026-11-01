import { describe, expect, it } from 'vitest';
import { docNode } from '../doc.ts';
import { markdownToDoc } from '../docMarkdown.ts';
import { buildSlide, newId, type Deck } from '../deck.ts';
import { deckInlineContext, docInlineContext } from './docRead.ts';

const doc = docNode(markdownToDoc('# Title\n\nHello brave world.\n\n- apples\n- bananas\n\nThe end.'));
/** Position of `text` inside the document. */
const posOf = (text: string): number => {
  let at = -1;
  doc.descendants((node, pos) => {
    if (at < 0 && node.isText && node.text!.includes(text)) at = pos + node.text!.indexOf(text);
  });
  return at;
};

describe('docInlineContext', () => {
  it('sends the whole document and the text around the cursor', () => {
    const at = posOf('brave');
    const ctx = docInlineContext(doc, { from: at, to: at });
    expect(ctx.document).toBe('[1] # Title\n\n[2] Hello brave world.\n\n[3] - apples\n- bananas\n\n[4] The end.');
    expect(ctx.showing).toBeUndefined();
    expect(ctx.before).toBe('Hello ');
    expect(ctx.after).toBe('brave world.');
    expect(ctx.selectionBlocks).toBeUndefined();
  });

  it('says which blocks a selection touches', () => {
    const ctx = docInlineContext(doc, { from: posOf('brave'), to: posOf('end.') });
    expect(ctx.selectionBlocks).toEqual([2, 4]);
    expect(ctx.before).toBeUndefined();
  });

  it('keeps the blocks around the cursor when the document is too long', () => {
    const at = posOf('bananas');
    const ctx = docInlineContext(doc, { from: at, to: at }, 50);
    expect(ctx.showing).toEqual([2, 3]);
    expect(ctx.document).toBe('[2] Hello brave world.\n\n[3] - apples\n- bananas');
  });
});

describe('deckInlineContext', () => {
  const deck: Deck = { version: 1, theme: 'dark', slides: ['One', 'Two', 'Three'].map((title) => buildSlide('title-body', { title, body: ['x'] }, newId)) };

  it('sends the whole presentation, one slide per line', () => {
    const ctx = deckInlineContext(deck, 1, '  picked  ');
    const lines = ctx.deck.split('\n');
    expect(lines[0]).toBe('Theme: dark');
    expect(lines.slice(1).map((l) => JSON.parse(l).slide)).toEqual([1, 2, 3]);
    expect(JSON.parse(lines[2]).elements[0].text).toBe('Two');
    expect(ctx.showing).toBeUndefined();
    expect(ctx.selectedText).toBe('picked');
  });

  it('keeps the slides around the current one when the presentation is too long', () => {
    const one = deckInlineContext(deck, 2).deck.split('\n')[3].length;
    const ctx = deckInlineContext(deck, 2, undefined, one * 2 + 10);
    expect(ctx.showing).toEqual([2, 3]);
    expect(ctx.selectedText).toBeUndefined();
  });
});
