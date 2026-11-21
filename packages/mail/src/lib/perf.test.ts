import { describe, expect, it } from 'vitest';
import { startAction, toCall } from './perf';

const entry = (over: Partial<PerformanceResourceTiming>) =>
  ({ name: `${window.location.origin}/v1/mail/accounts/a1/messages/7?folder=INBOX`, startTime: 100, requestStart: 0, responseStart: 0, duration: 812.34, serverTiming: [], ...over }) as unknown as PerformanceResourceTiming;

describe('perf', () => {
  it('reads a call’s times and the server’s split, without the query', () => {
    const call = toCall(entry({
      requestStart: 103, responseStart: 900,
      serverTiming: [
        { name: 'total', duration: 790, description: '' },
        { name: 'lock', duration: 600, description: '' },
        { name: 'imap', duration: 150, description: '' },
        { name: 'cache', duration: 0, description: 'live' },
        { name: 'ray', duration: 0, description: '8f1c-SJC' },
      ] as PerformanceServerTiming[],
    }));
    expect(call).toEqual({ path: '/v1/mail/accounts/a1/messages/7', ms: 812.3, queuedMs: 3, waitMs: 797, server: { total: 790, lock: 600, imap: 150 }, cache: 'live', ray: '8f1c-SJC' });
  });

  it('leaves out what the browser did not measure, and a ray that is not one', () => {
    expect(toCall(entry({ serverTiming: [{ name: 'ray', duration: 0, description: 'a"b' }] as PerformanceServerTiming[] }))).toEqual({ path: '/v1/mail/accounts/a1/messages/7', ms: 812.3 });
  });

  it('times nothing where it cannot send (tests, old browsers)', () => {
    const a = startAction('list.folder');
    expect(() => a.end()).not.toThrow();
  });
});
