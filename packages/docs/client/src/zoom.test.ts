import { describe, expect, it } from 'vitest';
import { MAX_ZOOM, MIN_ZOOM, stepZoom, wheelZoom } from './zoom.ts';

describe('zoom', () => {
  it('steps to the next level up or down, also from between levels', () => {
    expect(stepZoom(1, 1)).toBe(1.25);
    expect(stepZoom(1, -1)).toBe(0.75);
    expect(stepZoom(1.1, 1)).toBe(1.25);
    expect(stepZoom(1.1, -1)).toBe(1);
  });

  it('stops at the ends', () => {
    expect(stepZoom(MAX_ZOOM, 1)).toBe(MAX_ZOOM);
    expect(stepZoom(MIN_ZOOM, -1)).toBe(MIN_ZOOM);
    expect(wheelZoom(1, -100000)).toBe(MAX_ZOOM);
    expect(wheelZoom(1, 100000)).toBe(MIN_ZOOM);
  });

  it('zooms in when the wheel moves up and out when it moves down', () => {
    expect(wheelZoom(1, -50)).toBeGreaterThan(1);
    expect(wheelZoom(1, 50)).toBeLessThan(1);
    expect(wheelZoom(wheelZoom(1, -50), 50)).toBeCloseTo(1);
  });
});
