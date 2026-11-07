import { describe, expect, it } from 'vitest';
import { localPart, organizationDomain, uniqueAddress } from './addresses';

describe('localPart', () => {
  it('lower-cases and joins words with a dot', () => {
    expect(localPart('Ann Smith')).toBe('ann.smith');
    expect(localPart('  Bob   the  Builder ')).toBe('bob.the.builder');
  });
  it('folds accents to ASCII', () => {
    expect(localPart('José Müller')).toBe('jose.muller');
    expect(localPart('Zoë Ångström')).toBe('zoe.angstrom');
  });
  it('keeps digits and dots, drops the rest, and trims dots', () => {
    expect(localPart('R2-D2')).toBe('r2.d2');
    expect(localPart('a..b')).toBe('a.b');
    expect(localPart('.dot.')).toBe('dot');
    expect(localPart("Ann O'Brien")).toBe('ann.obrien');
    expect(localPart('flow_bot')).toBe('flow.bot');
  });
  it('falls back to user when nothing is left', () => {
    expect(localPart('')).toBe('user');
    expect(localPart('山田 太郎')).toBe('user');
    expect(localPart('...')).toBe('user');
  });
});

describe('uniqueAddress', () => {
  it('appends 2, 3, … on a collision', () => {
    const taken = new Set(['ann@acme.freeflow.im', 'ann2@acme.freeflow.im']);
    expect(uniqueAddress('bob', 'acme.freeflow.im', (a) => taken.has(a))).toBe('bob@acme.freeflow.im');
    expect(uniqueAddress('ann', 'acme.freeflow.im', (a) => taken.has(a))).toBe('ann3@acme.freeflow.im');
  });
  it('names the platform domain of a slug', () => {
    expect(organizationDomain('Locked-In')).toBe('locked-in.freeflow.im');
  });
});
