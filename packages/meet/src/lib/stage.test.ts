import { describe, expect, it } from 'vitest';
import { keepPin, stageLayout } from './stage';

const person = (id: string) => ({ kind: 'person' as const, id });
const screen = (id: string) => ({ kind: 'screen' as const, id });

describe('stageLayout', () => {
  it('is an even grid with nothing pinned or shared', () => {
    expect(stageLayout(['me', 'a', 'b'], null, null)).toEqual({ kind: 'grid', people: ['me', 'a', 'b'] });
  });

  it('puts a pinned person on the stage and everyone else in the strip', () => {
    expect(stageLayout(['me', 'a', 'b'], null, person('a'))).toEqual({ kind: 'focus', main: person('a'), strip: [person('me'), person('b')] });
  });

  it('shows a shared screen on the stage when nothing is pinned', () => {
    expect(stageLayout(['me', 'a'], 'a', null)).toEqual({ kind: 'focus', main: screen('a'), strip: [person('me'), person('a')] });
  });

  it('lets a pinned person take the stage from a shared screen, which moves to the strip', () => {
    expect(stageLayout(['me', 'a', 'b'], 'a', person('b'))).toEqual({ kind: 'focus', main: person('b'), strip: [screen('a'), person('me'), person('a')] });
  });

  it('goes back to the grid when the pinned person is gone', () => {
    expect(stageLayout(['me', 'b'], null, person('a'))).toEqual({ kind: 'grid', people: ['me', 'b'] });
  });

  it('ignores a pinned screen that is no longer shared', () => {
    expect(stageLayout(['me', 'a'], null, screen('a'))).toEqual({ kind: 'grid', people: ['me', 'a'] });
    expect(stageLayout(['me', 'a', 'b'], 'b', screen('a'))).toMatchObject({ main: screen('b') });
  });
});

describe('keepPin', () => {
  const none = new Map<string, string>();

  it('keeps a pin on someone still here', () => {
    const pin = person('a');
    expect(keepPin(pin, ['me', 'a'], null, none)).toBe(pin);
  });

  it('drops a pin on someone who left, or on a screen no longer shared', () => {
    expect(keepPin(person('a'), ['me'], null, none)).toBeNull();
    expect(keepPin(screen('a'), ['me', 'a'], null, none)).toBeNull();
    expect(keepPin(screen('a'), ['me', 'a'], 'a', none)).toEqual(screen('a'));
  });

  it('follows a person to their new connection when they rejoin', () => {
    expect(keepPin(person('old'), ['me', 'new'], null, new Map([['old', 'new']]))).toEqual(person('new'));
  });
});
