import { describe, expect, it } from 'vitest';
import { imageSrc } from './imagePaths.ts';

const at = (folder: string, name: string) => `/api/files/at?${new URLSearchParams({ folder, name })}`;

describe('imageSrc', () => {
  it('reads a relative path from the document’s folder', () => {
    expect(imageSrc('docs/images/editor.png', '')).toBe(at('docs/images', 'editor.png'));
    expect(imageSrc('./shot.png', 'Reports')).toBe(at('Reports', 'shot.png'));
    expect(imageSrc('../art/my%20logo.png?raw=1', 'Reports/2026')).toBe(at('Reports/art', 'my logo.png'));
  });

  it('leaves addresses and paths out of the top folder alone', () => {
    for (const src of ['https://example.com/a.png', '/api/images/abc', 'data:image/png;base64,AA', '#x', '../up.png', '', undefined]) expect(imageSrc(src, '')).toBe(src);
  });
});
