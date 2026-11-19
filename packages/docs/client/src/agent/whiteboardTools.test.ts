import { describe, expect, it } from 'vitest';
import { boardAsDeck, deckAsBoard, newWhiteboard, validateWhiteboard } from '../../../shared/whiteboard.ts';
import type { TextElement } from '../../../shared/deck.ts';
import { DeckController } from '../deck/controller.ts';
import { boardParagraphs, boardText, runWhiteboardTool } from './whiteboardTools.ts';

function setup() {
  const board = new DeckController(boardAsDeck(newWhiteboard()), async () => {});
  const call = (name: string, input: Record<string, unknown> = {}) => JSON.parse(runWhiteboardTool({ id: 'x', name, input }, { board, group: 'agent-1' }, false));
  const items = () => deckAsBoard(board.deck).elements;
  return { board, call, items };
}

describe('whiteboard tools', () => {
  it('adds typed text, notes, shapes and lines on the grid, reads them back, and undoes the request as one step', () => {
    const { board, call, items } = setup();
    const r = call('edit_whiteboard', {
      set: [
        { type: 'text', x: 41, y: 43, text: 'Plan for **Q1**\n- ship *it*' },
        { type: 'note', text: 'Remember', fill: '#b3e5fc' },
        { type: 'shape', shape: 'ellipse', x: 600, y: 401, w: 121, h: 79, text: 'Idea' },
        { type: 'line', x1: 10, y1: 10, x2: 103, y2: 50, end_arrow: 'arrow' },
      ],
    });
    expect(r.set).toHaveLength(4);
    expect(validateWhiteboard(deckAsBoard(board.deck))).toBeNull();
    const [text, note, shape] = items() as [TextElement, TextElement, { x: number; y: number; w: number; h: number }];
    expect(text).toMatchObject({ type: 'text', anchored: true, x: 40, y: 44 });
    expect(text.paragraphs[0].runs).toEqual([{ text: 'Plan for ' }, { text: 'Q1', bold: true }]);
    expect(text.paragraphs[1]).toMatchObject({ bullet: true, runs: [{ text: 'ship ' }, { text: 'it', italic: true }] });
    expect(note).toMatchObject({ type: 'text', fill: '#b3e5fc', w: 200, h: 200 });
    expect(note.anchored).toBeUndefined();
    expect(shape).toMatchObject({ x: 600, y: 400, w: 120, h: 80 });
    for (const e of items()) expect([e.x % 4, e.y % 4]).toEqual([0, 0]);

    const read = call('read_whiteboard');
    expect(read.board).toEqual({ width: 5760, height: 3600, grid: 4 });
    expect(read.items.map((i: { type: string }) => i.type)).toEqual(['text', 'note', 'shape', 'line']);
    expect(read.items[0].text).toBe('Plan for **Q1**\n- ship *it*');
    expect(read.items[1]).toMatchObject({ type: 'note', text: 'Remember', fill: '#b3e5fc' });

    board.undo();
    expect(items()).toHaveLength(0);
  });

  it('changes and removes items by id, keeps their kind, and refuses unknown ids', () => {
    const { call, items } = setup();
    const { set } = call('edit_whiteboard', { set: [{ type: 'shape', shape: 'rect', x: 100, y: 100, fill: '#4285f4' }, { type: 'note', x: 400, y: 100, text: 'x' }] });
    call('edit_whiteboard', { set: [{ id: set[0].id, fill: 'red' }, { id: set[1].id, text: 'y', fill: '#f8bbd0' }] });
    expect(items()[0]).toMatchObject({ type: 'shape', fill: 'red', x: 100 });
    expect(items()[1]).toMatchObject({ fill: '#f8bbd0', paragraphs: [{ text: 'y' }] });
    expect(() => call('edit_whiteboard', { set: [{ id: set[1].id, type: 'shape' }] })).toThrow(/its type cannot change/);
    expect(() => call('edit_whiteboard', { remove: ['nope'] })).toThrow(/no item "nope"/);
    call('edit_whiteboard', { remove: [set[0].id] });
    expect(items().map((e) => e.id)).toEqual([set[1].id]);
  });

  it('places items without a position below what is there, one after another', () => {
    const { call, items } = setup();
    call('edit_whiteboard', { set: [{ type: 'shape', shape: 'rect', x: 80, y: 80, w: 200, h: 200 }] });
    call('edit_whiteboard', { set: [{ type: 'note', text: 'a' }, { type: 'note', text: 'b' }] });
    const [, a, b] = items();
    expect(a.y).toBeGreaterThan(280);
    expect(b.y).toBe(a.y);
    expect(b.x).toBeGreaterThan(a.x + a.w);
  });

  it('writes text with styles back as it reads it', () => {
    const text = '**Bold** and *italic* with [a link](https://example.com)\n- a bullet';
    expect(boardText(boardParagraphs(text))).toBe(text);
  });
});
