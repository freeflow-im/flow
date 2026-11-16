import { describe, expect, it } from 'vitest';
import { whoIsHere } from './CheckScreen';

describe('the check screen', () => {
  it('says who is already in the meeting', () => {
    expect(whoIsHere([])).toBe('No one is here yet');
    expect(whoIsHere(['Ann'])).toBe('Ann is here');
    expect(whoIsHere(['Ann', 'Ben'])).toBe('Ann and Ben are here');
    expect(whoIsHere(['Ann', 'Ben', 'Cara'])).toBe('Ann and 2 others are here');
  });
});
