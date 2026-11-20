import { describe, expect, it } from 'vitest';
import { listMove } from './listKeys';

describe('listMove', () => {
  it('j and k step through the list', () => {
    expect(listMove(3, 1, 1, true)).toEqual({ kind: 'select', index: 2 });
    expect(listMove(3, 1, -1, true)).toEqual({ kind: 'select', index: 0 });
    expect(listMove(3, 1, -1, false)).toEqual({ kind: 'select', index: 0 });
  });

  it('k on the newest open conversation goes back to the list', () => {
    expect(listMove(3, 0, -1, true)).toEqual({ kind: 'close' });
  });

  it('k at the top with nothing open stays on the first row', () => {
    expect(listMove(3, 0, -1, false)).toEqual({ kind: 'select', index: 0 });
  });

  it('j on the oldest stays there', () => {
    expect(listMove(3, 2, 1, true)).toEqual({ kind: 'select', index: 2 });
  });

  it('with no cursor, either key selects the first row', () => {
    expect(listMove(3, -1, 1, false)).toEqual({ kind: 'select', index: 0 });
    expect(listMove(3, -1, -1, true)).toEqual({ kind: 'select', index: 0 });
  });

  it('an empty list does nothing', () => {
    expect(listMove(0, -1, -1, true)).toEqual({ kind: 'none' });
  });
});
