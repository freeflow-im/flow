import { afterEach, describe, expect, it } from 'vitest';
import { draggedFile, setDraggedFile, takesDrop, type DraggedFile } from './libraryDrag.ts';

const file: DraggedFile = { kind: 'doc', id: 'd1', title: 'Plan', folder: 'Reports', root: 'me' };

describe('libraryDrag', () => {
  afterEach(() => setDraggedFile(null));

  it('remembers the file being dragged until the drag ends', () => {
    expect(draggedFile()).toBeNull();
    setDraggedFile(file);
    expect(draggedFile()).toBe(file);
    setDraggedFile(null);
    expect(draggedFile()).toBeNull();
  });

  it('a folder of the same root takes the file, the folder it is in does not', () => {
    expect(takesDrop(file, 'me', '')).toBe(true);
    expect(takesDrop(file, 'me', 'Reports/2026')).toBe(true);
    expect(takesDrop(file, 'me', 'Finance')).toBe(true);
    expect(takesDrop(file, 'me', 'Reports')).toBe(false);
  });

  it('a folder of the other root does not take it', () => {
    expect(takesDrop(file, 'org', 'Finance')).toBe(false);
    expect(takesDrop({ ...file, root: 'org', folder: '' }, 'org', 'Finance')).toBe(true);
    expect(takesDrop({ ...file, root: 'org', folder: '' }, 'org', '')).toBe(false);
  });

  it('nothing dragged: no folder takes a drop', () => {
    expect(takesDrop(null, 'me', 'Finance')).toBe(false);
  });
});
