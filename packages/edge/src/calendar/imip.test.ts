import { describe, expect, it } from 'vitest';
import PostalMime from 'postal-mime';
import { compileMime } from '../imap/drafts';
import { calendarMessage, cancelMail, checkCalendarMail, replyMail, requestMail, whenText } from './imip';

const at = (iso: string) => Date.parse(iso);
const ics = (method: string) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//FreeFlow//Calendar 1.0//EN\r\nMETHOD:${method}\r\nBEGIN:VEVENT\r\nUID:x\r\nDTSTAMP:20261105T120000Z\r\nDTSTART:20261105T150000Z\r\nSUMMARY:Planning\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;

describe('the words of an iMIP message', () => {
  it('says when in the event\'s zone, the half of the day once, and a day as a date', () => {
    expect(whenText(at('2026-11-05T15:00:00Z'), at('2026-11-05T16:00:00Z'), false, 'America/New_York')).toBe('Thursday, November 5, 2026 · 10 – 11am (America/New_York)');
    expect(whenText(at('2026-11-05T16:30:00Z'), at('2026-11-05T18:00:00Z'), false, 'America/New_York')).toBe('Thursday, November 5, 2026 · 11:30am – 1pm (America/New_York)');
    expect(whenText(at('2026-11-05T00:00:00Z'), at('2026-11-06T00:00:00Z'), true, null)).toBe('Thursday, November 5, 2026');
    expect(whenText(at('2026-11-05T00:00:00Z'), at('2026-11-08T00:00:00Z'), true, null)).toBe('Thursday, November 5, 2026 – Saturday, November 7, 2026');
  });

  it('a reply tells the organizer who answered what; an invitation lists what, when, where and who', () => {
    const r = replyMail({ me: { name: 'Scott Persinger', email: 'scott@example.com' }, organizer: { name: 'Ann Lee', email: 'ann@gmail.com' }, response: 'accepted', summary: 'Planning', when: 'Thursday', ics: ics('REPLY') });
    expect(r).toMatchObject({ method: 'REPLY', to: [{ name: 'Ann Lee', address: 'ann@gmail.com' }], subject: 'Accepted: Planning @ Thursday' });
    expect(r.text).toContain('Scott Persinger has accepted the invitation to Planning.');
    expect(replyMail({ me: { name: '', email: 'scott@example.com' }, organizer: { name: null, email: 'ann@gmail.com' }, response: 'tentative', summary: 'Planning', when: 'Thursday', ics: '' }).text).toContain('scott@example.com has tentatively accepted');
    const q = requestMail({ organizer: { name: 'Scott', email: 'scott@example.com' }, to: [{ email: 'bo@example.org', name: 'Bo' }], summary: 'Lunch', when: 'Friday', location: 'Cafe', description: 'Bring ideas', update: false, ics: ics('REQUEST') });
    expect(q.subject).toBe('Invitation: Lunch @ Friday');
    expect(q.text).toContain('Scott has invited you to Lunch.');
    expect(q.text).toContain('Where: Cafe');
    expect(q.text).toContain('Guests: Scott, Bo');
    expect(requestMail({ ...{ organizer: { name: 'Scott', email: 's@x' }, to: [], summary: 'Lunch', when: 'Friday', location: null, description: null, ics: '' }, update: true }).subject).toBe('Updated invitation: Lunch @ Friday');
    expect(cancelMail({ organizer: { name: 'Scott', email: 's@x' }, to: [{ email: 'bo@example.org', name: null }], summary: 'Lunch', when: 'Friday', ics: '' })).toMatchObject({ method: 'CANCEL', subject: 'Cancelled: Lunch @ Friday', to: [{ name: '', address: 'bo@example.org' }] });
  });
});

describe('the iMIP MIME', () => {
  it('is the text, the iCalendar as a text/calendar alternative with its method, and invite.ics', async () => {
    const mail = replyMail({ me: { name: 'Scott', email: 'scott@example.com' }, organizer: { name: 'Ann Lee', email: 'ann@gmail.com' }, response: 'declined', summary: 'Planning', when: 'Thursday', ics: ics('REPLY') });
    const message = calendarMessage({ email: 'scott@example.com', displayName: 'Scott' }, checkCalendarMail(mail), new Date('2026-11-05T12:00:00Z'));
    const raw = (await compileMime(message, false)).toString('latin1');
    expect(raw).toMatch(/^From: Scott <scott@example\.com>/m);
    expect(raw).toMatch(/^To: Ann Lee <ann@gmail\.com>/m);
    expect(raw).toMatch(/^Subject: Declined: Planning @ Thursday/m);
    expect(raw).toMatch(/Content-Type: multipart\/alternative/);
    expect(raw).toMatch(/Content-Type: text\/calendar; charset=utf-8; method=REPLY/i);
    expect(raw).toMatch(/Content-Type: application\/ics; name=invite\.ics/i);
    expect(raw).toMatch(/Content-Disposition: attachment; filename=invite\.ics/i);
    expect(raw).not.toMatch(/text\/html/);
    // Read back as a mail client reads it: the text, and the calendar part with its METHOD.
    const parsed = await PostalMime.parse(raw);
    expect(parsed.text).toContain('Scott has declined the invitation to Planning.');
    const cal = parsed.attachments.find((a) => a.mimeType === 'text/calendar');
    expect(cal).toBeTruthy();
    expect(new TextDecoder().decode(cal!.content as ArrayBuffer)).toContain('METHOD:REPLY');
  });

  it('refuses what is not an invitation, a reply or a cancellation for 1 to 100 addresses', () => {
    const ok = { method: 'REQUEST' as const, to: [{ name: 'Bo', address: 'bo@example.org' }], subject: 'S', text: 'T', ics: ics('REQUEST') };
    expect(checkCalendarMail(ok).to).toEqual(ok.to);
    expect(() => checkCalendarMail({ ...ok, method: 'PUBLISH' as never })).toThrow(/method/);
    expect(() => checkCalendarMail({ ...ok, ics: ics('CANCEL') })).toThrow(/ics/);
    expect(() => checkCalendarMail({ ...ok, ics: 'hello' })).toThrow(/ics/);
    expect(() => checkCalendarMail({ ...ok, to: [] })).toThrow(/to/);
    expect(() => checkCalendarMail({ ...ok, to: [{ name: '', address: 'not an address' }] })).toThrow(/to/);
    expect(() => checkCalendarMail({ ...ok, to: Array.from({ length: 101 }, (_, i) => ({ name: '', address: `g${i}@x.org` })) })).toThrow(/to/);
    expect(checkCalendarMail({ ...ok, subject: 'a\r\nBcc: evil@x' }).subject).toBe('a Bcc: evil@x');
  });
});
