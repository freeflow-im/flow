import { describe, expect, it } from 'vitest';
import type { CalendarInfo, EventOccurrence } from '../api';
import { applyDelete, applyPatch, movePatch, textOn, toFcEvent } from './occurrences';
import { neighbours, overlaps, rangeOf, step, titleOf } from './ranges';
import { describeRecurrence, describeRule, parseRule, positionOf, presetOf, presetsFor, ruleLine, withRule } from './recurrence';
import { parsePlace, pathOf } from './route';
import { RESPONDED_TEXT, whenText, withMyResponse } from './format';

const d = (y: number, m: number, day: number, h = 0, mi = 0) => new Date(y, m - 1, day, h, mi);
const occ = (o: Partial<EventOccurrence> = {}): EventOccurrence => ({
  id: 'c:u', eventId: 'c:u', calendarId: 'c', summary: 'Lunch', location: null, description: null, start: '2026-11-05T17:00:00.000Z', end: '2026-11-05T18:00:00.000Z',
  allDay: false, timezone: 'America/New_York', recurring: false, status: 'confirmed', organizer: null, attendees: [], etag: '"1"', updated: '', reminders: [], ...o,
});
const cal: CalendarInfo = { id: 'c', accountId: 'a', name: 'Work', color: '#ff9500', timezone: null, role: 'owner', hidden: false, isDefault: true, syncedAt: '' };

describe('ranges', () => {
  it('covers a day, a week, six weeks for a month, and steps by its unit', () => {
    expect(rangeOf('day', d(2026, 11, 5, 15))).toEqual({ start: d(2026, 11, 5), end: d(2026, 11, 6) });
    expect(rangeOf('week', d(2026, 11, 5))).toEqual({ start: d(2026, 11, 1), end: d(2026, 11, 8) });
    expect(rangeOf('week', d(2026, 11, 5), 1)).toEqual({ start: d(2026, 11, 2), end: d(2026, 11, 9) });
    expect(rangeOf('month', d(2026, 11, 20))).toEqual({ start: d(2026, 11, 1), end: d(2026, 12, 13) });
    expect(step('month', d(2026, 1, 31), 1)).toEqual(d(2026, 2, 28));
    expect(neighbours('week', d(2026, 11, 5)).map((r) => r.start)).toEqual([d(2026, 10, 25), d(2026, 11, 8)]);
  });

  it('crosses the change from daylight time: the week is 7 days of wall clock, 169 hours', () => {
    const r = rangeOf('week', d(2026, 11, 2));
    expect((+r.end - +r.start) / 3_600_000).toBe(169);
  });

  it('titles each view', () => {
    expect(titleOf('month', d(2026, 11, 5))).toBe('November 2026');
    expect(titleOf('week', d(2026, 11, 5))).toBe('Nov 1 – 7, 2026');
    expect(titleOf('week', d(2026, 11, 30))).toBe('Nov 29 – Dec 5, 2026');
    expect(titleOf('week', d(2026, 12, 30))).toBe('Dec 27, 2026 – Jan 2, 2027');
    expect(titleOf('day', d(2026, 11, 9))).toBe('Monday, November 9, 2026');
  });

  it('knows which occurrences fall in a range, all-day ones by their dates', () => {
    const week = rangeOf('week', d(2026, 11, 5));
    expect(overlaps(week, '2026-11-07', '2026-11-08', true)).toBe(true);
    expect(overlaps(week, '2026-11-08', '2026-11-09', true)).toBe(false);
    expect(overlaps(week, '2026-11-08T04:30:00Z', '2026-11-08T05:30:00Z', false)).toBe(true);
  });
});

describe('the address', () => {
  const B = '/calendar/';
  it('reads and writes each view, the month by its month, an open event', () => {
    expect(parsePlace('/calendar/week/2026-11-09', '', B)).toEqual({ view: 'week', date: d(2026, 11, 9), eventId: null });
    expect(parsePlace('/calendar/month/2026-11', '?event=c%3Au', B)).toEqual({ view: 'month', date: d(2026, 11, 1), eventId: 'c:u' });
    expect(parsePlace('/calendar/agenda', '', B, d(2026, 1, 2)).view).toBe('agenda');
    expect(parsePlace('/calendar/', '', B, d(2026, 1, 2))).toEqual({ view: 'week', date: d(2026, 1, 2), eventId: null });
    expect(parsePlace('/calendar/day/nonsense', '', B, d(2026, 1, 2)).date).toEqual(d(2026, 1, 2));
    expect(pathOf({ view: 'month', date: d(2026, 11, 20), eventId: null }, B)).toBe('/calendar/month/2026-11');
    expect(pathOf({ view: 'day', date: d(2026, 11, 9), eventId: 'c:u:1' }, B)).toBe('/calendar/day/2026-11-09?event=c%3Au%3A1');
  });
});

describe('occurrences', () => {
  it('draws an occurrence in its calendar\'s colour, an unanswered invitation outlined, a read-only one fixed', () => {
    expect(toFcEvent(occ(), cal)).toMatchObject({ id: 'c:u', title: 'Lunch', backgroundColor: '#ff9500', borderColor: '#ff9500', textColor: '#ffffff', editable: true });
    expect(toFcEvent(occ({ myResponse: 'needs-action' }), cal)).toMatchObject({ backgroundColor: '#ffffff', textColor: '#ff9500', classNames: ['cal-pending'] });
    expect(toFcEvent(occ({ summary: '' }), { ...cal, role: 'reader' })).toMatchObject({ title: '(No title)', editable: false });
    expect(textOn('#1a73e8')).toBe('#ffffff');
    expect(textOn('#fbd75b')).toBe('#1f1f1f');
  });

  it('asks for a drag\'s new times, keeping the length when FullCalendar gives no end', () => {
    expect(movePatch(occ(), new Date('2026-11-05T19:00:00Z'), null, false, undefined)).toEqual({ start: '2026-11-05T19:00:00.000Z', end: '2026-11-05T20:00:00.000Z', etag: '"1"' });
    expect(movePatch(occ(), d(2026, 11, 6), null, true, 'this')).toEqual({ start: '2026-11-06', end: '2026-11-07', allDay: true, scope: 'this', etag: '"1"' });
  });

  it('moves the occurrences a change reaches in a cached window: this, following, all', () => {
    const series = ['2026-11-02', '2026-11-03', '2026-11-04'].map((day, i) => occ({ id: `c:s:${i}`, eventId: 'c:s', recurring: true, start: `${day}T15:00:00.000Z`, end: `${day}T16:00:00.000Z` }));
    const [s0, s1] = series as [EventOccurrence, EventOccurrence, EventOccurrence];
    void s0;
    const list = [...series, occ()];
    const patch = { start: '2026-11-03T17:00:00.000Z', end: '2026-11-03T18:00:00.000Z' };
    const starts = (l: EventOccurrence[]) => l.map((o) => o.start.slice(5, 16));
    expect(starts(applyPatch(list, s1, patch, 'this'))).toEqual(['11-02T15:00', '11-03T17:00', '11-04T15:00', '11-05T17:00']);
    expect(starts(applyPatch(list, s1, patch, 'following'))).toEqual(['11-02T15:00', '11-03T17:00', '11-04T17:00', '11-05T17:00']);
    expect(starts(applyPatch(list, s1, patch, 'all'))).toEqual(['11-02T17:00', '11-03T17:00', '11-04T17:00', '11-05T17:00']);
    expect(applyPatch(list, list[3]!, { summary: 'Brunch' }, 'all')[3]?.summary).toBe('Brunch');
    expect(applyDelete(list, s1, 'following').map((o) => o.id)).toEqual(['c:s:0', 'c:u']);
    expect(applyDelete(list, s1, 'this').map((o) => o.id)).toEqual(['c:s:0', 'c:s:2', 'c:u']);
    expect(applyDelete(list, s1, 'all').map((o) => o.id)).toEqual(['c:u']);
  });
});

describe('recurrence', () => {
  it('offers the presets for a start, and knows them again', () => {
    const start = d(2026, 11, 10);
    const presets = presetsFor(start);
    expect(presets.map((p) => p.label)).toEqual(['Does not repeat', 'Daily', 'Weekly on Tuesday', 'Every weekday (Monday to Friday)', 'Monthly on day 10', 'Monthly on the second Tuesday', 'Annually on November 10', 'Custom…']);
    expect(presetOf(['RRULE:FREQ=WEEKLY;BYDAY=TU'], start)).toBe('weekly');
    expect(presetOf(['RRULE:FREQ=MONTHLY;BYDAY=2TU'], start)).toBe('monthly-position');
    expect(presetOf(['RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU'], start)).toBe('custom');
    expect(presetOf([], start)).toBe('none');
    expect(positionOf(d(2026, 11, 24))).toBe('-1TU');
  });

  it('puts rules in words', () => {
    expect(describeRule('RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;COUNT=10')).toBe('Every 2 weeks on Tuesday and Thursday, 10 times');
    expect(describeRule('RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR')).toBe('Every weekday');
    expect(describeRule('RRULE:FREQ=MONTHLY;BYDAY=-1FR;UNTIL=20271231T235959Z')).toBe('Monthly on the last Friday, until Dec 31, 2027');
    expect(describeRule('FREQ=DAILY')).toBe('Daily');
    expect(describeRecurrence(['RRULE:FREQ=YEARLY', 'EXDATE:20271105T100000Z'])).toBe('Annually');
    expect(describeRecurrence(undefined)).toBeNull();
  });

  it('writes a custom rule and reads it back, and keeps a series\' EXDATEs when its rule changes', () => {
    const line = ruleLine({ freq: 'WEEKLY', interval: 2, byday: ['MO', 'WE'], end: { kind: 'until', date: '2026-12-31' } });
    expect(line).toBe('RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;UNTIL=20261231T235959Z');
    expect(parseRule(line)).toEqual({ freq: 'WEEKLY', interval: 2, byday: ['MO', 'WE'], end: { kind: 'until', date: '2026-12-31' } });
    expect(parseRule('RRULE:FREQ=MINUTELY')).toBeNull();
    expect(withRule(['RRULE:FREQ=DAILY', 'EXDATE:20261105T100000Z'], 'RRULE:FREQ=WEEKLY')).toEqual(['RRULE:FREQ=WEEKLY', 'EXDATE:20261105T100000Z']);
    expect(withRule(['RRULE:FREQ=DAILY', 'EXDATE:20261105T100000Z'], null)).toEqual([]);
  });
});

describe('format', () => {
  it('says when, for a timed event, an all-day span and one across midnight', () => {
    expect(whenText(occ())).toBe('Thursday, November 5 · 12 – 1 PM');
    expect(whenText(occ({ start: '2026-11-05T16:30:00.000Z', end: '2026-11-05T18:00:00.000Z' }))).toBe('Thursday, November 5 · 11:30 AM – 1 PM');
    expect(whenText(occ({ allDay: true, start: '2026-11-05', end: '2026-11-06' }))).toBe('Thursday, November 5 · All day');
    expect(whenText(occ({ allDay: true, start: '2026-11-05', end: '2026-11-08' }))).toBe('Thu, Nov 5 – Sat, Nov 7 · All day');
    expect(whenText(occ({ start: '2026-11-06T03:00:00.000Z', end: '2026-11-06T06:00:00.000Z' }))).toBe('Thu, Nov 5, 10 PM – Fri, Nov 6, 1 AM');
  });
});

describe('the dialog\'s times', () => {
  it('reads an instant as the wall clock of a zone', async () => {
    const { wallIn, reminderText } = await import('./format');
    expect(wallIn('2026-11-05T17:00:00.000Z', 'America/New_York')).toEqual({ date: '2026-11-05', time: '12:00' });
    expect(wallIn('2026-11-05T17:00:00.000Z', 'Asia/Tokyo')).toEqual({ date: '2026-11-06', time: '02:00' });
    expect(reminderText(10)).toBe('10 minutes before');
    expect(reminderText(1440)).toBe('1 day before');
  });
});

describe('answering an invitation', () => {
  it('sets the person\'s own answer on the occurrence at once, and the toast names it', () => {
    const o = occ({ myResponse: 'needs-action', attendees: [{ name: 'Ann', email: 'ann@x.test', role: 'required', response: 'accepted' }, { name: null, email: 'me@x.test', role: 'required', response: 'needs-action', self: true }] });
    const answered = withMyResponse(o, 'tentative');
    expect(answered.myResponse).toBe('tentative');
    expect(answered.attendees.map((a) => a.response)).toEqual(['accepted', 'tentative']);
    expect(o.myResponse).toBe('needs-action');
    expect([RESPONDED_TEXT.accepted, RESPONDED_TEXT.declined, RESPONDED_TEXT.tentative]).toEqual(['Accepted', 'Declined', 'Tentatively accepted']);
  });
});
