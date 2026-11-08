// The iTIP rules (itip.ts) against RFC 5546's examples (§4.2: a group event's REQUEST, a REPLY to it, an update, a
// cancellation; §2.1.5 ordering by SEQUENCE and DTSTAMP), with A the organizer and B, C, D the attendees.
import { describe, expect, it } from 'vitest';
import { newEvent, parseObject } from './ical';
import { acceptCancel, acceptReply, acceptRequest, attendeeAddresses, decide, markAccounts, order, platformAttendees, summaryOf } from './itip';

const UID = 'calsrv.example.com-873970198738777@example.com';
const cal = (method: string, ...lines: string[]) => ['BEGIN:VCALENDAR', 'PRODID:-//Example/ExampleCalendarClient//EN', `METHOD:${method}`, 'VERSION:2.0', ...lines, 'END:VCALENDAR', ''].join('\r\n');
const A = { email: 'a@example.com', accountId: 'acct-a' }, B = { email: 'b@example.com', accountId: 'acct-b' }, C = { email: 'c@example.com', accountId: 'acct-c' };
const people = (b = 'NEEDS-ACTION') => [
  'ORGANIZER;X-FLOW-ACCOUNT=acct-a:mailto:a@example.com', 'ATTENDEE;ROLE=CHAIR;PARTSTAT=ACCEPTED:mailto:a@example.com',
  `ATTENDEE;RSVP=TRUE;CUTYPE=INDIVIDUAL;PARTSTAT=${b};X-FLOW-ACCOUNT=acct-b:mailto:b@example.com`, 'ATTENDEE;RSVP=TRUE;CUTYPE=INDIVIDUAL:mailto:c@example.com', 'ATTENDEE;RSVP=TRUE;CUTYPE=INDIVIDUAL:mailto:d@example.com',
];
/** §4.2.2: the group event's REQUEST (SEQUENCE 0); §4.2.4's update moves it (SEQUENCE 1, a later DTSTAMP). */
const request = (seq = 0, stamp = '19970611T190000Z', start = '19970701T200000Z', end = '19970701T210000Z') => cal('REQUEST', 'BEGIN:VEVENT', ...people(),
  `DTSTAMP:${stamp}`, `DTSTART:${start}`, `DTEND:${end}`, 'SUMMARY:Conference', `UID:${UID}`, `SEQUENCE:${seq}`, 'STATUS:CONFIRMED', 'END:VEVENT');
/** §4.2.3: B accepts (no DTSTART, as the RFC's REPLY has none). */
const reply = (who = 'b@example.com', partstat = 'ACCEPTED', seq = 0) => cal('REPLY', 'BEGIN:VEVENT', `ATTENDEE;PARTSTAT=${partstat}:mailto:${who}`, 'ORGANIZER:mailto:a@example.com',
  `UID:${UID}`, `SEQUENCE:${seq}`, 'REQUEST-STATUS:2.0;Success', 'DTSTAMP:19970612T190000Z', 'END:VEVENT');
/** §4.2.9: A cancels (SEQUENCE 2, STATUS:CANCELLED). */
const cancel = (seq = 2) => cal('CANCEL', 'BEGIN:VEVENT', ...people(), 'DTSTAMP:19970613T190000Z', 'DTSTART:19970701T200000Z', `UID:${UID}`, `SEQUENCE:${seq}`, 'STATUS:CANCELLED', 'END:VEVENT');
const stored = (raw: string) => raw.replace(/METHOD:[A-Z]+\r\n/, '');
const ME_B = new Set([B.email]), ME_A = new Set([A.email]);
const NOW = Date.parse('1997-06-14T00:00:00Z');
const row = (raw: string, me: Set<string>) => parseObject(raw, { me, zone: 'UTC' })[0]!;

describe('ordering (RFC 5546 §2.1.5)', () => {
  it('a higher SEQUENCE wins, then a later DTSTAMP; the same version is neither', () => {
    expect(order({ sequence: 1, dtstamp: 0 }, { sequence: 0, dtstamp: 99 })).toBe(1);
    expect(order({ sequence: 0, dtstamp: 99 }, { sequence: 1, dtstamp: 0 })).toBe(-1);
    expect(order({ sequence: 1, dtstamp: 2 }, { sequence: 1, dtstamp: 1 })).toBe(1);
    expect(order({ sequence: 1, dtstamp: 1 }, { sequence: 1, dtstamp: 1 })).toBe(0);
    const s = summaryOf(request(1, '19970612T120000Z'))!;
    expect(s).toMatchObject({ method: 'REQUEST', uid: UID, sequence: 1, dtstamp: Date.parse('1997-06-12T12:00:00Z'), organizer: { email: A.email, accountId: 'acct-a' } });
    expect(s.attendees.map((a) => [a.email, a.accountId, a.partstat])).toEqual([['a@example.com', null, 'ACCEPTED'], ['b@example.com', 'acct-b', 'NEEDS-ACTION'], ['c@example.com', null, 'NEEDS-ACTION'], ['d@example.com', null, 'NEEDS-ACTION']]);
  });
});

describe('a REQUEST at an attendee (§3.2.2)', () => {
  it('a new one makes the copy: no METHOD, the attendee needs-action, RSVP gone', () => {
    const d = decide('REQUEST', summaryOf(request())!, null, A, ME_B);
    expect(d).toEqual({ action: 'create' });
    const raw = acceptRequest(null, request(), UID, ME_B);
    expect(raw).not.toMatch(/^METHOD/m);
    const r = row(raw, ME_B);
    expect(r.data).toMatchObject({ summary: 'Conference', myResponse: 'needs-action', organizer: { email: A.email, accountId: 'acct-a' } });
    expect(raw.replace(/\r\n /g, '')).not.toMatch(/RSVP=TRUE[^\r\n]*mailto:b@example\.com/);
  });

  it('only from the organizer: an attendee, or the organizer\'s address from another account, is refused', () => {
    expect(decide('REQUEST', summaryOf(request())!, null, C, ME_B)).toMatchObject({ action: 'refuse', code: 'not_organizer' });
    expect(decide('REQUEST', summaryOf(request())!, null, { email: A.email, accountId: 'acct-x' }, ME_B)).toMatchObject({ action: 'refuse', code: 'not_organizer' });
    // An event the account organizes is never changed by a REQUEST to it.
    expect(decide('REQUEST', summaryOf(request(1))!, summaryOf(stored(request()))!, A, ME_A)).toMatchObject({ action: 'refuse', code: 'not_organizer' });
  });

  it('an update replaces the copy when newer (§4.2.4), keeping the attendee\'s answer and reminders; an older or the same one is ignored', () => {
    const mine = acceptRequest(null, request(), UID, ME_B).replace(/PARTSTAT=NEEDS-ACTION;X-FLOW-ACCOUNT=acct-b/, 'PARTSTAT=ACCEPTED;X-FLOW-ACCOUNT=acct-b')
      .replace('END:VEVENT', 'BEGIN:VALARM\r\nACTION:DISPLAY\r\nTRIGGER:-PT15M\r\nDESCRIPTION:Reminder\r\nEND:VALARM\r\nEND:VEVENT');
    const have = summaryOf(mine, UID)!;
    expect(decide('REQUEST', summaryOf(request())!, have, A, ME_B)).toMatchObject({ action: 'ignore' });
    expect(decide('REQUEST', summaryOf(request(0, '19970611T180000Z'))!, have, A, ME_B)).toMatchObject({ action: 'ignore' });
    // The same SEQUENCE with a later DTSTAMP is a newer message (a change that did not bump SEQUENCE, a summary).
    expect(decide('REQUEST', summaryOf(request(0, '19970611T200000Z'))!, have, A, ME_B)).toEqual({ action: 'update' });
    const moved = request(1, '19970612T120000Z', '19970701T210000Z', '19970701T220000Z');
    expect(decide('REQUEST', summaryOf(moved)!, have, A, ME_B)).toEqual({ action: 'update' });
    const raw = acceptRequest(mine, moved, UID, ME_B);
    const r = row(raw, ME_B);
    expect(r).toMatchObject({ startUtc: Date.parse('1997-07-01T21:00:00Z'), data: { myResponse: 'accepted', sequence: 1, reminders: [15] } });
    // An older SEQUENCE after the update is ignored, whatever its DTSTAMP.
    expect(decide('REQUEST', summaryOf(request(0, '19990101T000000Z'))!, summaryOf(raw, UID)!, A, ME_B)).toMatchObject({ action: 'ignore' });
  });
});

describe('a REPLY at the organizer (§3.2.3)', () => {
  const organizerCopy = stored(request());
  it('changes only the replier\'s PARTSTAT', () => {
    const d = decide('REPLY', summaryOf(reply())!, summaryOf(organizerCopy, UID), B, ME_A);
    expect(d).toEqual({ action: 'reply' });
    const out = acceptReply(organizerCopy, reply(), UID, B.email, NOW);
    expect(out).toMatchObject({ response: 'accepted', rid: 0 });
    expect(row(out.raw, ME_A).data.attendees.map((a) => [a.email, a.response])).toEqual([['a@example.com', 'accepted'], ['b@example.com', 'accepted'], ['c@example.com', 'needs-action'], ['d@example.com', 'needs-action']]);
    expect(row(out.raw, ME_A).data).toMatchObject({ summary: 'Conference', sequence: 0 });
  });

  it('only from an attendee about themself, only to the organizer\'s copy, not for an older version', () => {
    expect(decide('REPLY', summaryOf(reply())!, summaryOf(organizerCopy, UID), C, ME_A)).toMatchObject({ action: 'refuse', code: 'not_attendee' });
    expect(decide('REPLY', summaryOf(reply('e@example.com'))!, summaryOf(organizerCopy, UID), { email: 'e@example.com', accountId: 'acct-e' }, ME_A)).toMatchObject({ action: 'refuse', code: 'not_attendee' });
    expect(decide('REPLY', summaryOf(reply())!, summaryOf(organizerCopy, UID), B, ME_B)).toMatchObject({ action: 'refuse', code: 'not_organizer' });
    expect(decide('REPLY', summaryOf(reply('b@example.com', 'NEEDS-ACTION'))!, summaryOf(organizerCopy, UID), B, ME_A)).toMatchObject({ action: 'refuse', code: 'bad_request' });
    expect(decide('REPLY', summaryOf(reply())!, null, B, ME_A)).toMatchObject({ action: 'ignore' });
    const updated = stored(request(1, '19970612T120000Z'));
    expect(decide('REPLY', summaryOf(reply())!, summaryOf(updated, UID), B, ME_A)).toMatchObject({ action: 'ignore', reason: expect.stringMatching(/older/) });
    expect(decide('REPLY', summaryOf(reply('b@example.com', 'DECLINED', 1))!, summaryOf(updated, UID), B, ME_A)).toEqual({ action: 'reply' });
    expect(decide('REQUEST', summaryOf(reply())!, null, A, ME_B)).toMatchObject({ action: 'refuse', code: 'bad_request' });
  });
});

describe('a CANCEL at an attendee (§3.2.5, §4.2.9)', () => {
  it('keeps the event, STATUS:CANCELLED with the message\'s SEQUENCE; only from the organizer; nothing to cancel is ignored', () => {
    const copy = acceptRequest(null, request(), UID, ME_B);
    expect(decide('CANCEL', summaryOf(cancel())!, summaryOf(copy, UID), A, ME_B)).toEqual({ action: 'cancel' });
    expect(decide('CANCEL', summaryOf(cancel())!, summaryOf(copy, UID), C, ME_B)).toMatchObject({ action: 'refuse', code: 'not_organizer' });
    expect(decide('CANCEL', summaryOf(cancel())!, null, A, ME_B)).toMatchObject({ action: 'ignore' });
    const raw = acceptCancel(copy, cancel(), UID, NOW)!;
    expect(row(raw, ME_B).data).toMatchObject({ status: 'cancelled', sequence: 2, summary: 'Conference' });
    expect(decide('CANCEL', summaryOf(cancel(1))!, summaryOf(raw, UID), A, ME_B)).toMatchObject({ action: 'ignore' });
  });

  it('of one occurrence: that occurrence taken off the series', () => {
    const series = request().replace('SEQUENCE:0', 'SEQUENCE:0\r\nRRULE:FREQ=WEEKLY;COUNT=3');
    const copy = acceptRequest(null, series, UID, ME_B);
    const one = cal('CANCEL', 'BEGIN:VEVENT', ...people(), 'DTSTAMP:19970613T190000Z', 'RECURRENCE-ID:19970708T200000Z', 'DTSTART:19970708T200000Z', `UID:${UID}`, 'SEQUENCE:1', 'STATUS:CANCELLED', 'END:VEVENT');
    expect(decide('CANCEL', summaryOf(one)!, summaryOf(copy, UID), A, ME_B)).toEqual({ action: 'cancel' });
    const raw = acceptCancel(copy, one, UID, NOW)!;
    expect(row(raw, ME_B).rules?.exdates).toEqual([Date.parse('1997-07-08T20:00:00Z')]);
  });
});

describe('the organizer\'s copy, marked', () => {
  it('X-FLOW-ACCOUNT on the attendees that are accounts and on the organizer; the platform attendees read back', () => {
    const raw = newEvent('u1', { summary: 'Review', start: '2026-12-01T15:00:00Z', end: '2026-12-01T16:00:00Z', attendees: [{ email: 'bob@acme.test' }, { email: 'guest@example.com' }] },
      { me: ['ann@acme.test'], organizer: 'ann@acme.test', displayName: 'Ann', zone: 'UTC', now: NOW });
    expect(attendeeAddresses(raw, 'u1')).toEqual(['bob@acme.test', 'guest@example.com', 'ann@acme.test']);
    const marked = markAccounts(raw, 'u1', new Map([['bob@acme.test', { accountId: 'acct-bob', name: 'Bob' }], ['guest@example.com', null]]), { email: 'ann@acme.test', accountId: 'acct-ann' });
    expect([...platformAttendees(marked, 'u1', 'acct-ann')]).toEqual([['bob@acme.test', { accountId: 'acct-bob', name: 'Bob' }]]);
    const r = row(marked, new Set(['ann@acme.test']));
    expect(r.data.organizer).toMatchObject({ email: 'ann@acme.test', accountId: 'acct-ann' });
    expect(r.data.attendees.map((a) => [a.email, a.accountId ?? null, a.response, a.name])).toEqual([['bob@acme.test', 'acct-bob', 'needs-action', 'Bob'], ['guest@example.com', null, 'needs-action', null], ['ann@acme.test', 'acct-ann', 'accepted', 'Ann']]);
    // A guest that stopped being an account loses the mark.
    const again = markAccounts(marked, 'u1', new Map([['bob@acme.test', null]]), { email: 'ann@acme.test', accountId: 'acct-ann' });
    expect(platformAttendees(again, 'u1', 'acct-ann').size).toBe(0);
  });
});
