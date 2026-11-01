import { describe, expect, it } from 'vitest';
import { validateDeck, type Deck, type LineElement, type ShapeElement } from './deck.ts';
import { boxFromEnds, cloneElements, lineEnds, lineFromShape, lineGeometry, migrateDeck, nearSites, reconnectLines, snapAngle } from './lines.ts';

const box = (id: string, x: number, y: number, w = 100, h = 50): ShapeElement => ({ id, type: 'shape', shape: 'rect', x, y, w, h });

describe('line geometry', () => {
  it('stores any direction as a box with flips and reads the ends back', () => {
    for (const [x1, y1, x2, y2] of [
      [10, 20, 110, 70],
      [110, 20, 10, 70],
      [10, 70, 110, 20],
      [110, 70, 10, 20],
      [10, 20, 10, 90],
    ]) {
      expect(lineEnds({ ...boxFromEnds(x1, y1, x2, y2) })).toEqual({ x1, y1, x2, y2 });
    }
  });

  it('snaps to 15 degree angles', () => {
    const [x, y] = snapAngle(0, 0, 100, 3);
    expect(Math.round(x)).toBe(100);
    expect(Math.round(y)).toBe(0);
    const [dx, dy] = snapAngle(0, 0, 100, 52);
    expect(Math.round(Math.atan2(dy, dx) * (180 / Math.PI))).toBe(30);
  });

  it('routes an elbow out of the bottom of one shape and into the top of another, with an arrowhead', () => {
    const g = lineGeometry({ kind: 'elbow', ...boxFromEnds(200, 110, 500, 250), startConnection: { elementId: 'a', site: 'bottom' }, endConnection: { elementId: 'b', site: 'top' }, endArrow: 'triangle' });
    // Down, across, down; the stroke stops short of the arrow tip at (500, 250).
    expect(g.d).toMatch(/^M 200 110 L 200 180 L 500 180 L 500 2\d\d/);
    expect(g.heads).toHaveLength(1);
    expect(g.heads[0].points!.startsWith('500,250 ')).toBe(true);
    expect(g.bendAxis).toBe('y');
    expect(g.mid).toEqual({ x: 350, y: 180 });
  });

  it('draws every arrowhead style, a curve and a straight line', () => {
    for (const style of ['arrow', 'open', 'triangle', 'circle', 'diamond'] as const) {
      const g = lineGeometry({ kind: 'straight', ...boxFromEnds(0, 0, 100, 0), startArrow: style, endArrow: style });
      expect(g.heads).toHaveLength(2);
    }
    expect(lineGeometry({ kind: 'straight', ...boxFromEnds(0, 0, 100, 0) }).d).toBe('M 0 0 L 100 0');
    expect(lineGeometry({ kind: 'curved', ...boxFromEnds(0, 0, 100, 80) }).d).toMatch(/^M 0 0 C /);
  });
});

describe('connections', () => {
  const line = (over: Partial<LineElement> = {}): LineElement => ({ id: 'l', type: 'line', kind: 'elbow', ...boxFromEnds(0, 0, 10, 10), ...over });

  it('moves connected ends with their shapes and drops connections to removed shapes', () => {
    const slide = { id: 's', elements: [box('a', 100, 50), box('b', 400, 250), line({ startConnection: { elementId: 'a', site: 'bottom' }, endConnection: { elementId: 'b', site: 'top' } })] };
    const first = reconnectLines(slide);
    expect(lineEnds(first.elements[2] as LineElement)).toEqual({ x1: 150, y1: 100, x2: 450, y2: 250 });
    expect(reconnectLines(first)).toBe(first);

    const moved = reconnectLines({ ...first, elements: first.elements.map((e) => (e.id === 'b' ? { ...e, x: 0, y: 300, w: 200 } : e)) });
    expect(lineEnds(moved.elements[2] as LineElement)).toEqual({ x1: 150, y1: 100, x2: 100, y2: 300 });

    const removed = reconnectLines({ ...moved, elements: moved.elements.filter((e) => e.id !== 'a') });
    expect(removed.elements[1]).not.toHaveProperty('startConnection');
    expect(removed.elements[1]).toHaveProperty('endConnection');
  });

  it('finds the connection point near a pointer, and ignores lines', () => {
    const els = [box('a', 100, 100), line()];
    expect(nearSites(els, 150, 98, 14, 28).snap).toMatchObject({ elementId: 'a', site: 'top', x: 150, y: 100 });
    expect(nearSites(els, 130, 125, 14, 28).snap).toBeUndefined();
    expect(nearSites(els, 130, 125, 14, 28).near).toHaveLength(1);
    expect(nearSites(els, 500, 500, 14, 28).near).toHaveLength(0);
  });

  it('keeps connections between copies and drops them to elements that were not copied', () => {
    let n = 0;
    const els = [box('a', 0, 0), line({ id: 'l1', startConnection: { elementId: 'a', site: 'left' }, endConnection: { elementId: 'z', site: 'top' } })];
    const copies = cloneElements(els, () => `n${++n}`, 20, 20);
    expect(copies[1]).toMatchObject({ x: 20, y: 20, startConnection: { elementId: 'n1', site: 'left' } });
    expect(copies[1]).not.toHaveProperty('endConnection');
  });
});

describe('migration', () => {
  const shapeLine = (over: Partial<ShapeElement>): ShapeElement => ({ id: 'x', type: 'shape', shape: 'line', x: 10, y: 20, w: 300, h: 0, ...over });

  it('turns horizontal, vertical and diagonal line shapes into lines that look the same', () => {
    expect(lineFromShape(shapeLine({ stroke: '#f00', strokeWidth: 5, arrow: 'end' }))).toEqual({ id: 'x', type: 'line', kind: 'straight', x: 10, y: 20, w: 300, h: 0, strokeColor: '#f00', strokeWidth: 5, endArrow: 'triangle' });
    expect(lineFromShape(shapeLine({ w: 0, h: 80, arrow: 'start' }))).toMatchObject({ w: 0, h: 80, startArrow: 'triangle', strokeWidth: 3 });
    const diagonal = lineFromShape(shapeLine({ w: 100, h: 60, flip: true, arrow: 'both' }));
    expect(lineEnds(diagonal)).toEqual({ x1: 10, y1: 80, x2: 110, y2: 20 }); // bottom-left to top-right
    expect(lineEnds(lineFromShape(shapeLine({ w: 100, h: 60 })))).toEqual({ x1: 10, y1: 20, x2: 110, y2: 80 });
  });

  it('migrates a deck and the result validates', () => {
    const deck: Deck = { version: 1, theme: 'light', slides: [{ id: 's', elements: [box('a', 0, 0), shapeLine({})] }] };
    const migrated = migrateDeck(deck);
    expect(migrated.slides[0].elements[1].type).toBe('line');
    expect(validateDeck(migrated)).toBeNull();
    expect(migrateDeck(migrated)).toBe(migrated);
  });

  it('validates line elements', () => {
    const deck = (el: unknown) => ({ version: 1, theme: 'light', slides: [{ id: 's', elements: [el] }] });
    const ok = { id: 'l', type: 'line', kind: 'curved', x: 0, y: 0, w: 5, h: 5, dash: 'dot', startArrow: 'open', endConnection: { elementId: 'a', site: 'left' } };
    expect(validateDeck(deck(ok))).toBeNull();
    expect(validateDeck(deck({ ...ok, kind: 'zigzag' }))).toMatch(/line kind/);
    expect(validateDeck(deck({ ...ok, endArrow: 'spear' }))).toMatch(/arrowhead/);
    expect(validateDeck(deck({ ...ok, endConnection: { elementId: 'a', site: 'middle' } }))).toMatch(/connection/);
  });
});
