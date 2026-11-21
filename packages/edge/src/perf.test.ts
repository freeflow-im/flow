import { describe, expect, it } from 'vitest';
import { PerfBody, clientRecord, clientRoute, parseParts, requestRecord, serverTiming } from './perf';

describe('request timing', () => {
  it('reads the Mail and Calendar objects’ timing headers', () => {
    expect(parseParts('wait=3;imap=640;cache=hit')).toEqual({ wait: 3, imap: 640, cache: 'hit' });
    expect(parseParts('server=120')).toEqual({ server: 120 });
    expect(parseParts(null)).toEqual({});
  });

  it('writes a Server-Timing header with the parts and the ray id', () => {
    expect(serverTiming(812, { wait: 3, imap: 640, cache: 'live' }, '8f1c2a3b4c5d6e7f-SJC')).toBe('total;dur=812, lock;dur=3, imap;dur=640, cache;desc=live, ray;desc=8f1c2a3b4c5d6e7f-SJC');
    expect(serverTiming(40, { server: 30 }, null)).toBe('total;dur=40, upstream;dur=30');
    // Nothing that would break the header gets in.
    expect(serverTiming(1, {}, 'a"b, c')).toBe('total;dur=1');
  });

  it('logs a record with the route’s ids taken out and the line as its message', () => {
    const req = new Request('https://x/v1/mail/accounts/acc-1/messages/42?folder=INBOX', { headers: { 'cf-ray': 'abc-SJC' } });
    const r = requestRecord('mail', '[mail] GET …', req, 200, 812, { wait: 3, imap: 640 });
    expect(r).toMatchObject({ message: '[mail] GET …', perf: 'request', app: 'mail', route: 'GET /v1/mail/accounts/:id/messages/:uid', status: 200, ms: 812, wait: 3, imap: 640, ray: 'abc-SJC' });
    expect(JSON.stringify(r)).not.toMatch(/acc-1|INBOX|42/);
    expect(typeof r.isolateAgeMs).toBe('number');
  });
});

describe('the browser’s timings', () => {
  it('turns the paths it called into routes, without ids or the query', () => {
    expect(clientRoute('/v1/mail/accounts/acc-1/threads/l:9f1c-ab?folder=INBOX&workspace=w1')).toBe('/v1/mail/accounts/:id/threads/:threadId');
    expect(clientRoute('/v1/mail/accounts/acc-1/messages/42/attachments/0?inline=1')).toBe('/v1/mail/accounts/:id/messages/:uid/attachments/:index');
    expect(clientRoute('/v1/calendar/invites?workspace=w1')).toBe('/v1/calendar/invites');
    expect(clientRoute('/docs/preview/0b7c1f2e9a3d4c5b?workspace=w1')).toBe('/docs/preview/:id');
  });

  it('logs one record per action, naming the slowest call', () => {
    const body = PerfBody.parse({ events: [{ app: 'mail', action: 'thread.open', ms: 1203.4, ok: true, calls: [
      { path: '/v1/mail/accounts/a1/threads/t1?folder=INBOX', ms: 300 },
      { path: '/v1/mail/accounts/a1/messages/7?folder=INBOX', ms: 1100.2, queuedMs: 2, waitMs: 1050, server: { total: 1040, lock: 900, imap: 120 }, ray: 'r1-SJC' },
    ] }] });
    const r = clientRecord(body.events[0]!);
    expect(r.message).toBe('[perf] mail.thread.open 1203ms (2 calls, slowest /v1/mail/accounts/:id/messages/:uid 1100ms)');
    expect(r.calls[1]).toMatchObject({ route: '/v1/mail/accounts/:id/messages/:uid', server: { lock: 900 }, ray: 'r1-SJC' });
    expect(JSON.stringify(r)).not.toMatch(/a1|INBOX/);
    expect(clientRecord(PerfBody.parse({ events: [{ app: 'mail', action: 'list.folder', ms: 3000, ok: false, hidden: true }] }).events[0]!).message).toBe('[perf] mail.list.folder 3000ms failed hidden');
  });

  it('refuses what is not a timing', () => {
    expect(PerfBody.safeParse({ events: [] }).success).toBe(false);
    expect(PerfBody.safeParse({ events: [{ app: 'mail', action: 'Subject: hello', ms: 1, ok: true }] }).success).toBe(false);
    expect(PerfBody.safeParse({ events: [{ app: 'mail', action: 'list.folder', ms: 1, ok: true, calls: [{ path: '/v1/mail', ms: 1, ray: 'x"y' }] }] }).success).toBe(false);
  });
});
