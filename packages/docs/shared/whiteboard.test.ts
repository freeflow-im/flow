import { describe, expect, it } from 'vitest';
import { boardAsDeck, deckAsBoard, newWhiteboard, snap, validateWhiteboard, whiteboardText, type Whiteboard } from './whiteboard.ts';

const board: Whiteboard = {
  version: 1,
  elements: [
    { id: 'a', type: 'text', anchored: true, x: 8, y: 8, w: 50, h: 24, paragraphs: [{ text: 'First line' }, { text: 'Second' }] },
    { id: 'b', type: 'text', x: 100, y: 100, w: 200, h: 200, fill: '#fff59d', paragraphs: [{ text: 'A note' }] },
    { id: 'c', type: 'shape', shape: 'ellipse', x: 400, y: 100, w: 120, h: 120, text: 'Idea' },
    { id: 'd', type: 'image', src: '/api/images/00000000-0000-4000-8000-000000000000', x: 600, y: 100, w: 200, h: 100 },
  ],
};

describe('whiteboards', () => {
  it('validates what a board holds', () => {
    expect(validateWhiteboard(newWhiteboard())).toBeNull();
    expect(validateWhiteboard(board)).toBeNull();
    expect(validateWhiteboard({ version: 1, elements: [board.elements[0], board.elements[0]] })).toMatch(/duplicate/);
    expect(validateWhiteboard({ version: 1, elements: [{ ...board.elements[1], fill: 42 as unknown as string }] })).toMatch(/fill/);
    expect(validateWhiteboard({ version: 1, elements: [{ id: 'v', type: 'video', src: 'https://www.youtube.com/watch?v=abc', x: 0, y: 0, w: 10, h: 10 }] })).toMatch(/cannot be placed/);
    expect(validateWhiteboard({ version: 1, elements: [{ ...board.elements[2], y: -10 }] })).toMatch(/off the board/);
  });

  it('snaps to the 4-point grid', () => {
    expect([snap(0), snap(1), snap(2), snap(5), snap(-3)]).toEqual([0, 0, 4, 4, -4]);
  });

  it('is edited as a one-slide deck and saved back unchanged', () => {
    const deck = boardAsDeck(board);
    expect(deck.slides).toHaveLength(1);
    expect(deckAsBoard(deck)).toEqual(board);
  });

  it('gives its text for search', () => {
    expect(whiteboardText(board)).toBe('First line\nSecond\nA note\nIdea');
  });
});
