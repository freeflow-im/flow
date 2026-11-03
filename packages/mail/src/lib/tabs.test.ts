import { describe, expect, it } from 'vitest';
import { tabFromParam, tabsOf, writeTabParam } from './tabs';

describe('which tabs an account shows', () => {
  it('none with tabs off, else Primary and the enabled ones in the bar order', () => {
    expect(tabsOf({ tabs: [] })).toEqual([]);
    expect(tabsOf(null)).toEqual([]);
    expect(tabsOf({ tabs: ['forums', 'promotions'] })).toEqual(['primary', 'promotions', 'forums']);
  });
});

describe('the tab in the address', () => {
  const tabs = tabsOf({ tabs: ['promotions', 'social'] });
  it('reads a shown tab, and falls back to Primary', () => {
    expect(tabFromParam('promotions', tabs)).toBe('promotions');
    expect(tabFromParam('forums', tabs)).toBe('primary');
    expect(tabFromParam(null, tabs)).toBe('primary');
    expect(tabFromParam('promotions', [])).toBe('primary');
  });
  it('writes &tab= except for Primary', () => {
    const p = new URLSearchParams('account=a&folder=INBOX');
    writeTabParam(p, 'social');
    expect(p.toString()).toBe('account=a&folder=INBOX&tab=social');
    writeTabParam(p, 'primary');
    expect(p.toString()).toBe('account=a&folder=INBOX');
    writeTabParam(p, null);
    expect(p.has('tab')).toBe(false);
  });
});
