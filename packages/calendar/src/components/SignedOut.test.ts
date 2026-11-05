import { describe, expect, it } from 'vitest';
import { afterSignIn } from './SignedOut';

describe('afterSignIn', () => {
  it('goes on to next when it is a path on this origin', () => {
    expect(afterSignIn('?next=%2Fcalendar%2Fweek%2F2026-11-09')).toBe('/calendar/week/2026-11-09');
  });
  it('ignores a next that would leave the origin, or none', () => {
    expect(afterSignIn('?next=https%3A%2F%2Fevil.example%2F')).toBe('/calendar/');
    expect(afterSignIn('?next=%2F%2Fevil.example')).toBe('/calendar/');
    expect(afterSignIn('')).toBe('/calendar/');
  });
});
