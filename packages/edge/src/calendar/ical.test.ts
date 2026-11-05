import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DAY_MS, FOREVER, deleteFromEvent, editEvent, expand, newEvent, parseObject, parseRid, respondTo, ridText, type Rules, type WriteContext } from './ical';
import { offsetMs, utcToWall, vtimezone, wallToUtc } from './tz';

const fixture = (name: string) => readFileSync(new URL(`../../test/fixtures/calendar/${name}`, import.meta.url), 'utf8');
const ME = new Set(['ann@example.com']);
const at = (iso: string) => Date.parse(iso);
const ctx: WriteContext = { me: ['ann@example.com'], organizer: 'ann@example.com', displayName: 'Ann', zone: 'America/New_York', now: at('2026-11-04T12:00:00Z') };
const iso = (ms: number[]) => ms.map((m) => new Date(m).toISOString());
let n = 0;
const nextUid = () => `split-${++n}`;

describe('time zones', () => {
  it('converts wall clocks across daylight time, and in gaps moves on', () => {
    expect(wallToUtc({ y: 2026, mo: 10, d: 19, h: 10, mi: 0, s: 0 }, 'America/New_York')).toBe(at('2026-10-19T14:00:00Z'));
    expect(wallToUtc({ y: 2026, mo: 11, d: 2, h: 10, mi: 0, s: 0 }, 'America/New_York')).toBe(at('2026-11-02T15:00:00Z'));
    expect(wallToUtc({ y: 2026, mo: 3, d: 8, h: 2, mi: 30, s: 0 }, 'America/New_York')).toBe(at('2026-03-08T07:30:00Z'));
    expect(utcToWall(at('2026-07-01T00:00:00Z'), 'Asia/Kolkata')).toMatchObject({ h: 5, mi: 30 });
    expect(offsetMs(at('2026-01-15T00:00:00Z'), 'Australia/Sydney')).toBe(11 * 3_600_000);
  });

  it('writes a VTIMEZONE with the zone\'s rules, or one STANDARD where there is no daylight time', () => {
    const ny = vtimezone('America/New_York', 2026).join('\n');
    expect(ny).toContain('RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU');
    expect(ny).toContain('RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU');
    expect(vtimezone('Europe/Berlin', 2026).join('\n')).toContain('BYMONTH=10;BYDAY=-1SU');
    const tokyo = vtimezone('Asia/Tokyo', 2026);
    expect(tokyo.filter((l) => l.startsWith('BEGIN:STANDARD'))).toHaveLength(1);
    expect(tokyo).toContain('TZOFFSETTO:+0900');
  });
});

describe('reading an object', () => {
  it('reads a series with its exception, attendees, conference and reminder', () => {
    const rows = parseObject(fixture('weekly-ny.ics'), { me: ME, zone: 'UTC' });
    expect(rows).toHaveLength(2);
    const [master, ex] = rows;
    expect(master).toMatchObject({ uid: 'standup-1', rid: 0, kind: 1, startUtc: at('2026-10-19T14:00:00Z'), endUtc: at('2026-10-19T14:30:00Z'), recurUntil: FOREVER });
    expect(master.data).toMatchObject({ summary: 'Standup', timezone: 'America/New_York', myResponse: 'needs-action', conference: { label: 'Google Meet', url: 'https://meet.google.com/abc-defg-hij' }, reminders: [10] });
    expect(master.data.organizer).toMatchObject({ email: 'bo@example.com', name: 'Bo' });
    expect(master.data.attendees.map((a) => [a.email, a.response, a.role, !!a.self])).toEqual([['ann@example.com', 'needs-action', 'required', true], ['bo@example.com', 'accepted', 'required', false], ['cy@example.com', 'tentative', 'optional', false]]);
    expect(master.rules?.exdates).toEqual([at('2026-10-26T14:00:00Z')]);
    expect(master.search).toContain('standup');
    expect(ex).toMatchObject({ rid: at('2026-10-28T14:00:00Z'), kind: 0, startUtc: at('2026-10-28T18:00:00Z') });
    expect(ex.data.myResponse).toBe('accepted');
  });

  it('expands across the change from daylight time at the same wall clock, less the EXDATE', () => {
    const [master] = parseObject(fixture('weekly-ny.ics'), { me: ME, zone: 'UTC' });
    const starts = expand(master.rules!, at('2026-10-19T00:00:00Z'), at('2026-11-07T00:00:00Z'));
    expect(iso(starts)).toEqual(['2026-10-19T14:00:00.000Z', '2026-10-21T14:00:00.000Z', '2026-10-28T14:00:00.000Z', '2026-11-02T15:00:00.000Z', '2026-11-04T15:00:00.000Z']);
  });

  it('walks a series that began years ago from near the window, with the same answer', () => {
    const rules: Rules = { start: { y: 2016, mo: 1, d: 4, h: 9, mi: 0, s: 0 }, form: { kind: 'zone', tzid: 'Europe/London', iana: 'Europe/London' }, durationMs: 3_600_000, rrules: ['FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH'], rdates: [], exdates: [] };
    const from = at('2026-11-01T00:00:00Z'), to = at('2026-12-01T00:00:00Z');
    const fast = expand(rules, from, to);
    const slow = expand({ ...rules, rrules: ['FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH;COUNT=100000'] }, from, to);
    expect(fast.length).toBeGreaterThan(3);
    expect(fast).toEqual(slow);
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) expand(rules, from, to);
    expect(performance.now() - t0).toBeLessThan(2000);
  });

  it('ends a series at UNTIL in UTC and at its last COUNT', () => {
    const base = { start: { y: 2026, mo: 11, d: 2, h: 9, mi: 0, s: 0 }, form: { kind: 'zone', tzid: 'America/New_York', iana: 'America/New_York' } as const, durationMs: 1_800_000, rdates: [], exdates: [] };
    const until = expand({ ...base, rrules: ['FREQ=DAILY;UNTIL=20261104T140000Z'] }, at('2026-11-01T00:00:00Z'), at('2026-12-01T00:00:00Z'));
    expect(iso(until)).toEqual(['2026-11-02T14:00:00.000Z', '2026-11-03T14:00:00.000Z', '2026-11-04T14:00:00.000Z']);
    const [ev] = parseObject('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:c\r\nDTSTART:20261102T090000Z\r\nDTEND:20261102T100000Z\r\nRRULE:FREQ=DAILY;COUNT=3\r\nEND:VEVENT\r\nEND:VCALENDAR', { me: ME, zone: 'UTC' });
    expect(ev.recurUntil).toBe(at('2026-11-04T10:00:00Z'));
  });

  it('takes a shared calendar\'s owner as "me" too: their invitation is the person\'s to answer', () => {
    const raw = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:w\r\nDTSTART:20261105T160000Z\r\nDTEND:20261105T163000Z\r\nSUMMARY:Pilot check-in\r\nORGANIZER:mailto:pm@moderna.test\r\nATTENDEE;PARTSTAT=NEEDS-ACTION:mailto:scottp@biztrip.ai\r\nATTENDEE;PARTSTAT=ACCEPTED:mailto:pm@moderna.test\r\nEND:VEVENT\r\nEND:VCALENDAR';
    expect(parseObject(raw, { me: new Set(['scottpersinger@gmail.com']), zone: 'UTC' })[0].data.myResponse).toBeUndefined();
    const [ev] = parseObject(raw, { me: new Set(['scottpersinger@gmail.com', 'scottp@biztrip.ai']), zone: 'UTC' });
    expect(ev.data.myResponse).toBe('needs-action');
    expect(ev.data.attendees.find((a) => a.self)?.email).toBe('scottp@biztrip.ai');
    const answered = respondTo(raw, 'w', 0, 'accepted', undefined, { ...ctx, me: ['scottpersinger@gmail.com', 'scottp@biztrip.ai'] });
    expect(parseObject(answered, { me: new Set(['scottp@biztrip.ai']), zone: 'UTC' })[0].data.myResponse).toBe('accepted');
  });

  it('reads all-day events as dates and Outlook\'s zones by their VTIMEZONE', () => {
    const [day] = parseObject(fixture('allday.ics'), { me: ME, zone: 'UTC' });
    expect(day).toMatchObject({ kind: 0, startUtc: at('2026-11-26T00:00:00Z'), endUtc: at('2026-11-28T00:00:00Z') });
    expect(day.data.allDay).toBe(true);
    const [review] = parseObject(fixture('outlook.ics'), { me: ME, zone: 'UTC' });
    expect(review.startUtc).toBe(at('2026-07-20T07:00:00Z'));
    expect(review.data.conference?.label).toBe('Microsoft Teams');
  });

  it('reads floating times in the calendar\'s zone', () => {
    const [ev] = parseObject('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:f\r\nDTSTART:20261105T090000\r\nDTEND:20261105T100000\r\nEND:VEVENT\r\nEND:VCALENDAR', { me: ME, zone: 'Asia/Tokyo' });
    expect(ev.startUtc).toBe(at('2026-11-05T00:00:00Z'));
  });

  it('takes a long single event as its own kind, and ids round-trip', () => {
    const [ev] = parseObject('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:l\r\nDTSTART;VALUE=DATE:20260101\r\nDTEND;VALUE=DATE:20260301\r\nEND:VEVENT\r\nEND:VCALENDAR', { me: ME, zone: 'UTC' });
    expect(ev.kind).toBe(2);
    expect(parseRid(ridText(at('2026-11-05T10:00:00Z'), false))).toBe(at('2026-11-05T10:00:00Z'));
    expect(parseRid(ridText(at('2026-11-05T00:00:00Z'), true))).toBe(at('2026-11-05T00:00:00Z'));
  });
});

describe('writing', () => {
  it('writes a new timed event in its zone with a VTIMEZONE, attendees and a reminder', () => {
    const raw = newEvent('new-1', { summary: 'Lunch', start: '2026-11-05T12:00', end: '2026-11-05T13:00', timezone: 'America/New_York', attendees: [{ email: 'bo@example.com', name: 'Bo' }], reminders: [{ minutes: 15 }] }, ctx);
    expect(raw).toContain('DTSTART;TZID=America/New_York:20261105T120000');
    expect(raw.indexOf('BEGIN:VTIMEZONE')).toBeLessThan(raw.indexOf('BEGIN:VEVENT'));
    expect(raw).toContain('ORGANIZER;CN=Ann:mailto:ann@example.com');
    expect(raw.replace(/\r\n /g, '')).toMatch(/ATTENDEE;[^\r\n]*PARTSTAT=NEEDS-ACTION[^\r\n]*:mailto:bo@example.com/);
    expect(raw).toContain('TRIGGER:-PT15M');
    const [ev] = parseObject(raw, { me: ME, zone: 'UTC' });
    expect(ev).toMatchObject({ uid: 'new-1', startUtc: at('2026-11-05T17:00:00Z'), endUtc: at('2026-11-05T18:00:00Z') });
    expect(ev.data.attendees.map((a) => a.email).sort()).toEqual(['ann@example.com', 'bo@example.com']);
  });

  it('writes an all-day event as dates, and a repeating one with its rule', () => {
    const raw = newEvent('new-2', { summary: 'Off', start: '2026-11-26', end: '2026-11-28', allDay: true, recurrence: ['RRULE:FREQ=YEARLY'] }, ctx);
    expect(raw).toContain('DTSTART;VALUE=DATE:20261126');
    expect(raw).toContain('DTEND;VALUE=DATE:20261128');
    expect(raw).toContain('RRULE:FREQ=YEARLY');
    expect(() => newEvent('x', { summary: 'x', start: '2026-11-05', end: '2026-11-06', recurrence: ['SUMMARY:nope'] }, ctx)).toThrow(/recurrence/);
  });

  it('moves one occurrence as an exception (this)', () => {
    const raw = fixture('weekly-ny.ics');
    const out = editEvent(raw, 'standup-1', at('2026-11-02T15:00:00Z'), 'this', { start: '2026-11-02T16:00:00Z', end: '2026-11-02T16:30:00Z' }, ctx, nextUid);
    const rows = parseObject(out.raw, { me: ME, zone: 'UTC' });
    const ex = rows.find((r) => r.rid === at('2026-11-02T15:00:00Z'))!;
    expect(ex).toMatchObject({ startUtc: at('2026-11-02T16:00:00Z'), endUtc: at('2026-11-02T16:30:00Z') });
    expect(out.raw).toContain('RECURRENCE-ID;TZID=America/New_York:20261102T100000');
    expect(rows).toHaveLength(3);
  });

  it('splits a series at an occurrence (this and following)', () => {
    const out = editEvent(fixture('weekly-ny.ics'), 'standup-1', at('2026-11-02T15:00:00Z'), 'following', { start: '2026-11-02T16:00:00Z', end: '2026-11-02T17:00:00Z', summary: 'Standup v2' }, ctx, nextUid);
    const old = parseObject(out.raw, { me: ME, zone: 'UTC' });
    const master = old.find((r) => !r.rid)!;
    // recur_until bounds the last occurrence's end from above (UNTIL plus the duration), as the window query needs.
    expect(master.recurUntil).toBeLessThan(at('2026-11-02T15:30:00Z'));
    expect(iso(expand(master.rules!, at('2026-10-26T00:00:00Z'), at('2026-11-30T00:00:00Z')))).toEqual(['2026-10-28T14:00:00.000Z']);
    const created = parseObject(out.created!.raw, { me: ME, zone: 'UTC' });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ uid: out.created!.uid, startUtc: at('2026-11-02T16:00:00Z'), endUtc: at('2026-11-02T17:00:00Z') });
    expect(created[0].data.summary).toBe('Standup v2');
    expect(iso(expand(created[0].rules!, at('2026-11-01T00:00:00Z'), at('2026-11-10T00:00:00Z')))).toEqual(['2026-11-02T16:00:00.000Z', '2026-11-04T16:00:00.000Z', '2026-11-09T16:00:00.000Z']);
  });

  it('moves a whole series by as much as one occurrence moved (all), its exception and EXDATE with it', () => {
    const out = editEvent(fixture('weekly-ny.ics'), 'standup-1', at('2026-11-02T15:00:00Z'), 'all', { start: '2026-11-02T16:00:00Z', end: '2026-11-02T16:30:00Z' }, ctx, nextUid);
    const rows = parseObject(out.raw, { me: ME, zone: 'UTC' });
    const master = rows.find((r) => !r.rid)!;
    expect(master.startUtc).toBe(at('2026-10-19T15:00:00Z'));
    expect(master.rules!.exdates).toEqual([at('2026-10-26T15:00:00Z')]);
    expect(rows.find((r) => r.rid)!.rid).toBe(at('2026-10-28T15:00:00Z'));
  });

  it('deletes one occurrence with an EXDATE, the following by ending the series, and the whole event', () => {
    const raw = fixture('weekly-ny.ics');
    const one = deleteFromEvent(raw, 'standup-1', at('2026-10-28T14:00:00Z'), 'this', ctx)!;
    const rows = parseObject(one, { me: ME, zone: 'UTC' });
    expect(rows).toHaveLength(1);
    expect(rows[0].rules!.exdates).toContain(at('2026-10-28T14:00:00Z'));
    const following = deleteFromEvent(raw, 'standup-1', at('2026-11-02T15:00:00Z'), 'following', ctx)!;
    expect(iso(expand(parseObject(following, { me: ME, zone: 'UTC' })[0].rules!, at('2026-10-30T00:00:00Z'), at('2026-12-01T00:00:00Z')))).toEqual([]);
    expect(deleteFromEvent(raw, 'standup-1', at('2026-10-19T14:00:00Z'), 'following', ctx)).toBeNull();
    expect(deleteFromEvent(raw, 'standup-1', 0, 'all', ctx)).toBeNull();
  });

  it('answers an invitation for the series, and refuses one the person is not invited to', () => {
    const out = respondTo(fixture('weekly-ny.ics'), 'standup-1', 0, 'accepted', undefined, ctx);
    const rows = parseObject(out, { me: ME, zone: 'UTC' });
    expect(rows.every((r) => r.data.myResponse === 'accepted')).toBe(true);
    expect(out).not.toMatch(/RSVP=TRUE[^\r\n]*mailto:ann@/);
    expect(() => respondTo(fixture('allday.ics'), 'holiday-1', 0, 'accepted', undefined, ctx)).toThrow(/not an attendee/);
  });

  it('changes a plain event\'s title and makes it all-day', () => {
    const raw = newEvent('p', { summary: 'A', start: '2026-11-05T15:00:00Z', end: '2026-11-05T16:00:00Z' }, ctx);
    const out = editEvent(raw, 'p', 0, 'all', { summary: 'B', allDay: true }, ctx, nextUid);
    const [ev] = parseObject(out.raw, { me: ME, zone: 'UTC' });
    expect(ev.data).toMatchObject({ summary: 'B', allDay: true });
    expect(ev.startUtc).toBe(at('2026-11-05T00:00:00Z'));
    expect(ev.endUtc - ev.startUtc).toBe(DAY_MS);
  });
});
