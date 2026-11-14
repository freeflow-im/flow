// The line a sign-in that joined a workspace leaves for Home (web lib/openHome.ts): shown once, then gone.
import { beforeEach, describe, expect, it } from 'vitest';
import { HOME_NOTICE_KEY } from '@flow/shared/addresses';
import { takeHomeNotice } from './App';

beforeEach(() => sessionStorage.clear());

describe('takeHomeNotice', () => {
  it('takes the line once', () => {
    sessionStorage.setItem(HOME_NOTICE_KEY, "You've joined Acme.");
    expect(takeHomeNotice()).toBe("You've joined Acme.");
    expect(takeHomeNotice()).toBeNull();
  });
  it('is null with none left', () => expect(takeHomeNotice()).toBeNull());
});
