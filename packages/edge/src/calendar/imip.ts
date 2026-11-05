// Invitations by email (iMIP, RFC 6047) for calendar servers that do not schedule themselves (docs/specs/calendar.md §2.8,
// §14): Radicale and most self-hosted ones. Google, iCloud and Fastmail send and process invitations on their own, so
// nothing here runs for them. The Calendar object decides what goes (an answer to the organizer, or an organizer's
// invitation, update or cancellation to the guests) and hands the Mail object a `CalendarMail`; the Mail object checks it
// (`checkCalendarMail`) and sends it from the person's own mail account through its SMTP, as one message with the
// iCalendar both as a `text/calendar; method=…` alternative and as `invite.ics` (nodemailer's `icalEvent`, Google's shape).
// Pure: imip.test.ts compiles the MIME.
import type Mail from 'nodemailer/lib/mailer';
import { outgoingMessage } from '../imap/drafts';
import type { ItipMethod, Response } from './ical';
import { badRequest } from './rules';

export interface MailAddress { name: string; address: string }
/** One iMIP message, as the Calendar object prepares it for the Mail object to send. */
export interface CalendarMail { method: ItipMethod; to: MailAddress[]; subject: string; text: string; ics: string }

/** The most guests one message goes to, and the largest iCalendar it carries. */
export const MAX_GUESTS = 100;
export const MAX_ICS_BYTES = 256 * 1024;

const ANSWERED: Record<Exclude<Response, 'needs-action'>, { word: string; verb: string }> = {
  accepted: { word: 'Accepted', verb: 'has accepted' },
  declined: { word: 'Declined', verb: 'has declined' },
  tentative: { word: 'Tentatively accepted', verb: 'has tentatively accepted' },
};

const clock = (d: Date, zone: string) => {
  const parts = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: zone }).formatToParts(d);
  const hour = parts.find((p) => p.type === 'hour')?.value ?? '';
  const minute = parts.find((p) => p.type === 'minute')?.value ?? '00';
  const half = (parts.find((p) => p.type === 'dayPeriod')?.value ?? '').toLowerCase();
  return { text: minute === '00' ? hour : `${hour}:${minute}`, half };
};
const dayText = (d: Date, zone: string) => new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: zone }).format(d);

/**
 * When an event is, for a message's subject and text: "Thursday, November 5, 2026 · 12 – 1pm (America/New_York)", the half
 * of the day once when both times share it; "Thursday, November 5, 2026" for a day; two days for one that spans them.
 */
export function whenText(start: number, end: number, allDay: boolean, zone: string | null): string {
  if (allDay) {
    const last = end - 86_400_000;
    const first = dayText(new Date(start), 'UTC');
    return last > start ? `${first} – ${dayText(new Date(last), 'UTC')}` : first;
  }
  const z = zone && zone !== 'UTC' ? zone : 'UTC';
  const s = new Date(start), e = new Date(end);
  const a = clock(s, z), b = clock(e, z);
  const sameDay = dayText(s, z) === dayText(e, z);
  const span = sameDay ? `${dayText(s, z)} · ${a.text}${a.half === b.half ? '' : a.half} – ${b.text}${b.half}` : `${dayText(s, z)} ${a.text}${a.half} – ${dayText(e, z)} ${b.text}${b.half}`;
  return `${span} (${z})`;
}

const nameOf = (p: { name?: string | null; email: string }) => p.name?.trim() || p.email;

/** The answer to an invitation, to its organizer: "Ann Lee has accepted the invitation to Lunch". */
export function replyMail(o: { me: { name: string; email: string }; organizer: { name: string | null; email: string }; response: Exclude<Response, 'needs-action'>; summary: string; when: string; ics: string }): CalendarMail {
  const a = ANSWERED[o.response];
  const title = o.summary || 'an event';
  return {
    method: 'REPLY', to: [{ name: o.organizer.name ?? '', address: o.organizer.email }],
    subject: `${a.word}: ${title} @ ${o.when}`,
    text: `${nameOf(o.me)} ${a.verb} the invitation to ${title}.\n\n${title}\n${o.when}\n`,
    ics: o.ics,
  };
}

/** An organizer's invitation (or its update) to the guests, with what, when, where and who. */
export function requestMail(o: { organizer: { name: string; email: string }; to: { email: string; name: string | null }[]; summary: string; when: string; location: string | null; description: string | null; update: boolean; ics: string }): CalendarMail {
  const title = o.summary || '(no title)';
  const lines = [
    `${nameOf(o.organizer)} ${o.update ? 'updated the invitation to' : 'has invited you to'} ${title}.`, '',
    `When: ${o.when}`, ...(o.location ? [`Where: ${o.location}`] : []),
    `Guests: ${[nameOf(o.organizer), ...o.to.map(nameOf)].join(', ')}`,
    ...(o.description ? ['', o.description] : []),
    '', 'Answer from your calendar or mail app to say whether you are coming.',
  ];
  return { method: 'REQUEST', to: o.to.map((g) => ({ name: g.name ?? '', address: g.email })), subject: `${o.update ? 'Updated invitation' : 'Invitation'}: ${title} @ ${o.when}`, text: `${lines.join('\n')}\n`, ics: o.ics };
}

/** An organizer's cancellation of an event (or of one occurrence) to the guests. */
export function cancelMail(o: { organizer: { name: string; email: string }; to: { email: string; name: string | null }[]; summary: string; when: string; ics: string }): CalendarMail {
  const title = o.summary || '(no title)';
  return {
    method: 'CANCEL', to: o.to.map((g) => ({ name: g.name ?? '', address: g.email })), subject: `Cancelled: ${title} @ ${o.when}`,
    text: `${nameOf(o.organizer)} has cancelled ${title}.\n\n${title}\n${o.when}\n`, ics: o.ics,
  };
}

const ADDRESS = /^[^\s@<>"]+@[^\s@<>"]+$/;
/**
 * What the Mail object sends for the Calendar object, checked: one of the three methods, its iCalendar saying that METHOD,
 * 1–MAX_GUESTS plain addresses, a subject and text of a sane length. This is the only way the Calendar object sends mail,
 * and it is a binding (RPC), never a route.
 */
export function checkCalendarMail(m: CalendarMail): CalendarMail {
  if (m.method !== 'REQUEST' && m.method !== 'REPLY' && m.method !== 'CANCEL') throw badRequest('method: REQUEST, REPLY or CANCEL');
  if (!Array.isArray(m.to) || !m.to.length || m.to.length > MAX_GUESTS || m.to.some((a) => typeof a?.address !== 'string' || !ADDRESS.test(a.address) || a.address.length > 320)) throw badRequest('to: 1 to 100 addresses');
  if (typeof m.ics !== 'string' || new TextEncoder().encode(m.ics).length > MAX_ICS_BYTES || !/^BEGIN:VCALENDAR\r?\n/.test(m.ics) || !new RegExp(`^METHOD:${m.method}\\r?$`, 'm').test(m.ics)) throw badRequest('ics: an iCalendar with that METHOD');
  if (typeof m.subject !== 'string' || m.subject.length > 1000 || typeof m.text !== 'string' || m.text.length > 40_000) throw badRequest('subject or text: too long');
  return { method: m.method, to: m.to.map((a) => ({ name: String(a.name ?? '').slice(0, 200), address: a.address })), subject: m.subject.replace(/[\r\n]+/g, ' '), text: m.text, ics: m.ics };
}

/** The nodemailer message for a CalendarMail, from the person's mail account. */
export function calendarMessage(from: { email: string; displayName: string }, mail: CalendarMail, now = new Date()): Mail.Options & { messageId: string } {
  const base = outgoingMessage(from, { to: mail.to, subject: mail.subject, html: '', text: mail.text }, [], now);
  const { html: _html, ...rest } = base;
  return { ...rest, icalEvent: { method: mail.method, filename: 'invite.ics', content: mail.ics } };
}
