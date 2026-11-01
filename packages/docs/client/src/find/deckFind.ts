// Find in a presentation: the matches of a query in the text of its slides (text boxes, the text in shapes, table
// cells), in order: slide by slide, element by element as they are stacked, each element's text in reading order.
import type { Deck, SlideElement } from '../../../shared/deck.ts';
import { findAll } from './find.ts';

export interface DeckMatch {
  slide: number;
  /** The element the match is in. */
  el: string;
  /** Which of that element's matches it is (its text as drawn has them in the same order). */
  n: number;
}

/** An element's pieces of text, as drawn: each paragraph of a text box, a shape's text, each table cell by rows. */
export function elementTexts(el: SlideElement): string[] {
  if (el.type === 'text') return el.paragraphs.map((p) => p.text);
  if (el.type === 'shape') return el.text ? [el.text] : [];
  if (el.type === 'table') return el.rows.flatMap((row) => row.map((cell) => cell.text));
  return [];
}

export function deckMatches(deck: Deck, query: string, matchCase: boolean): DeckMatch[] {
  const out: DeckMatch[] = [];
  if (!query) return out;
  deck.slides.forEach((slide, i) => {
    for (const el of slide.elements) {
      let n = 0;
      for (const text of elementTexts(el)) for (let k = findAll(text, query, matchCase).length; k > 0; k--) out.push({ slide: i, el: el.id, n: n++ });
    }
  });
  return out;
}
