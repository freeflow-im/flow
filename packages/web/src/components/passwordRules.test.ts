// The new-account password rules (docs/specs/onboarding.md §1), as the Set your password step shows them.
import { describe, expect, it } from 'vitest';
import { passwordRules } from './AuthScreen';

const met = (pw: string, email = 'quinn@example.com') => passwordRules(pw, email).map((r) => r.ok);

describe('password rules', () => {
  it('needs 12 characters, a number or symbol, and not the email', () => {
    expect(met('')).toEqual([false, false, false]);
    expect(met('shortpw1')).toEqual([false, true, true]);
    expect(met('onlylettersherex')).toEqual([true, false, true]);
    expect(met('quinn-is-my-name-9')).toEqual([true, true, false]);
    expect(met('a-good-long-one-9')).toEqual([true, true, true]);
  });
});
