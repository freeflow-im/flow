import { describe, expect, it } from 'vitest';
import type { ImageElement } from './deck.ts';
import { clampToPicture, cropTo, dragHandle, moveFrame, pictureRect, startFrame, toElementFrame } from './deckCrop.ts';

const image = (over: Partial<ImageElement> = {}): ImageElement => ({ id: 'p', type: 'image', src: '/api/images/x', x: 100, y: 100, w: 400, h: 300, ...over });
const close = (a: object, b: object) => {
  for (const [k, v] of Object.entries(b)) expect((a as Record<string, number>)[k], k).toBeCloseTo(v as number, 2);
};

describe('cropping a picture on a slide', () => {
  it('finds the whole picture: fitted in the box, covering it, or around a crop', () => {
    // A 4:3 box holding a 2:1 picture whole: bands above and below.
    expect(pictureRect(image(), { w: 2000, h: 1000 })).toEqual({ x: 100, y: 150, w: 400, h: 200 });
    // Covering the box: the picture runs past its sides.
    expect(pictureRect(image({ fit: 'cover' }), { w: 2000, h: 1000 })).toEqual({ x: 0, y: 100, w: 600, h: 300 });
    // Cropped: the box is the half kept, so the picture is twice as wide, a quarter of it to the left.
    close(pictureRect(image({ crop: { l: 0.25, t: 0, r: 0.25, b: 0 } }), { w: 0, h: 0 }), { x: -100, y: 100, w: 800, h: 300 });
    // Nothing known of the picture: it is taken to fill the box.
    expect(pictureRect(image(), { w: 0, h: 0 })).toEqual({ x: 100, y: 100, w: 400, h: 300 });
  });

  it('starts from what the element shows now', () => {
    const letterboxed = pictureRect(image(), { w: 2000, h: 1000 });
    expect(startFrame(image(), letterboxed)).toEqual(letterboxed);
    const covering = pictureRect(image({ fit: 'cover' }), { w: 2000, h: 1000 });
    expect(startFrame(image({ fit: 'cover' }), covering)).toEqual({ x: 100, y: 100, w: 400, h: 300 });
  });

  it('drags handles and the frame, never past the picture or smaller than a crop can be', () => {
    const picture = { x: 0, y: 0, w: 800, h: 600 };
    const start = { x: 100, y: 100, w: 400, h: 300 };
    expect(dragHandle(start, 'e', -150, 999, picture)).toEqual({ x: 100, y: 100, w: 250, h: 300 });
    expect(dragHandle(start, 'nw', 50, 40, picture)).toEqual({ x: 150, y: 140, w: 350, h: 260 });
    expect(dragHandle(start, 'se', 9999, 9999, picture)).toEqual({ x: 100, y: 100, w: 700, h: 500 });
    expect(dragHandle(start, 'w', -9999, 0, picture)).toEqual({ x: 0, y: 100, w: 500, h: 300 });
    expect(dragHandle(start, 'e', -9999, 0, picture)).toEqual({ x: 100, y: 100, w: 12, h: 300 });
    expect(dragHandle(start, 'n', 0, 9999, picture)).toEqual({ x: 100, y: 388, w: 400, h: 12 });
    expect(moveFrame(start, 9999, -9999, picture)).toEqual({ x: 400, y: 0, w: 400, h: 300 });
    expect(clampToPicture({ x: -50, y: 700, w: 2000, h: 1 }, picture)).toEqual({ x: 0, y: 588, w: 800, h: 12 });
  });

  it('crops to a frame, leaving the picture where and as large as it was', () => {
    const el = image({ w: 400, h: 200, y: 150, clip: 'circle(50%)' });
    const picture = pictureRect(el, { w: 2000, h: 1000 });
    const cropped = cropTo(el, picture, { x: 200, y: 150, w: 200, h: 100 });
    expect(cropped).toEqual({ ...el, x: 200, y: 150, w: 200, h: 100, crop: { l: 0.25, t: 0, r: 0.25, b: 0.5 } });
    // Cropping again starts from the same whole picture, and the whole picture again is no crop at all.
    close(pictureRect(cropped, { w: 0, h: 0 }), picture);
    const whole = cropTo(cropped, pictureRect(cropped, { w: 0, h: 0 }), picture);
    expect(whole).toEqual(el);
    expect('crop' in whole).toBe(false);
  });

  it('keeps a rotated picture in place: the box goes where the frame is after the turn', () => {
    const el = image({ x: 0, y: 0, w: 400, h: 200, rot: 90 });
    const picture = pictureRect(el, { w: 400, h: 200 });
    // Keep the right half. In the element's frame its centre is 100 to the right of the box's; turned a quarter
    // clockwise, that is 100 below it.
    const cropped = cropTo(el, picture, { x: 200, y: 0, w: 200, h: 200 });
    expect(cropped).toMatchObject({ x: 100, y: 100, w: 200, h: 200, rot: 90, crop: { l: 0.5, t: 0, r: 0, b: 0 } });
    // A pointer on the slide is read in the element's frame: the point below the centre is to its right there.
    close({ x: toElementFrame(el, 200, 200)[0], y: toElementFrame(el, 200, 200)[1] }, { x: 300, y: 100 });
    expect(toElementFrame(image(), 5, 7)).toEqual([5, 7]);
  });
});
