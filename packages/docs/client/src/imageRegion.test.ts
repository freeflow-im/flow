import { describe, expect, it } from 'vitest';
import { regionBox, regionFromDrag } from './imageRegion.ts';

describe('selecting a region of a picture', () => {
  // A 2000×1000 picture drawn 800×400.
  const drawn = { left: 10, top: 120, width: 800, height: 400 };

  it('turns a drag into picture pixels, whichever way it was dragged', () => {
    const region = { x: 500, y: 250, width: 1000, height: 500, imageWidth: 2000, imageHeight: 1000 };
    expect(regionFromDrag({ x: 210, y: 220 }, { x: 610, y: 420 }, drawn, 2000, 1000)).toEqual(region);
    expect(regionFromDrag({ x: 610, y: 420 }, { x: 210, y: 220 }, drawn, 2000, 1000)).toEqual(region);
    expect(regionBox(region, drawn)).toEqual({ left: 210, top: 220, width: 400, height: 200 });
  });

  it('keeps the region inside the picture', () => {
    expect(regionFromDrag({ x: -50, y: 0 }, { x: 410, y: 2000 }, drawn, 2000, 1000)).toEqual({ x: 0, y: 0, width: 1000, height: 1000, imageWidth: 2000, imageHeight: 1000 });
    // Wholly above the picture.
    expect(regionFromDrag({ x: 100, y: 30 }, { x: 300, y: 90 }, drawn, 2000, 1000)).toBeNull();
  });

  it('takes a click as no selection', () => {
    expect(regionFromDrag({ x: 300, y: 300 }, { x: 302, y: 301 }, drawn, 2000, 1000)).toBeNull();
  });
});
