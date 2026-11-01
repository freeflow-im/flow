import { describe, expect, it } from 'vitest';
import type { SlideElement } from './deck.ts';
import { clickTarget, elementsInBox, frameUnderPointer, isHollow, onOutline } from './deckHit.ts';

const picture: SlideElement = { id: 'pic', type: 'image', src: '/api/images/x', x: 100, y: 100, w: 400, h: 300 };
const frame: SlideElement = { id: 'frame', type: 'shape', shape: 'rect', fill: 'none', stroke: '#c4c7cc', x: 100, y: 100, w: 400, h: 300 };
const REACH = 8;
const id = (els: SlideElement[], hit: SlideElement | null, x: number, y: number) => clickTarget(els, hit, x, y, REACH)?.id ?? null;

describe('a click around a hollow shape', () => {
  it('knows an outline from a filled or labelled shape', () => {
    expect(isHollow(frame)).toBe(true);
    expect(isHollow({ ...frame, fill: '#ffffff' } as SlideElement)).toBe(false);
    expect(isHollow({ ...frame, fill: undefined } as SlideElement)).toBe(false);
    expect(isHollow({ ...frame, text: 'Label' } as SlideElement)).toBe(false);
    expect(isHollow({ ...frame, shape: 'line' } as SlideElement)).toBe(false);
    expect(isHollow(picture)).toBe(false);
  });

  it('has a band on both sides of the line, however thin the line is', () => {
    // Inside: the reach beyond the line's 2 points. Outside: the reach from the box.
    expect(onOutline(frame, 109, 250, REACH)).toBe(true);
    expect(onOutline(frame, 111, 250, REACH)).toBe(false);
    expect(onOutline(frame, 93, 250, REACH)).toBe(true);
    expect(onOutline(frame, 91, 250, REACH)).toBe(false);
    // Off a corner, by the distance to the corner.
    expect(onOutline(frame, 95, 95, REACH)).toBe(true);
    expect(onOutline(frame, 93, 93, REACH)).toBe(false);
    // A thick line is the frame as far in as it is drawn.
    expect(onOutline({ ...frame, strokeWidth: 20 } as SlideElement, 125, 250, REACH)).toBe(true);
    expect(onOutline(picture, 100, 250, REACH)).toBe(false);
  });

  it('goes to the picture under a frame, and to the frame on its line', () => {
    const els = [picture, frame];
    expect(id(els, frame, 300, 250)).toBe('pic');
    expect(id(els, frame, 103, 250)).toBe('frame');
    expect(id(els, frame, 300, 396)).toBe('frame');
  });

  it('takes a click just outside the line too: on the bare slide, or on something the frame is drawn over', () => {
    expect(id([picture, frame], null, 95, 250)).toBe('frame');
    expect(id([picture, frame], null, 80, 250)).toBeNull();
    // A neighbour under the frame's band gives way to the frame; one drawn over the frame does not.
    const neighbour = { ...picture, id: 'next', x: 0, y: 100, w: 98, h: 300 } as SlideElement;
    expect(id([neighbour, picture, frame], neighbour, 95, 250)).toBe('frame');
    expect(id([picture, frame, neighbour], neighbour, 95, 250)).toBe('next');
    expect(id([neighbour, picture, frame], neighbour, 50, 250)).toBe('next');
  });

  it('stays the shape when nothing is under it there, or it is not hollow', () => {
    expect(id([frame], frame, 300, 250)).toBe('frame');
    const small = { ...picture, w: 50, h: 50 } as SlideElement;
    expect(id([small, frame], frame, 300, 250)).toBe('frame');
    expect(id([small, frame], frame, 120, 120)).toBe('pic');
    const filled = { ...frame, fill: '#ffffff' } as SlideElement;
    expect(id([picture, filled], filled, 300, 250)).toBe('frame');
    // Only what is under the shape, not what is drawn over it.
    expect(id([frame, picture], picture, 300, 250)).toBe('pic');
  });

  it('goes through frames stacked on one another, to the first thing that is not one', () => {
    const outer = { ...frame, id: 'outer', x: 50, y: 50, w: 500, h: 400 } as SlideElement;
    expect(id([picture, frame, outer], outer, 300, 250)).toBe('pic');
    expect(id([frame, outer], outer, 300, 250)).toBe('frame');
    expect(id([picture, frame, outer], outer, 52, 250)).toBe('outer');
    // The inner frame's line, reached through the outer one's middle.
    expect(id([picture, frame, outer], outer, 103, 250)).toBe('frame');
  });

  it('measures an ellipse from its curve and a turned shape in its own frame', () => {
    const ring = { ...frame, id: 'ring', shape: 'ellipse' } as SlideElement;
    expect(id([picture, ring], ring, 300, 250)).toBe('pic');
    expect(id([picture, ring], ring, 300, 102)).toBe('ring');
    // The box's corner is far outside the curve.
    expect(onOutline(ring, 104, 104, REACH)).toBe(false);
    const turned = { ...frame, id: 'turned', x: 200, y: 0, w: 200, h: 600, rot: 90 } as SlideElement;
    const under = { ...picture, x: 0, y: 200, w: 600, h: 200 } as SlideElement;
    // Turned a quarter, the tall box lies wide: its line is along y = 200 and y = 400.
    expect(id([under, turned], turned, 300, 300)).toBe('pic');
    expect(id([under, turned], turned, 300, 202)).toBe('turned');
    expect(id([under, turned], null, 300, 195)).toBe('turned');
  });

  it('tells the pointer when a click would take a frame by its line', () => {
    const els = [picture, frame];
    expect(frameUnderPointer(els, frame, 104, 250, REACH)?.id).toBe('frame');
    expect(frameUnderPointer(els, null, 95, 250, REACH)?.id).toBe('frame');
    expect(frameUnderPointer(els, frame, 300, 250, REACH)).toBeNull();
    expect(frameUnderPointer(els, null, 50, 250, REACH)).toBeNull();
    // A frame over nothing is taken by a click anywhere in it, but the cue is for its line.
    expect(frameUnderPointer([frame], frame, 300, 250, REACH)).toBeNull();
  });
});

describe('a selection box', () => {
  const box: SlideElement = { id: 'box', type: 'shape', shape: 'rect', fill: '#ffffff', x: 100, y: 100, w: 100, h: 50 };
  const text: SlideElement = { id: 'text', type: 'text', x: 300, y: 100, w: 200, h: 40, paragraphs: [{ text: 'Hi' }] };
  const line: SlideElement = { id: 'line', type: 'line', kind: 'straight', x: 100, y: 300, w: 200, h: 200 };
  const ids = (els: SlideElement[], ax: number, ay: number, bx: number, by: number) => elementsInBox(els, ax, ay, bx, by).map((e) => e.id);

  it('takes everything it touches, drawn in any direction', () => {
    const els = [box, text, line];
    expect(ids(els, 50, 50, 600, 600)).toEqual(['box', 'text', 'line']);
    // Through a corner of the box only, and the same box drawn from the other corner.
    expect(ids(els, 190, 140, 250, 200)).toEqual(['box']);
    expect(ids(els, 250, 200, 190, 140)).toEqual(['box']);
    expect(ids(els, 190, 90, 310, 110)).toEqual(['box', 'text']);
    expect(ids(els, 210, 160, 290, 290)).toEqual([]);
  });

  it('takes a straight line only where the box crosses it', () => {
    // Inside the line's bounding box but off the line (which runs corner to corner).
    expect(ids([line], 250, 320, 290, 360)).toEqual([]);
    expect(ids([line], 190, 390, 210, 410)).toEqual(['line']);
    // A line drawn the other way runs from the top right to the bottom left.
    const flipped = { ...line, flipH: true } as SlideElement;
    expect(ids([flipped], 250, 320, 290, 360)).toEqual(['line']);
    expect(ids([flipped], 110, 310, 140, 340)).toEqual([]);
    // An elbow goes by its bounding box.
    expect(ids([{ ...line, kind: 'elbow' } as SlideElement], 250, 320, 290, 360)).toEqual(['line']);
  });

  it('leaves a frame alone when it is drawn in its open middle, and takes it at its line', () => {
    const inside: SlideElement = { ...box, id: 'inside', x: 200, y: 200, w: 50, h: 50 };
    expect(ids([frame, inside], 180, 180, 300, 300)).toEqual(['inside']);
    expect(ids([frame, inside], 90, 180, 300, 300)).toEqual(['frame', 'inside']);
    expect(ids([frame, inside], 50, 50, 600, 600)).toEqual(['frame', 'inside']);
    // A filled shape has no open middle.
    expect(ids([{ ...frame, fill: '#ffffff' } as SlideElement], 180, 180, 300, 300)).toEqual(['frame']);
  });

  it('takes a turned element by the box that holds it as turned', () => {
    const turned = { ...box, x: 100, y: 100, w: 200, h: 20, rot: 90 } as SlideElement;
    // Turned a quarter, it stands from (190, 10) to (210, 210).
    expect(ids([turned], 195, 20, 205, 40)).toEqual(['box']);
    expect(ids([turned], 110, 105, 150, 115)).toEqual([]);
  });
});
