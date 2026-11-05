import { describe, expect, it } from 'vitest';
import { CALENDAR_TOOLS, CalendarToolError, calendarToolsFor, checkEventId, describeRule, freeSlots, validateCalendarInput, type CalendarToolContext } from './calendarTools';
import type { EventOccurrence } from './store';

const at = (iso: string) => Date.parse(iso);
const tool = (name: string) => CALENDAR_TOOLS.find((t) => t.name === name)!;
const occ = (o: Partial<EventOccurrence> = {}): EventOccurrence => ({
  id: 'cal1:u1', eventId: 'cal1:u1', calendarId: 'cal1', summary: 'Lunch', location: null, description: 'Bring the numbers', start: '2026-11-05T17:00:00.000Z', end: '2026-11-05T18:00:00.000Z',
  allDay: false, timezone: 'America/New_York', recurring: false, status: 'confirmed', organizer: null, attendees: [], etag: '"1"', updated: '', reminders: [10], ...o,
});

/** A fake Calendar object: its HTTP API by method and path, recording every request. */
function fake(routes: Record<string, (body: unknown, url: URL) => { status?: number; json: unknown }>) {
  const asked: { method: string; path: string; body: unknown }[] = [];
  const ctx: CalendarToolContext = {
    origin: 'https://app.test',
    calendar: async (path, init) => {
      const url = new URL(`https://x${path}`);
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      asked.push({ method, path, body });
      const route = routes[`${method} ${url.pathname}`] ?? routes[`${method} ${url.pathname.replace(/\/events\/[^/]+/, '/events/:id')}`];
      if (!route) return Response.json({ error: { code: 'not_found', message: 'not found' } }, { status: 404 });
      const r = route(body, url);
      return Response.json(r.json, { status: r.status ?? 200 });
    },
  };
  return { ctx, asked };
}
const CALS = { calendars: [{ id: 'cal1', accountId: 'a1', name: 'Work', color: '#f00', timezone: 'America/New_York', role: 'owner', hidden: false, isDefault: true, syncedAt: 'x' }, { id: 'hol', accountId: 'a1', name: 'Holidays', color: '#0f0', timezone: null, role: 'reader', hidden: false, isDefault: false, syncedAt: 'x' }] };
const ACCOUNTS = { accounts: [{ id: 'a1', kind: 'google', email: 'ann@gmail.com', displayName: 'Ann', status: 'ok' }] };

describe('the Calendar tools', () => {
  it('are listed by scope: calendar:read reads and finds time, calendar:write also changes', () => {
    const names = (s: string[]) => calendarToolsFor(s).map((t) => t.name);
    expect(names([])).toEqual([]);
    expect(names(['calendar:read'])).toEqual(['list_calendars', 'list_events', 'get_event', 'find_free_time']);
    expect(names(['calendar:write'])).toHaveLength(CALENDAR_TOOLS.length);
    for (const t of CALENDAR_TOOLS) expect(t.annotations.readOnlyHint).toBe(t.scopes.every((s) => s === 'calendar:read'));
    expect(tool('delete_event').annotations.destructiveHint).toBe(true);
  });

  it('checks event ids for their shape, and inputs against their schemas', () => {
    expect(checkEventId('cal1:u1')).toBe('cal1:u1');
    expect(checkEventId('cal1:a%3Ab:20261105T170000Z')).toBe('cal1:a%3Ab:20261105T170000Z');
    for (const bad of ['nope', 'a:b:c:d', 'cal1:u1:tomorrow', '', 42]) expect(() => checkEventId(bad)).toThrow(CalendarToolError);
    expect(() => validateCalendarInput(tool('list_events'), { from: '2026-11-01', to: '2026-11-08', limit: 500 })).toThrow(/limit/);
    expect(() => validateCalendarInput(tool('create_event'), { start: '2026-11-05T10:00', end: '2026-11-05T11:00' })).toThrow(/summary/);
    expect(() => validateCalendarInput(tool('get_event'), { id: 'cal1:u1', extra: 1 })).toThrow();
  });

  it('lists calendars, and says how to connect one when there is none', async () => {
    const { ctx } = fake({ 'GET /v1/calendar/accounts': () => ({ json: ACCOUNTS }), 'GET /v1/calendar/calendars': () => ({ json: CALS }) });
    const r = await tool('list_calendars').run(ctx, {});
    expect(r.calendars).toEqual([{ id: 'cal1', name: 'Work', account: 'ann@gmail.com', default: true, timezone: 'America/New_York' }, { id: 'hol', name: 'Holidays', account: 'ann@gmail.com', read_only: true }]);
    const none = fake({ 'GET /v1/calendar/accounts': () => ({ json: { accounts: [] } }), 'GET /v1/calendar/calendars': () => ({ json: { calendars: [] } }) });
    expect((await tool('list_calendars').run(none.ctx, {})).note).toMatch(/app\.test\/calendar/);
    await expect(tool('list_events').run(none.ctx, { from: '2026-11-01', to: '2026-11-08' })).rejects.toThrow(/No calendar is connected.*app\.test\/calendar/);
  });

  it('lists a window compactly, with answers and links, and refuses one over 93 days', async () => {
    const series = occ({ id: 'cal1:s:20261105T150000Z', eventId: 'cal1:s', recurring: true, recurrenceId: '20261105T150000Z', recurrence: ['RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TH'], myResponse: 'needs-action',
      organizer: { name: 'Bo', email: 'bo@corp.test', role: 'required', response: 'accepted' }, attendees: [{ name: 'Ann', email: 'ann@gmail.com', role: 'required', response: 'needs-action', self: true }], conference: { url: 'https://meet.google.com/x', label: 'Google Meet' } });
    const { ctx, asked } = fake({ 'GET /v1/calendar/calendars': () => ({ json: CALS }), 'GET /v1/calendar/events': () => ({ json: { events: [occ(), series] } }) });
    const r = await tool('list_events').run(ctx, { from: '2026-11-01', to: '2026-11-08', q: 'lunch', calendars: ['cal1'] });
    expect(asked.at(-1)!.path).toMatch(/from=2026-11-01T00%3A00%3A00.000Z&to=2026-11-08T00%3A00%3A00.000Z&limit=101&calendars=cal1&q=lunch/);
    const [plain, rec] = r.events as Record<string, unknown>[];
    expect(plain).toMatchObject({ id: 'cal1:u1', summary: 'Lunch', calendar: { id: 'cal1', name: 'Work' }, link: 'https://app.test/calendar/week/2026-11-05?event=cal1%3Au1' });
    expect(plain).not.toHaveProperty('description');
    expect(rec).toMatchObject({ series_id: 'cal1:s', repeats: 'Every 2 weeks on Thursday', organizer: 'Bo <bo@corp.test>', video_call: 'https://meet.google.com/x', my_response: 'needs-action', attendees: [{ email: 'ann@gmail.com', name: 'Ann', response: 'needs-action', you: true }] });
    await expect(tool('list_events').run(ctx, { from: '2026-01-01', to: '2026-06-01' })).rejects.toThrow(/at most 93 days/);
    await expect(tool('list_events').run(ctx, { from: 'soon', to: '2026-06-01' })).rejects.toThrow(/from/);
  });

  it('creates, changes, answers and deletes through the API, with its scopes and the conflict said plainly', async () => {
    const { ctx, asked } = fake({
      'GET /v1/calendar/calendars': () => ({ json: CALS }),
      'POST /v1/calendar/events': (b) => ({ status: 201, json: { event: occ({ summary: (b as { summary: string }).summary, attendees: [{ name: null, email: 'bo@corp.test', role: 'required', response: 'needs-action' }] }) } }),
      'PATCH /v1/calendar/events/:id': (b) => ((b as { etag?: string; start?: string }).start === 'stale' ? { status: 409, json: { error: { code: 'conflict', message: 'The event changed on the server since it was loaded; look again' } } } : { json: { event: occ({ start: '2026-11-05T18:00:00.000Z' }) } }),
      'POST /v1/calendar/events/:id/respond': () => ({ json: { event: occ({ myResponse: 'accepted' }) } }),
      'DELETE /v1/calendar/events/:id': () => ({ json: { ok: true } }),
    });
    const made = await tool('create_event').run(ctx, { summary: 'Lunch', start: '2026-11-05T12:00', end: '2026-11-05T13:00', timezone: 'America/New_York', attendees: ['Bo <bo@corp.test>'], optional_attendees: ['cy@corp.test'], reminders_minutes: [15] });
    expect(asked.at(-1)!.body).toEqual({ summary: 'Lunch', start: '2026-11-05T12:00', end: '2026-11-05T13:00', timezone: 'America/New_York', attendees: [{ email: 'bo@corp.test', name: 'Bo', role: 'required' }, { email: 'cy@corp.test', role: 'optional' }], reminders: [{ minutes: 15 }] });
    expect(made).toMatchObject({ created: { summary: 'Lunch' }, invited: ['bo@corp.test'] });
    await expect(tool('create_event').run(ctx, { summary: 'x', start: '2026-11-05T12:00', end: '2026-11-05T13:00', attendees: ['not an address'] })).rejects.toThrow(/not an email address/);
    await tool('update_event').run(ctx, { id: 'cal1:s:20261105T150000Z', scope: 'following', start: '2026-11-05T13:00' });
    expect(asked.at(-1)).toMatchObject({ method: 'PATCH', path: '/v1/calendar/events/cal1%3As%3A20261105T150000Z', body: { start: '2026-11-05T13:00', scope: 'following' } });
    await expect(tool('update_event').run(ctx, { id: 'cal1:u1' })).rejects.toThrow(/Nothing to change/);
    await expect(tool('update_event').run(ctx, { id: 'cal1:u1', start: 'stale' })).rejects.toThrow(/changed on the server.*get_event/);
    expect(await tool('respond_to_event').run(ctx, { id: 'cal1:u1', response: 'accepted' })).toMatchObject({ answered: 'accepted', event: { my_response: 'accepted' } });
    expect(await tool('delete_event').run(ctx, { id: 'cal1:s:20261105T150000Z', scope: 'this' })).toEqual({ deleted: 'cal1:s:20261105T150000Z', scope: 'this' });
    expect(asked.at(-1)!.path).toBe('/v1/calendar/events/cal1%3As%3A20261105T150000Z?scope=this');
    await expect(tool('delete_event').run(ctx, { id: 'bad id' })).rejects.toThrow(/not an event id/);
  });

  it('says a refused login and a missing event in words the agent can act on', async () => {
    const { ctx } = fake({ 'GET /v1/calendar/calendars': () => ({ json: CALS }), 'GET /v1/calendar/events/:id': () => ({ status: 422, json: { error: { code: 'auth_failed', message: 'Google no longer gives FreeFlow access' } } }) });
    await expect(tool('get_event').run(ctx, { id: 'cal1:u1' })).rejects.toThrow(/refused this account's login.*app\.test\/calendar/);
    const missing = fake({ 'GET /v1/calendar/calendars': () => ({ json: CALS }) });
    await expect(tool('get_event').run(missing.ctx, { id: 'cal1:u1' })).rejects.toThrow(/Not found/);
  });

  it('finds free time for everyone it can see, in working hours, and names who it cannot', async () => {
    const { ctx, asked } = fake({
      'GET /v1/calendar/calendars': () => ({ json: CALS }),
      'GET /v1/calendar/accounts': () => ({ json: ACCOUNTS }),
      'POST /v1/calendar/freebusy': () => ({ json: { busy: [{ email: 'ann@gmail.com', intervals: [['2026-11-05T14:00:00.000Z', '2026-11-05T16:00:00.000Z']] }], unknown: ['bo@corp.test'] } }),
    });
    const r = await tool('find_free_time').run(ctx, { duration_minutes: 30, from: '2026-11-05T00:00:00Z', to: '2026-11-06T00:00:00Z', attendees: ['bo@corp.test'] });
    expect(asked.at(-1)!.body).toEqual({ emails: ['ann@gmail.com', 'bo@corp.test'], from: '2026-11-05T00:00:00.000Z', to: '2026-11-06T00:00:00.000Z' });
    // 9:00-17:00 New York is 14:00-22:00 UTC; Ann is busy 14:00-16:00 UTC: free 16:00-22:00.
    expect(r).toMatchObject({ timezone: 'America/New_York', slots: [{ start: '2026-11-05T16:00:00.000Z', end: '2026-11-05T22:00:00.000Z', minutes: 360 }], unknown: ['bo@corp.test'] });
  });
});

describe('free slots', () => {
  const NY = 'America/New_York';
  it('subtracts everyone\'s busy time from working hours, day by day, longest first', () => {
    const busy: [number, number][] = [[at('2026-11-05T15:00:00Z'), at('2026-11-05T16:00:00Z')], [at('2026-11-05T15:30:00Z'), at('2026-11-05T17:00:00Z')], [at('2026-11-06T14:00:00Z'), at('2026-11-06T21:30:00Z')]];
    const s = freeSlots(busy, at('2026-11-05T00:00:00Z'), at('2026-11-07T00:00:00Z'), 30 * 60_000, { start: '09:00', end: '17:00', days: [1, 2, 3, 4, 5] }, NY);
    expect(s.map((x) => [new Date(x.start).toISOString().slice(5, 16), new Date(x.end).toISOString().slice(5, 16)])).toEqual([['11-05T17:00', '11-05T22:00'], ['11-05T14:00', '11-05T15:00'], ['11-06T21:30', '11-06T22:00']]);
  });

  it('keeps the wall clock across a change of daylight time, skips weekends, and can look at any time', () => {
    const wh = { start: '09:00', end: '10:00', days: [1, 2, 3, 4, 5] };
    const s = freeSlots([], at('2026-10-30T00:00:00Z'), at('2026-11-03T00:00:00Z'), 60 * 60_000, wh, NY);
    expect(s.map((x) => new Date(x.start).toISOString()).sort()).toEqual(['2026-10-30T13:00:00.000Z', '2026-11-02T14:00:00.000Z']);
    expect(freeSlots([[at('2026-11-05T10:00:00Z'), at('2026-11-05T11:00:00Z')]], at('2026-11-05T09:00:00Z'), at('2026-11-05T12:00:00Z'), 60 * 60_000, null, 'UTC')).toEqual([{ start: at('2026-11-05T09:00:00Z'), end: at('2026-11-05T10:00:00Z') }, { start: at('2026-11-05T11:00:00Z'), end: at('2026-11-05T12:00:00Z') }]);
    expect(freeSlots([], 0, 3_600_000, 2 * 3_600_000, null, 'UTC')).toEqual([]);
  });

  it('puts a rule in words', () => {
    expect(describeRule(['RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR'])).toBe('Every weekday');
    expect(describeRule(['RRULE:FREQ=MONTHLY;BYDAY=-1FR;COUNT=6'])).toBe('Monthly on the last Friday, 6 times');
    expect(describeRule(['RDATE:20261105T100000Z'])).toBe('Repeats on chosen dates');
    expect(describeRule(undefined)).toBeNull();
  });
});
