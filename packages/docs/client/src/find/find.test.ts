import { describe, expect, it } from 'vitest';
import { newDeck, newId, type Deck } from '../../../shared/deck.ts';
import { docNode } from '../../../shared/doc.ts';
import { markdownToDoc } from '../../../shared/docMarkdown.ts';
import { deckMatches } from './deckFind.ts';
import { docMatches } from './docFind.ts';
import { findAll, stepIndex } from './find.ts';

describe('find', () => {
  it('finds each match once, with or without case', () => {
    expect(findAll('Aaa aaa', 'aa', false)).toEqual([0, 4]);
    expect(findAll('Aaa aaa', 'Aa', true)).toEqual([0]);
    expect(findAll('abc', '', false)).toEqual([]);
    expect([stepIndex(-1, 3, 1), stepIndex(-1, 3, -1), stepIndex(2, 3, 1), stepIndex(0, 3, -1), stepIndex(0, 0, 1)]).toEqual([0, 2, 0, 2, -1]);
  });

  it('finds text in a document as positions, block by block', () => {
    const doc = docNode(markdownToDoc('# Plan\n\nThe plan is **a plan**.\n\n- plan B'));
    const hits = docMatches(doc, 'plan', false);
    expect(hits.map((h) => doc.textBetween(h.from, h.to))).toEqual(['Plan', 'plan', 'plan', 'plan']);
    // Not across the end of one paragraph and the start of the next.
    expect(docMatches(doc, 'PlanThe', false)).toEqual([]);
  });

  it('finds text in every slide, element by element', () => {
    const deck: Deck = newDeck();
    const slide = deck.slides[0];
    slide.elements = [
      { id: 't', type: 'text', x: 0, y: 0, w: 100, h: 50, paragraphs: [{ text: 'Revenue up' }, { text: 'revenue down' }] },
      { id: 'tb', type: 'table', x: 0, y: 60, w: 100, h: 50, cols: [1, 1], rows: [[{ text: 'Revenue' }, { text: 'Cost' }]] },
    ] as Deck['slides'][number]['elements'];
    deck.slides.push({ ...slide, id: newId(), elements: [{ id: 's', type: 'shape', shape: 'rect', x: 0, y: 0, w: 10, h: 10, text: 'more revenue' }] as Deck['slides'][number]['elements'] });
    expect(deckMatches(deck, 'revenue', false)).toEqual([
      { slide: 0, el: 't', n: 0 },
      { slide: 0, el: 't', n: 1 },
      { slide: 0, el: 'tb', n: 0 },
      { slide: 1, el: 's', n: 0 },
    ]);
    expect(deckMatches(deck, 'revenue', true)).toHaveLength(2);
  });
});
