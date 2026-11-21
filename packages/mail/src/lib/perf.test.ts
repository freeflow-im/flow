import { describe, expect, it } from 'vitest';
import { startAction, toCall } from './perf';

const entry = (over: Partial<PerformanceResourceTiming>) =>
  ({ name: `${window.location.origin}/v1/mail/accounts/a1/messages/7?folder=INBOX`, startTime: 100, requestStart: 0, responseStart: 0, duration: 812.34, serverTiming: [], encodedBodySize: 0, transferSize: 300, ...over }) as unknown as PerformanceResourceTiming;

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
        { name: 'read', duration: 0, description: 'whole' },
        { name: 'bytes', duration: 0, description: '9999' },
      ] as PerformanceServerTiming[],
      encodedBodySize: 5000,
    }));
    expect(call).toEqual({ path: '/v1/mail/accounts/a1/messages/7', ms: 812.3, queuedMs: 3, waitMs: 797, server: { total: 790, lock: 600, imap: 150 }, cache: 'live', ray: '8f1c-SJC', read: 'whole', bytes: 5000 });
  });

  it('leaves out what the browser did not measure, and a ray that is not one', () => {
    expect(toCall(entry({ serverTiming: [{ name: 'ray', duration: 0, description: 'a"b' }] as PerformanceServerTiming[] }))).toEqual({ path: '/v1/mail/accounts/a1/messages/7', ms: 812.3 });
  });

  it('marks a call the browser answered from its cache, without the stored server timing', () => {
    const st = [{ name: 'total', duration: 900, description: '' }] as PerformanceServerTiming[];
    expect(toCall(entry({ duration: 2, encodedBodySize: 56, transferSize: 0, serverTiming: st }))).toEqual({ path: '/v1/mail/accounts/a1/messages/7', ms: 2, bytes: 56, cache: 'browser' });
  });

  it('times nothing where it cannot send (tests, old browsers)', () => {
    const a = startAction('list.folder');
    expect(() => a.end()).not.toThrow();
  });
});
