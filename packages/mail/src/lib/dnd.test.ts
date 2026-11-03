import { describe, expect, it } from 'vitest';
import { dragLabel, dragUids, droppedUids, folderDropTarget, tabDropTarget } from './dnd';

describe('dragging messages onto a tab or a folder', () => {
  const order = [50, 40, 30, 20, 10];
  it('drags the row alone when it is not checked', () => {
    expect(dragUids(30, new Set(), order)).toEqual([30]);
    expect(dragUids(30, new Set([50, 10]), order)).toEqual([30]);
  });
  it('drags every checked row, in list order, when the dragged row is checked', () => {
    expect(dragUids(30, new Set([10, 30, 50]), order)).toEqual([50, 30, 10]);
    // A checked row no longer in the list (it was moved meanwhile) is not carried.
    expect(dragUids(30, new Set([30, 99]), order)).toEqual([30]);
  });
  it('says how many it moves, on the chip', () => {
    expect(dragLabel(1)).toBe('Move 1 message');
    expect(dragLabel(3)).toBe('Move 3 messages');
  });
  it('does nothing when dropped on the tab the messages are in, else moves them there', () => {
    expect(tabDropTarget('promotions', 'promotions')).toBeNull();
    expect(tabDropTarget('promotions', 'primary')).toBe('primary');
    expect(tabDropTarget(null, 'social')).toBeNull();
  });
  it('does nothing when dropped on their own folder, else moves them there', () => {
    expect(folderDropTarget('INBOX', 'INBOX')).toBeNull();
    expect(folderDropTarget('INBOX', 'Archive')).toBe('Archive');
  });
  it('reads the UIDs back from the drag, and nothing from anything else', () => {
    expect(droppedUids(JSON.stringify([50, 30]))).toEqual([50, 30]);
    expect(droppedUids('not json')).toEqual([]);
    expect(droppedUids(JSON.stringify({ uids: [1] }))).toEqual([]);
    expect(droppedUids(JSON.stringify([1, -2, 'x', 3.5]))).toEqual([1]);
  });
});
