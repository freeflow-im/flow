import { describe, expect, it } from 'vitest';
import { ACTIVE_CADENCE_MS, IDLE_CADENCE_MS, checkUrl, eventIdOf, nextAlarmAt, normalizeUrl, occurrenceIdOf, providerFor, routeOf, splitId, timingLine } from './rules';

describe('calendar rules', () => {
  it('has presets for iCloud and Fastmail, Google as not yet, and nothing else', () => {
    expect(providerFor('a@me.com')).toMatchObject({ name: 'iCloud', url: 'https://caldav.icloud.com/', username: 'a@me.com' });
    expect(providerFor('a@fastmail.com')).toMatchObject({ name: 'Fastmail', url: 'https://caldav.fastmail.com/' });
    expect(providerFor('a@gmail.com')).toMatchObject({ google: true });
    expect(providerFor('a@example.com')).toBeNull();
    expect(providerFor('nope')).toBeNull();
  });

  it('allows https to public hosts only, unless insecure dev mode is on', () => {
    expect(normalizeUrl('cloud.example.com/remote.php/dav')).toBe('https://cloud.example.com/remote.php/dav');
    expect(checkUrl('https://caldav.icloud.com/', false).host).toBe('caldav.icloud.com');
    for (const bad of ['http://dav.example.com/', 'https://127.0.0.1/', 'https://localhost/', 'https://10.1.2.3/', 'https://[::1]/', 'https://dav.example.com:8443/', 'ftp://x.example.com/', 'https://u:p@dav.example.com/', 'not a url'])
      expect(() => checkUrl(bad, false), bad).toThrow(/server\.url/);
    expect(checkUrl('http://127.0.0.1:5232/', true).port).toBe('5232');
  });

  it('makes and splits event ids, a UID with a colon too', () => {
    expect(splitId(eventIdOf('cal', 'a:b@x'))).toEqual({ calendarId: 'cal', uid: 'a:b@x', rid: null });
    expect(splitId(occurrenceIdOf('cal', 'u', '20261105T100000Z'))).toEqual({ calendarId: 'cal', uid: 'u', rid: '20261105T100000Z' });
    expect(() => splitId('nope')).toThrow(/not an event id/);
  });

  it('logs routes without ids, and the server time', () => {
    expect(routeOf('PATCH', 'https://x/v1/calendar/events/cal%3Au%3A20261105T100000Z')).toBe('PATCH /v1/calendar/events/:id');
    expect(routeOf('POST', 'https://x/v1/calendar/events/cal:u/respond')).toBe('POST /v1/calendar/events/:id/respond');
    expect(routeOf('PATCH', 'https://x/v1/calendar/accounts/abc')).toBe('PATCH /v1/calendar/accounts/:id');
    expect(routeOf('PATCH', 'https://x/v1/calendar/calendars/abc')).toBe('PATCH /v1/calendar/calendars/:id');
    expect(timingLine('GET', 'https://x/v1/calendar/events?from=a&to=b', 200, 12, 'server=7')).toBe('[calendar] GET /v1/calendar/events 200 12ms (server 7ms)');
  });

  it('runs the alarm every minute while active, every 10 within a day, then not at all', () => {
    const now = 1_000_000_000_000;
    expect(nextAlarmAt(now - 60_000, now, true)).toBe(now + ACTIVE_CADENCE_MS);
    expect(nextAlarmAt(now - 3_600_000, now, true)).toBe(now + IDLE_CADENCE_MS);
    expect(nextAlarmAt(now - 2 * 86_400_000, now, true)).toBeNull();
    expect(nextAlarmAt(now, now, false)).toBeNull();
  });
});
