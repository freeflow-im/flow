// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { reloadOnStaleBuild } from './staleBuild';

const failedImport = () => {
  const e = new Event('vite:preloadError', { cancelable: true });
  window.dispatchEvent(e);
  return e;
};

afterEach(() => {
  sessionStorage.clear();
  vi.useRealTimers();
});

describe('reloadOnStaleBuild', () => {
  it('loads the page again when a part of the old version is gone, once a minute at most', () => {
    vi.useFakeTimers();
    const reload = vi.fn();
    const stop = reloadOnStaleBuild(reload);
    expect(failedImport().defaultPrevented).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    // Missing from the new version too: the error is left to show.
    expect(failedImport().defaultPrevented).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(61_000);
    failedImport();
    expect(reload).toHaveBeenCalledTimes(2);
    stop();
  });
});
