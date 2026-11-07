import { describe, expect, it } from 'vitest';
import type { CalendarInfo, EventOccurrence } from '../api';
import { calendarContext, deleteQuestion, eventOfLink, madeEventOf, rangeRequest, runCalendarClientCalls, type CalendarClientHandlers } from './assistant';

const cal = (id: string, o: Partial<CalendarInfo> = {}): CalendarInfo => ({ id, accountId: 'a', name: id.toUpperCase(), color: '#000', timezone: null, role: 'owner', hidden: false, isDefault: false, syncedAt: 'x', ...o });
const ev: EventOccurrence = { id: 'work:u1', eventId: 'work:u1', calendarId: 'work', summary: 'Stakeholder Sync', location: null, description: null, start: '2026-11-05T18:00:00.000Z', end: '2026-11-05T19:00:00.000Z', allDay: false, timezone: null, recurring: false, status: 'confirmed', organizer: null, attendees: [], etag: '"1"', updated: '', reminders: [] };

describe('the Calendar context', () => {
  it('says the view, its range, the zone, the shown calendars and the open event', () => {
    const ctx = calendarContext({ view: 'week', range: { start: new Date('2026-11-01T04:00:00Z'), end: new Date('2026-11-08T05:00:00Z') }, calendars: [cal('work'), cal('home', { hidden: true })], event: ev, search: 'sync' }, 'America/New_York');
    expect(ctx).toEqual({
      page: 'calendar', view: 'week', from: '2026-11-01T04:00:00.000Z', to: '2026-11-08T05:00:00.000Z', timezone: 'America/New_York', calendars: [{ id: 'work', name: 'WORK' }],
      event: { id: 'work:u1', summary: 'Stakeholder Sync', start: ev.start, end: ev.end, allDay: false, calendar: 'WORK', role: 'owner' }, search: 'sync',
    });
    // With the accounts: whether the open event's calendar is the FreeFlow one, and a read-only calendar is viewed only.
    const accounts = [{ id: 'a', kind: 'native' as const, email: 'ann@acme.test', displayName: 'Ann', status: 'ok' as const }, { id: 'g', kind: 'google' as const, email: 'ann@gmail.com', displayName: 'Ann', status: 'ok' as const }];
    const range = { start: new Date(0), end: new Date(86_400_000) };
    expect(calendarContext({ view: 'day', range, calendars: [cal('work')], event: ev, accounts }, 'UTC').event).toMatchObject({ native: true, role: 'owner' });
    expect(calendarContext({ view: 'day', range, calendars: [cal('work', { accountId: 'g', role: 'reader' })], event: ev, accounts }, 'UTC').event).toMatchObject({ native: false, role: 'viewer' });
    expect(calendarContext({ view: 'day', range: { start: new Date(0), end: new Date(86_400_000) }, calendars: [], event: null }, 'UTC')).not.toHaveProperty('event');
  });
});

describe('what the chat links to', () => {
  it('opens an event a tool made, and links to events in Calendar', () => {
    const item = (name: string, result: unknown, status: 'ok' | 'error' = 'ok') => ({ kind: 'tool' as const, id: 't', name, input: {}, status, result: JSON.stringify(result) });
    expect(madeEventOf(item('create_event', { created: { id: 'work:u9', start: '2026-11-06T17:00:00.000Z' } }))).toEqual({ id: 'work:u9', start: '2026-11-06T17:00:00.000Z' });
    expect(madeEventOf(item('update_event', { updated: { id: 'work:u9', start: '2026-11-06' } }))).toEqual({ id: 'work:u9', start: '2026-11-06' });
    expect(madeEventOf(item('create_event', { created: { id: 'x', start: 'y' } }, 'error'))).toBeNull();
    expect(madeEventOf(item('list_events', { events: [] }))).toBeNull();
    expect(eventOfLink('https://app.test/calendar/week/2026-11-05?event=work%3Au1', 'https://app.test')).toBe('work:u1');
    expect(eventOfLink('https://elsewhere.test/calendar/week/2026-11-05?event=work%3Au1', 'https://app.test')).toBeNull();
    expect(eventOfLink('https://app.test/mail/?account=a', 'https://app.test')).toBeNull();
  });
});

describe('the browser tools in Calendar', () => {
  const handlers = (over: Partial<CalendarClientHandlers> = {}) => {
    const done: string[] = [];
    const h: CalendarClientHandlers = {
      open: async (id) => { done.push(`open ${id}`); return id === 'work:u1'; },
      show: (d, v) => done.push(`show ${v} ${d.toISOString().slice(0, 10)}`),
      confirm: async (q) => { done.push(`ask ${q}`); return true; },
      remove: async (id, scope) => { done.push(`delete ${id} ${scope ?? ''}`.trim()); },
      summaryOf: (id) => (id === 'work:u1' ? 'Stakeholder Sync' : null),
      ...over,
    };
    return { h, done };
  };
  const call = (name: string, input: Record<string, unknown>) => ({ id: name, name, input });

  it('opens an event, moves the view, and deletes after asking', async () => {
    const { h, done } = handlers();
    const r = await runCalendarClientCalls([call('open_calendar_event', { id: 'work:u1' }), call('show_calendar_range', { from: '2026-11-09', to: '2026-11-13' }), call('delete_event', { id: 'work:u1', scope: 'this' })], h);
    expect(r.map((x) => x.isError ?? false)).toEqual([false, false, false]);
    expect(done).toEqual(['open work:u1', 'show week 2026-11-09', 'ask Delete “Stakeholder Sync” from your calendar?', 'delete work:u1 this']);
  });

  it('keeps the event when the user says no, and answers what is not Calendar\'s as unknown', async () => {
    const { h, done } = handlers({ confirm: async () => false });
    const r = await runCalendarClientCalls([call('delete_event', { id: 'work:u1', scope: 'all' }), call('open_calendar_event', { id: 'elsewhere:x' }), call('write_range', {}), call('show_calendar_range', { from: 'soon' })], h);
    expect(r.map((x) => x.isError)).toEqual([true, true, true, true]);
    expect(r[0]!.content).toMatch(/chose not to delete/);
    expect(r[2]!.content).toBe('Unknown tool write_range.');
    expect(done).toEqual(['open elsewhere:x']);
    const failing = handlers({ remove: async () => { throw new Error('The event changed on the server'); } });
    expect((await runCalendarClientCalls([call('delete_event', { id: 'work:u1' })], failing.h))[0]).toMatchObject({ isError: true, content: 'The event changed on the server' });
  });

  it('asks the question for the scope, and picks a view that fits a range', () => {
    expect(deleteQuestion({ scope: 'following' }, 'Gym')).toBe('Delete “Gym” and the events after it in the series?');
    expect(deleteQuestion({ scope: 'all' }, null)).toBe('Delete this event, every occurrence of it?');
    expect(rangeRequest({ from: '2026-11-05' })?.view).toBe('day');
    expect(rangeRequest({ from: '2026-11-01', to: '2026-11-30' })?.view).toBe('month');
    expect(rangeRequest({ from: '2026-11-01', view: 'agenda' })?.view).toBe('agenda');
  });
});
