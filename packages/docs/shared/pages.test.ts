import { describe, expect, it } from 'vitest';
import { filePath } from './pages.ts';

describe('filePath', () => {
  it('opens each kind in its own page', () => {
    expect(filePath('whiteboard', 'b1')).toBe('/w/b1');
    expect(filePath('sheet', 's1')).toBe('/s/s1');
    expect(filePath('markdown', 'm1')).toBe('/md/m1');
    expect(filePath('file', 'f 1')).toBe('/f/f%201');
  });
});
