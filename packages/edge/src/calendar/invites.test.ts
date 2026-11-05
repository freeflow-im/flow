import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { guestsOf, itipReply, itipRequest, newEvent, organizerOf, parseInvitation, parseObject, respondTo, sequenceOf, storedInvitation } from './ical';
import type { CalendarMail } from './imip';
import { Invites, isCalendarPart, type InviteCalendars, type InviteMail } from './invites';
import { CalendarStore, type Sql } from './store';

/** A fixture, with the CRLF line ends iCalendar has (whatever a checkout did to them). */
const fixture = (name: string) => readFileSync(new URL(`../../test/fixtures/calendar/${name}`, import.meta.url), 'utf8').replace(/\r?\n/g, '\r\n');
const at = (iso: string) => Date.parse(iso);
const ME = new Set(['scott@example.com']);
const NOW = at('2026-11-05T12:00:00Z');
const GOOGLE_UID = '7kukuqrfedlm2f9t0vr42q6dqu@google.com';
const OUTLOOK_UID = '040000008200E00074C5B7101A82E00800000000F0A1B2C3D4E5F601000000000000000010000000AABBCCDDEEFF';

describe('reading an invitation', () => {
  it('a Google invitation: what, when in its zone, where, the organizer, the guests with the person marked, the call', () => {
    const inv = parseInvitation(fixture('invite-google-request.ics'), { me: ME, zone: 'UTC' });
    expect(inv).toMatchObject({ method: 'REQUEST', uid: GOOGLE_UID, sequence: 0, replier: null });
    expect(inv.main).toMatchObject({ rid: 0, startUtc: at('2026-11-05T15:00:00Z'), endUtc: at('2026-11-05T16:00:00Z') });
    expect(inv.main.data).toMatchObject({ summary: 'Planning', location: 'Room 4', timezone: 'America/New_York', myResponse: 'needs-action', organizer: { email: 'ann@gmail.com', name: 'Ann Lee' }, conference: { label: 'Google Meet' } });
    expect(inv.main.data.attendees.map((a) => [a.email, a.response, !!a.self, a.role])).toEqual([
      ['ann@gmail.com', 'accepted', false, 'required'], ['scott@example.com', 'needs-action', true, 'required'], ['bo@example.org', 'tentative', false, 'optional'],
    ]);
  });

  it('an Outlook invitation: a weekly series in a Windows zone, the address in another case', () => {
    const inv = parseInvitation(fixture('invite-outlook-request.ics'), { me: ME, zone: 'UTC' });
    expect(inv).toMatchObject({ method: 'REQUEST', uid: OUTLOOK_UID });
    expect(inv.main).toMatchObject({ kind: 1, startUtc: at('2026-11-10T17:00:00Z'), endUtc: at('2026-11-10T17:30:00Z') });
    expect(inv.main.data).toMatchObject({ summary: 'Design sync', myResponse: 'needs-action', conference: { label: 'Microsoft Teams' }, recurrence: ['RRULE:FREQ=WEEKLY;UNTIL=20261231T170000Z;INTERVAL=1;BYDAY=TU;WKST=SU'] });
    expect(inv.main.data.attendees.find((a) => a.self)?.email).toBe('scott@example.com');
  });

  it('a cancellation, of an event or of one occurrence; a reply, with who answered', () => {
    const all = parseInvitation(fixture('invite-google-cancel.ics'), { me: ME, zone: 'UTC' });
    expect(all).toMatchObject({ method: 'CANCEL', uid: GOOGLE_UID, sequence: 1, main: { rid: 0, data: { status: 'cancelled' } } });
    const one = parseInvitation(fixture('invite-outlook-cancel-occurrence.ics'), { me: ME, zone: 'UTC' });
    expect(one).toMatchObject({ method: 'CANCEL', uid: OUTLOOK_UID, main: { rid: at('2026-11-17T17:00:00Z') } });
    const reply = parseInvitation(fixture('invite-reply.ics'), { me: ME, zone: 'UTC' });
    expect(reply).toMatchObject({ method: 'REPLY', uid: 'lunch-42@freeflow.im', replier: { email: 'ann@gmail.com', name: 'Ann Lee', response: 'accepted' } });
    expect(reply.main.data.organizer?.self).toBe(true);
  });

  it('refuses what is not an invitation: no METHOD, PUBLISH, not iCalendar, no event', () => {
    const plain = fixture('invite-google-request.ics').replace('METHOD:REQUEST\r\n', '');
    expect(() => parseInvitation(plain, { me: ME, zone: 'UTC' })).toThrow(/not an invitation/);
    expect(() => parseInvitation(plain.replace('CALSCALE:GREGORIAN', 'CALSCALE:GREGORIAN\r\nMETHOD:PUBLISH'), { me: ME, zone: 'UTC' })).toThrow(/not an invitation/);
    expect(() => parseInvitation('hello', { me: ME, zone: 'UTC' })).toThrow(/not iCalendar/);
    expect(() => parseInvitation('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nMETHOD:REQUEST\r\nEND:VCALENDAR', { me: ME, zone: 'UTC' })).toThrow(/no event/);
    expect(isCalendarPart('text/calendar; method=REQUEST', 'attachment-3')).toBe(true);
    expect(isCalendarPart('application/ics', 'invite.ics')).toBe(true);
    expect(isCalendarPart('application/octet-stream', 'Meeting.ICS')).toBe(true);
    expect(isCalendarPart('application/pdf', 'agenda.pdf')).toBe(false);
  });
});

describe('writing iTIP', () => {
  it('an invitation goes on a calendar without METHOD, with the answer and no RSVP; a list\'s invitation adds the person', () => {
    const stored = storedInvitation(fixture('invite-google-request.ics'), GOOGLE_UID, 'accepted', { me: ['scott@example.com'], fallback: null, now: NOW });
    expect(stored).not.toMatch(/^METHOD/m);
    const [row] = parseObject(stored, { me: ME, zone: 'UTC' });
    expect(row.data.myResponse).toBe('accepted');
    expect(stored.replace(/\r\n /g, '')).toMatch(/PARTSTAT=ACCEPTED[^\r\n]*mailto:scott@example\.com/);
    expect(stored.replace(/\r\n /g, '')).not.toMatch(/RSVP=TRUE[^\r\n]*scott@example\.com/);
    const listed = storedInvitation(fixture('invite-google-request.ics'), GOOGLE_UID, 'tentative', { me: ['me@elsewhere.org'], fallback: { email: 'me@elsewhere.org', name: 'Me' }, now: NOW });
    expect(parseObject(listed, { me: new Set(['me@elsewhere.org']), zone: 'UTC' })[0].data.myResponse).toBe('tentative');
  });

  it('a REPLY carries only the person\'s attendee line, for the series or one occurrence', () => {
    const answered = respondTo(fixture('invite-outlook-request.ics').replace('METHOD:REQUEST\r\n', ''), OUTLOOK_UID, 0, 'declined', undefined, { me: ['scott@example.com'], organizer: null, displayName: 'Scott', zone: 'UTC', now: NOW });
    const reply = itipReply(answered, OUTLOOK_UID, 0, { me: ['scott@example.com'], now: NOW });
    expect(reply).toMatch(/^METHOD:REPLY\r$/m);
    const flat = reply.replace(/\r\n /g, '');
    expect(flat.match(/^ATTENDEE/gm)).toHaveLength(1);
    expect(flat).toMatch(/ATTENDEE;[^\r\n]*PARTSTAT=DECLINED[^\r\n]*:mailto:Scott@Example\.com/i);
    expect(flat).toContain('ORGANIZER;CN=Chen Wei:mailto:chen@contoso.com');
    expect(flat).not.toContain('BEGIN:VALARM');
    expect(flat).toContain('DTSTAMP:20261105T120000Z');
    // One occurrence: its own VEVENT, by RECURRENCE-ID.
    const rid = at('2026-11-17T17:00:00Z');
    const once = respondTo(answered, OUTLOOK_UID, rid, 'accepted', undefined, { me: ['scott@example.com'], organizer: null, displayName: 'Scott', zone: 'UTC', now: NOW });
    const occ = itipReply(once, OUTLOOK_UID, rid, { me: ['scott@example.com'], now: NOW });
    expect(occ.match(/BEGIN:VEVENT/g)).toHaveLength(1);
    expect(occ).toMatch(/RECURRENCE-ID;TZID=Pacific Standard Time:20261117T090000/);
    expect(occ.replace(/\r\n /g, '')).toMatch(/PARTSTAT=ACCEPTED/);
  });

  it('an organizer\'s REQUEST is the event without alarms; a CANCEL is cancelled with the SEQUENCE on, or one occurrence', () => {
    const ctx = { me: ['scott@example.com'], organizer: 'scott@example.com', displayName: 'Scott', zone: 'America/New_York', now: NOW };
    const raw = newEvent('lunch-1', { summary: 'Lunch', start: '2026-11-06T12:00', end: '2026-11-06T13:00', timezone: 'America/New_York', recurrence: ['RRULE:FREQ=WEEKLY;COUNT=4'], attendees: [{ email: 'bo@example.org', name: 'Bo' }], reminders: [{ minutes: 10 }] }, ctx);
    expect(organizerOf(raw, 'lunch-1')).toBe('scott@example.com');
    expect(guestsOf(raw, 'lunch-1', ['scott@example.com'])).toEqual([{ email: 'bo@example.org', name: 'Bo' }]);
    const req = itipRequest(raw, 'lunch-1', 'REQUEST', { now: NOW, zone: 'UTC' });
    expect(req).toMatch(/^METHOD:REQUEST\r$/m);
    expect(req).toContain('BEGIN:VTIMEZONE');
    expect(req).not.toContain('BEGIN:VALARM');
    expect(req).toContain('RRULE:FREQ=WEEKLY;COUNT=4');
    const cancel = itipRequest(raw, 'lunch-1', 'CANCEL', { now: NOW, zone: 'UTC' });
    expect(cancel).toMatch(/^METHOD:CANCEL\r$/m);
    expect(cancel).toContain('STATUS:CANCELLED');
    expect(cancel).toContain('SEQUENCE:1');
    expect(sequenceOf(raw, 'lunch-1')).toBe(0);
    const one = itipRequest(raw, 'lunch-1', 'CANCEL', { now: NOW, zone: 'UTC' }, at('2026-11-13T17:00:00Z'));
    expect(one).toContain('RECURRENCE-ID;TZID=America/New_York:20261113T120000');
    expect(one.slice(one.indexOf('BEGIN:VEVENT'))).not.toContain('RRULE');
  });
});

// ---- the routes' core, against a fake Mail and an in-memory store ------------------------------------------------------

function memory(): Sql {
  const db = new DatabaseSync(':memory:');
  return {
    exec(query, ...bindings) {
      const statement = db.prepare(query);
      const rows = /^\s*(SELECT|WITH)/i.test(query) || /RETURNING/i.test(query) ? statement.all(...(bindings as never[])) : (statement.run(...(bindings as never[])), []);
      return { toArray: () => rows as never };
    },
  };
}

/** A person with one calendar on a server that does (Google) or does not (Radicale) schedule, and one mail account. */
function setup(opts: { schedules?: boolean; parts?: Record<string, string>; mailAddress?: string; failSend?: boolean } = {}) {
  const sql = memory();
  const store = new CalendarStore(sql);
  store.init();
  sql.exec(`INSERT INTO calendars (id, account_id, href, name, created_at, is_default) VALUES ('cal', 'acct', 'https://dav.example.com/cal/', 'Work', 0, 1)`);
  const sent: { account: string; mail: CalendarMail }[] = [];
  const writes: string[] = [];
  const me = new Set(['scott@example.com']);
  const cal: InviteCalendars = {
    store,
    me: () => new Set(me),
    schedules: () => !!opts.schedules,
    calendars: () => store.calendars().map((c) => ({ id: c.id, name: c.name, color: '#3b82f6', isDefault: !!c.is_default, role: c.role })),
    put: async (calendarId, href, raw) => { writes.push(`PUT ${href}`); store.putObject(calendarId, href, `"${writes.length}"`, raw, { me, zone: 'UTC' }); },
    remove: async (calendarId, href) => { writes.push(`DELETE ${href}`); store.deleteObject(calendarId, href); },
    hrefFor: (_c, uid) => `https://dav.example.com/cal/${encodeURIComponent(uid)}.ics`,
    now: () => NOW,
  };
  const parts = opts.parts ?? {};
  const mail: InviteMail = {
    identities: async () => [{ id: 'm1', email: opts.mailAddress ?? 'scott@example.com', displayName: 'Scott Persinger' }],
    part: async (_a, folder, uid, index) => {
      const text = parts[`${folder}/${uid}/${index}`];
      if (text === undefined) throw Object.assign(new Error('no such attachment'), { code: 'not_found' });
      const pdf = text.startsWith('%PDF');
      return { content: new TextEncoder().encode(text), mimeType: pdf ? 'application/pdf' : 'text/calendar', filename: pdf ? 'agenda.pdf' : 'invite.ics' };
    },
    send: async (account, m) => { if (opts.failSend) throw new Error('SMTP is down'); sent.push({ account, mail: m }); },
  };
  return { store, invites: new Invites(cal, mail), sent, writes };
}
const body = (uid: number, extra: Record<string, unknown> = {}) => ({ account: 'm1', messageId: `m1:INBOX:${uid}`, part: 0, ...extra });

describe('the invite routes', () => {
  it('reads an invitation not on a calendar yet, with the calendars it can go on', async () => {
    const { invites } = setup({ parts: { 'INBOX/1/0': fixture('invite-google-request.ics') } });
    const a = await invites.read(body(1));
    expect(a).toMatchObject({ action: 'request', onCalendar: null, organizerIsMe: false, calendars: [{ id: 'cal', name: 'Work', isDefault: true }] });
    expect(a.event).toMatchObject({ summary: 'Planning', start: '2026-11-05T15:00:00.000Z', end: '2026-11-05T16:00:00.000Z', timezone: 'America/New_York', myResponse: 'needs-action', location: 'Room 4' });
    expect(a.event.attendees).toHaveLength(3);
    await expect(invites.read({ account: 'm1', messageId: { folder: 'INBOX', uid: 1 }, part: 0 })).resolves.toMatchObject({ action: 'request' });
    await expect(invites.read(body(1, { account: 'other' }))).rejects.toThrow(/messageId|no such mail account/);
    await expect(invites.read({ account: 'm1', messageId: 'm1:INBOX:x', part: 0 })).rejects.toThrow(/messageId/);
  });

  it('accepting puts it on the default calendar with PARTSTAT=ACCEPTED and emails the REPLY where the server does not schedule', async () => {
    const { invites, store, sent, writes } = setup({ parts: { 'INBOX/1/0': fixture('invite-google-request.ics') } });
    const a = await invites.respond(body(1, { response: 'accepted' }));
    expect(writes).toEqual([`PUT https://dav.example.com/cal/${encodeURIComponent(GOOGLE_UID)}.ics`]);
    expect(a).toMatchObject({ replied: 'email', onCalendar: { calendarId: 'cal', myResponse: 'accepted', cancelled: false } });
    const obj = store.objectByUid('cal', GOOGLE_UID)!;
    expect(obj.raw).not.toMatch(/^METHOD/m);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ account: 'm1', mail: { method: 'REPLY', to: [{ address: 'ann@gmail.com', name: 'Ann Lee' }], subject: 'Accepted: Planning @ Thursday, November 5, 2026 · 10 – 11am (America/New_York)' } });
    expect(sent[0]!.mail.text).toContain('Scott Persinger has accepted the invitation to Planning.');
    expect(sent[0]!.mail.ics.replace(/\r\n /g, '')).toMatch(/PARTSTAT=ACCEPTED[^\r\n]*mailto:scott@example\.com/);
    // Asking again shows it on the calendar, answered; changing the answer writes the calendar's copy (with its etag).
    expect((await invites.read(body(1))).onCalendar).toMatchObject({ myResponse: 'accepted' });
    const again = await invites.respond(body(1, { response: 'tentative' }));
    expect(again.onCalendar?.myResponse).toBe('tentative');
    expect(writes).toHaveLength(2);
    expect(sent.at(-1)!.mail.subject).toMatch(/^Tentatively accepted: Planning/);
  });

  it('on a server that schedules (Google put it on the calendar already) only the PARTSTAT changes, and no mail goes', async () => {
    const { invites, store, sent } = setup({ schedules: true, parts: { 'INBOX/1/0': fixture('invite-google-request.ics') } });
    store.putObject('cal', 'https://dav.example.com/cal/google.ics', '"g"', fixture('invite-google-request.ics').replace('METHOD:REQUEST\r\n', ''), { me: ME, zone: 'UTC' });
    expect((await invites.read(body(1))).onCalendar).toMatchObject({ calendarId: 'cal', myResponse: 'needs-action' });
    const a = await invites.respond(body(1, { response: 'declined' }));
    expect(a).toMatchObject({ replied: 'server', onCalendar: { myResponse: 'declined' } });
    expect(store.objectByUid('cal', GOOGLE_UID)!.href).toBe('https://dav.example.com/cal/google.ics');
    expect(sent).toHaveLength(0);
  });

  it('a failed email does not undo the answer; the answer says so', async () => {
    const { invites } = setup({ failSend: true, parts: { 'INBOX/1/0': fixture('invite-google-request.ics') } });
    const a = await invites.respond(body(1, { response: 'accepted' }));
    expect(a).toMatchObject({ replied: 'failed', replyError: 'SMTP is down', onCalendar: { myResponse: 'accepted' } });
  });

  it('a cancellation removes the event, or one occurrence of a series (an EXDATE); a second time there is nothing to remove', async () => {
    const { invites, store, writes } = setup({ parts: { 'INBOX/1/0': fixture('invite-google-request.ics'), 'INBOX/2/0': fixture('invite-google-cancel.ics'), 'INBOX/3/0': fixture('invite-outlook-request.ics'), 'INBOX/4/0': fixture('invite-outlook-cancel-occurrence.ics') } });
    expect((await invites.read(body(2))).onCalendar).toBeNull();
    await invites.respond(body(1, { response: 'accepted' }));
    expect((await invites.read(body(2))).onCalendar).toMatchObject({ calendarId: 'cal' });
    await expect(invites.respond(body(2, { response: 'accepted' }))).rejects.toThrow(/cancellation/);
    expect(await invites.cancel(body(2))).toMatchObject({ removed: true, onCalendar: null });
    expect(writes.at(-1)).toMatch(/^DELETE /);
    expect(store.objectByUid('cal', GOOGLE_UID)).toBeNull();
    expect((await invites.cancel(body(2))).removed).toBe(false);
    // A series, and one of its occurrences cancelled.
    await invites.respond(body(3, { response: 'accepted' }));
    const occurrence = await invites.read(body(4));
    expect(occurrence).toMatchObject({ action: 'cancel', event: { recurrenceId: '20261117T170000Z' }, onCalendar: { id: `cal:${OUTLOOK_UID}:20261117T170000Z` } });
    expect((await invites.cancel(body(4))).removed).toBe(true);
    const left = store.list(['cal'], at('2026-11-09T00:00:00Z'), at('2026-11-25T00:00:00Z')).map((o) => o.start);
    expect(left).toEqual(['2026-11-10T17:00:00.000Z', '2026-11-24T17:00:00.000Z']);
    expect(store.objectByUid('cal', OUTLOOK_UID)!.raw).toMatch(/EXDATE/);
  });

  it('a reply says who answered, and that the person organized it', async () => {
    const { invites } = setup({ parts: { 'INBOX/5/0': fixture('invite-reply.ics') } });
    expect(await invites.read(body(5))).toMatchObject({ action: 'reply', organizerIsMe: true, reply: { email: 'ann@gmail.com', name: 'Ann Lee', response: 'accepted' } });
    await expect(invites.cancel(body(5))).rejects.toThrow(/not a cancellation/);
  });

  it('a part that is not an invitation, or not there, is refused', async () => {
    const { invites } = setup({ parts: { 'INBOX/6/0': '%PDF-1.4' } });
    await expect(invites.read(body(6))).rejects.toThrow(/not an invitation/);
    await expect(invites.read(body(7))).rejects.toThrow(/no such attachment/);
  });
});

describe('an organizer\'s invitations by email', () => {
  const ctx = { me: ['scott@example.com'], organizer: 'scott@example.com', displayName: 'Scott', zone: 'UTC', now: NOW };
  const withGuests = newEvent('e1', { summary: 'Lunch', start: '2026-11-06T17:00:00Z', end: '2026-11-06T18:00:00Z', attendees: [{ email: 'bo@example.org', name: 'Bo' }, { email: 'dana@example.org' }] }, ctx);

  it('a new event invites its guests; a change updates them and cancels for the one taken off; deleting cancels', async () => {
    const { invites, sent } = setup();
    expect(await invites.notify('cal', 'e1', null, withGuests)).toEqual({ invitationsSent: true });
    expect(sent[0]).toMatchObject({ account: 'm1', mail: { method: 'REQUEST', subject: 'Invitation: Lunch @ Friday, November 6, 2026 · 5 – 6pm (UTC)', to: [{ address: 'bo@example.org', name: 'Bo' }, { address: 'dana@example.org', name: '' }] } });
    expect(sent[0]!.mail.text).toContain('Scott Persinger has invited you to Lunch.');
    const fewer = newEvent('e1', { summary: 'Lunch', start: '2026-11-06T17:00:00Z', end: '2026-11-06T18:00:00Z', attendees: [{ email: 'bo@example.org', name: 'Bo' }] }, ctx);
    await invites.notify('cal', 'e1', withGuests, fewer);
    expect(sent.slice(1).map((s) => [s.mail.method, s.mail.to.map((t) => t.address).join(), s.mail.subject.split(':')[0]])).toEqual([['REQUEST', 'bo@example.org', 'Updated invitation'], ['CANCEL', 'dana@example.org', 'Cancelled']]);
    await invites.notify('cal', 'e1', fewer, null);
    expect(sent.at(-1)!.mail).toMatchObject({ method: 'CANCEL', to: [{ address: 'bo@example.org' }] });
    expect(sent.at(-1)!.mail.ics).toContain('STATUS:CANCELLED');
  });

  it('nothing for an event without guests, someone else\'s event, or a server that schedules; without a mail account for the address it says so', async () => {
    const { invites, sent } = setup();
    const alone = newEvent('e2', { summary: 'Focus', start: '2026-11-06T17:00:00Z', end: '2026-11-06T18:00:00Z' }, ctx);
    expect(await invites.notify('cal', 'e2', null, alone)).toBeNull();
    const theirs = fixture('invite-google-request.ics').replace('METHOD:REQUEST\r\n', '');
    expect(await invites.notify('cal', GOOGLE_UID, null, theirs)).toBeNull();
    expect(sent).toHaveLength(0);
    expect(await setup({ schedules: true }).invites.notify('cal', 'e1', null, withGuests)).toBeNull();
    expect(await setup({ mailAddress: 'someone@else.org' }).invites.notify('cal', 'e1', null, withGuests)).toEqual({ invitationsSent: false, invitationsNote: 'No mail account in Mail sends as scott@example.com, so the guests were not emailed.' });
  });

  it('deleting one occurrence of a series cancels that occurrence', async () => {
    const { invites, sent } = setup();
    const series = newEvent('e3', { summary: 'Standup', start: '2026-11-02T14:00:00Z', end: '2026-11-02T14:15:00Z', recurrence: ['RRULE:FREQ=DAILY;COUNT=5'], attendees: [{ email: 'bo@example.org' }] }, ctx);
    await invites.notify('cal', 'e3', series, series, { cancelRid: at('2026-11-04T14:00:00Z') });
    expect(sent[0]!.mail).toMatchObject({ method: 'CANCEL', subject: 'Cancelled: Standup @ Wednesday, November 4, 2026 · 2 – 2:15pm (UTC)' });
    expect(sent[0]!.mail.ics).toContain('RECURRENCE-ID:20261104T140000Z');
  });

  it('an RSVP made in Calendar on such a server emails the organizer', async () => {
    const { invites, sent } = setup();
    const theirs = respondTo(fixture('invite-google-request.ics').replace('METHOD:REQUEST\r\n', ''), GOOGLE_UID, 0, 'accepted', undefined, { ...ctx, organizer: null });
    expect(await invites.replied('cal', theirs, GOOGLE_UID, 0, 'accepted')).toEqual({ replied: 'email' });
    expect(sent[0]!.mail).toMatchObject({ method: 'REPLY', to: [{ address: 'ann@gmail.com' }] });
    expect(await invites.replied('cal', withGuests, 'e1', 0, 'accepted')).toEqual({ replied: 'none' });
  });
});
