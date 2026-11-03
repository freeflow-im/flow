import { describe, expect, it } from 'vitest';
import { reasonText, tabFromParam, tabsOf, writeTabParam } from './tabs';

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

describe('why a message is in its tab', () => {
  it('puts the server’s reasons into words', () => {
    expect(reasonText('Gmail category:updates', 'updates')).toBe('Gmail puts this in Updates');
    expect(reasonText('Gmail category:promotions', 'primary')).toBe('Gmail puts this in Promotions; the Promotions tab is off, so it is in Primary');
    expect(reasonText('Gmail: no category', 'primary')).toBe('Gmail gives this no category, so it is in Primary');
    expect(reasonText('sender moved to primary', 'primary')).toBe('You moved mail from this sender to Primary');
    expect(reasonText('sender moved to social', 'social')).toBe('You moved mail from this sender to Social');
    expect(reasonText('newsletter (List-Id, List-Unsubscribe)', 'promotions')).toBe('Sorted by its headers: newsletter (List-Id, List-Unsubscribe)');
    expect(reasonText(undefined, 'forums')).toBe('No reason recorded for why this is in Forums');
  });
});
