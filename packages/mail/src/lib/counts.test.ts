import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MailFolder, TabCount } from '../api';
import { adjustFolders, adjustTabs, debounced, tabDeltas } from './counts';

const folder = (path: string, unread: number, total: number): MailFolder => ({ path, name: path, delimiter: '/', specialUse: null, unread, total });
const tab = (id: TabCount['id'], unread: number, fresh: number): TabCount => ({ id, unread, new: fresh, latest: null });

describe('the unread counts, kept by the client', () => {
  it('moves folders by their deltas, never below zero', () => {
    const out = adjustFolders([folder('INBOX', 3, 10), folder('Archive', 0, 5)], [{ path: 'INBOX', unread: -2, total: -2 }, { path: 'Archive', unread: 2, total: 2 }, { path: 'INBOX', unread: -5 }]);
    expect(out.map((f) => [f.path, f.unread, f.total])).toEqual([['INBOX', 0, 8], ['Archive', 2, 7]]);
  });

  it('counts only messages whose read state changes, per tab', () => {
    const msgs = [{ uid: 1, seen: false, category: 'promotions' as const }, { uid: 2, seen: true, category: 'promotions' as const }, { uid: 3, seen: false, category: null }];
    expect([...tabDeltas(msgs, true)]).toEqual([['promotions', -1], ['primary', -1]]);
    expect([...tabDeltas(msgs, false)]).toEqual([['promotions', 1]]);
  });

  it('keeps each tab\'s "new" within its unread, and puts a tab not shown in Primary', () => {
    const counts = [tab('primary', 4, 4), tab('promotions', 2, 1)];
    expect(adjustTabs(counts, new Map([['primary', -1], ['social', -1]]))).toEqual([tab('primary', 2, 2), tab('promotions', 2, 1)]);
    expect(adjustTabs(counts, new Map([['promotions', 1]]))[1]).toEqual(tab('promotions', 3, 1));
  });
});

describe('the quiet refresh', () => {
  afterEach(() => vi.useRealTimers());

  it('is one refresh for a burst, a delay after the last change', () => {
    vi.useFakeTimers();
    const run = vi.fn();
    const r = debounced(run, 4000);
    for (let i = 0; i < 5; i++) {
      r.schedule();
      vi.advanceTimersByTime(500);
    }
    expect(run).not.toHaveBeenCalled();
    vi.advanceTimersByTime(4000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('waits while a change is still on its way', () => {
    vi.useFakeTimers();
    const run = vi.fn();
    let busy = true;
    const r = debounced(run, 1000, () => busy);
    r.schedule();
    vi.advanceTimersByTime(3000);
    expect(run).not.toHaveBeenCalled();
    busy = false;
    vi.advanceTimersByTime(1000);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
