import { beforeEach, describe, expect, it } from 'vitest';
import type { TabCount } from '../api';
import { badgeFor, lastOpened, latestLine, markOpened, sinceParam, tabFromParam, tabsOf, writeTabParam } from './tabs';

const count = (id: TabCount['id'], unread: number, fresh: number, latest: TabCount['latest'] = null): TabCount => ({ id, unread, new: fresh, latest });

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

describe('new since the tab was last opened', () => {
  beforeEach(() => localStorage.clear());
  it('remembers when each tab was opened, per account, and builds since=', () => {
    markOpened('acc1', 'promotions', 1000);
    markOpened('acc1', 'social', 2000);
    markOpened('acc2', 'promotions', 3000);
    expect(lastOpened('acc1', 'promotions')).toBe(1000);
    expect(lastOpened('acc1', 'updates')).toBeUndefined();
    expect(sinceParam('acc1', ['primary', 'promotions', 'social', 'updates'])).toBe('promotions:1000,social:2000');
    expect(sinceParam('acc2', ['primary', 'promotions'])).toBe('promotions:3000');
    expect(JSON.parse(localStorage.getItem('mail.tabsOpened')!).acc1.social).toBe(2000);
  });
  it('a tab with new mail shows "N new" unless it is the open one; Primary shows its unread count', () => {
    expect(badgeFor(count('promotions', 7, 3), false)).toEqual({ text: '3 new', kind: 'new' });
    expect(badgeFor(count('promotions', 7, 3), true)).toBeNull();
    expect(badgeFor(count('promotions', 7, 0), false)).toBeNull();
    expect(badgeFor(count('social', 500, 120), false)?.text).toBe('99+ new');
    expect(badgeFor(count('primary', 12, 0), true)).toEqual({ text: '12', kind: 'count' });
    expect(badgeFor(count('primary', 0, 0), false)).toBeNull();
    expect(badgeFor(undefined, false)).toBeNull();
  });
  it('the line under a tab: sender — subject', () => {
    expect(latestLine(count('social', 1, 1, { from: { name: 'LinkedIn', address: 'invitations@linkedin.com' }, subject: 'Priya wants to connect' }))).toBe('LinkedIn — Priya wants to connect');
    expect(latestLine(count('social', 1, 1, { from: { name: '', address: 'a@b.c' }, subject: '' }))).toBe('a@b.c — (no subject)');
    expect(latestLine(count('social', 1, 1, null))).toBeNull();
  });
});
