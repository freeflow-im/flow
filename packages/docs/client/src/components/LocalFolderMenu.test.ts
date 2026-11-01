import { describe, expect, it } from 'vitest';
import { parentDir } from './LocalFolderMenu.tsx';

describe('parentDir', () => {
  it('is the directory a directory is in, keeping the top of the disk', () => {
    expect(['/Users/scottp/src/sheetsweb', '/a/b/', '/Users', '/', 'C:\\Users\\me', 'C:\\Users'].map(parentDir)).toEqual(['/Users/scottp/src', '/a', '/', null, 'C:\\Users', 'C:\\']);
  });
});
