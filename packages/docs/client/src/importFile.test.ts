import { describe, expect, it } from 'vitest';
import { checkImportFile, imageTypeOf, MAX_IMAGE_MB } from './importFile.ts';

const file = (name: string, size = 10) => ({ name, size }) as File;

describe('importing pictures', () => {
  it('takes PNG, JPEG, GIF and WebP files by their name', () => {
    expect(imageTypeOf('Photo.JPG')).toBe('image/jpeg');
    expect(imageTypeOf('a.b.jpeg')).toBe('image/jpeg');
    expect(imageTypeOf('logo.png')).toBe('image/png');
    expect(imageTypeOf('anim.gif')).toBe('image/gif');
    expect(imageTypeOf('pic.webp')).toBe('image/webp');
    expect(imageTypeOf('notes.txt')).toBeNull();
    for (const name of ['Photo.JPG', 'logo.png', 'anim.gif', 'pic.webp']) expect(checkImportFile(file(name))).toBeNull();
  });

  it('refuses a picture that is too large, and takes any other file up to the import limit', () => {
    expect(checkImportFile(file('big.png', MAX_IMAGE_MB * 1024 * 1024 + 1))).toContain('too large');
    // Larger than other imports may be.
    expect(checkImportFile(file('big.png', 30 * 1024 * 1024))).toBeNull();
    // A file the app does not know is kept as it is.
    expect(checkImportFile(file('notes.txt'))).toBeNull();
    expect(checkImportFile(file('archive.zip', 30 * 1024 * 1024))).toContain('too large');
  });
});
