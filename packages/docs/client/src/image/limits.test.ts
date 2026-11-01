import { describe, expect, it } from 'vitest';
import { editedCopyName, editSize, MAX_EDIT_IMAGE_DIM } from './limits.ts';
import { pngName } from './transparency.ts';

describe('image editor limits', () => {
  it('keeps a picture that fits at its own size', () => {
    expect(editSize(4000, 3000)).toEqual({ width: 4000, height: 3000, reduced: false });
    expect(editSize(MAX_EDIT_IMAGE_DIM, 10)).toEqual({ width: MAX_EDIT_IMAGE_DIM, height: 10, reduced: false });
  });

  it('scales a larger picture down by its longest side', () => {
    expect(editSize(16384, 8192)).toEqual({ width: 8192, height: 4096, reduced: true });
    expect(editSize(100, 20000)).toEqual({ width: 41, height: 8192, reduced: true });
  });

  it('names an edited copy after the picture, keeping its type', () => {
    expect(editedCopyName('logo.jpg')).toBe('logo-edited.jpg');
    expect(editedCopyName('team photo.final.PNG')).toBe('team photo.final-edited.PNG');
    expect(editedCopyName('logo-edited.webp')).toBe('logo-edited.webp');
    expect(editedCopyName('scan')).toBe('scan-edited');
    // A copy of another type takes that type's extension.
    expect(editedCopyName('portrait.JPEG', 'image/jpeg')).toBe('portrait-edited.JPEG');
    expect(editedCopyName('portrait.jpg', 'image/png')).toBe('portrait-edited.png');
    expect(editedCopyName('scan', 'image/png')).toBe('scan-edited.png');
    expect(pngName('portrait.JPEG')).toBe('portrait.png');
    expect(pngName('team.photo.jpg')).toBe('team.photo.png');
  });
});
