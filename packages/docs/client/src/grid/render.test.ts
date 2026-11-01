import { describe, expect, it } from 'vitest';
import { wrapText } from './render.ts';

// One unit of width per character keeps the expectations readable.
const width = (s: string) => s.length;

describe('wrapText', () => {
  it('breaks at spaces to fit the width', () => {
    expect(wrapText('the quick brown fox', 10, width)).toEqual(['the quick', 'brown fox']);
  });

  it('keeps short text and existing line breaks', () => {
    expect(wrapText('short', 10, width)).toEqual(['short']);
    expect(wrapText('a\nb c', 10, width)).toEqual(['a', 'b c']);
  });

  it('splits a word wider than the cell', () => {
    expect(wrapText('abcdefghij xy', 4, width)).toEqual(['abcd', 'efgh', 'ij', 'xy']);
  });
});
