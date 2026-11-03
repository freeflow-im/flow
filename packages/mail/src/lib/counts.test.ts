import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MailFolder } from '../api';
import { adjustFolders, debounced } from './counts';

const folder = (path: string, unread: number, total: number): MailFolder => ({ path, name: path, delimiter: '/', specialUse: null, unread, total });

describe("the folders' unread counts, kept by the client", () => {
  it('moves folders by their deltas, never below zero', () => {
    const out = adjustFolders([folder('INBOX', 3, 10), folder('Archive', 0, 5)], [{ path: 'INBOX', unread: -2, total: -2 }, { path: 'Archive', unread: 2, total: 2 }, { path: 'INBOX', unread: -5 }]);
    expect(out.map((f) => [f.path, f.unread, f.total])).toEqual([['INBOX', 0, 8], ['Archive', 2, 7]]);
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
