// How times read in the popover, the agenda and the search results: "Thu, Nov 5 · 12:00 – 1:00 PM", an all-day span,
// an event across midnight; and the RSVP words.
import { addDays, format, isSameDay } from 'date-fns';
import type { EventOccurrence, Response } from '../api';
import { parseDate } from './ranges';

const time = (d: Date) => format(d, d.getMinutes() ? 'h:mm a' : 'h a').replace(':00 ', ' ');
function timeRange(a: Date, b: Date): string {
  const sameHalf = format(a, 'a') === format(b, 'a');
  const left = sameHalf ? time(a).replace(/ (AM|PM)$/, '') : time(a);
  return `${left} – ${time(b)}`;
}

export function whenText(o: Pick<EventOccurrence, 'start' | 'end' | 'allDay'>): string {
  if (o.allDay) {
    const s = parseDate(o.start);
    const last = addDays(parseDate(o.end), -1);
    if (+last <= +s) return `${format(s, 'EEEE, MMMM d')} · All day`;
    return `${format(s, 'EEE, MMM d')} – ${format(last, 'EEE, MMM d')} · All day`;
  }
  const s = new Date(o.start), e = new Date(o.end);
  if (isSameDay(s, e) || +e === +s) return `${format(s, 'EEEE, MMMM d')} · ${timeRange(s, e)}`;
  return `${format(s, 'EEE, MMM d')}, ${time(s)} – ${format(e, 'EEE, MMM d')}, ${time(e)}`;
}

/** A short time for a list row: "12:00 PM", or "All day". */
export const shortTime = (o: Pick<EventOccurrence, 'start' | 'allDay'>) => (o.allDay ? 'All day' : time(new Date(o.start)));

export const RESPONSE_LABEL: Record<Response, string> = { accepted: 'Going', tentative: 'Maybe', declined: 'Not going', 'needs-action': 'Not answered' };

/** The browser's zone, as an IANA name. */
/** The toast once an answer to an invitation is saved. */
export const RESPONDED_TEXT: Record<Exclude<Response, 'needs-action'>, string> = { accepted: 'Accepted', declined: 'Declined', tentative: 'Tentatively accepted' };

/** An occurrence with the person's own answer set (the popover shows it at once, before the server has it). */
export const withMyResponse = (o: EventOccurrence, response: Response): EventOccurrence => ({ ...o, myResponse: response, attendees: o.attendees.map((g) => (g.self ? { ...g, response } : g)) });

export const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

/** A zone's name with its offset now: "America/New_York (GMT-5)". */
export function zoneLabel(zone: string, at = new Date()): string {
  try {
    const off = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'shortOffset' }).formatToParts(at).find((p) => p.type === 'timeZoneName')?.value;
    return off ? `${zone.replace(/_/g, ' ')} (${off})` : zone;
  } catch {
    return zone;
  }
}

/** An instant's wall clock in a zone, as the dialog's date and time fields hold it. */
export function wallIn(iso: string, zone: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour') === '24' ? '00' : get('hour')}:${get('minute')}` };
}

/** Every zone the browser knows, for the dialog's list (the common ones when it cannot say). */
export function allZones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
  try {
    return intl.supportedValuesOf?.('timeZone') ?? [];
  } catch {
    return [];
  }
}

export const reminderText = (m: number) => (m === 0 ? 'At the start' : m % 1440 === 0 ? `${m / 1440} ${m === 1440 ? 'day' : 'days'} before` : m % 60 === 0 ? `${m / 60} ${m === 60 ? 'hour' : 'hours'} before` : `${m} minutes before`);

const clock = (d: Date) => format(d, 'h:mm');
const half = (d: Date) => format(d, 'aaa');
/**
 * The event card's "when", as Google's: "Thursday, November 5 · 10:00 – 11:00am" (am/pm once when both halves share it),
 * "Thursday, November 5" for a day, "Nov 5 – 7, 2026" for days, and a timed event across days with both dates.
 */
export function cardWhen(o: Pick<EventOccurrence, 'start' | 'end' | 'allDay'>): string {
  if (o.allDay) {
    const s = parseDate(o.start);
    const last = addDays(parseDate(o.end), -1);
    if (+last <= +s) return format(s, 'EEEE, MMMM d');
    if (s.getFullYear() !== last.getFullYear()) return `${format(s, 'MMM d, yyyy')} – ${format(last, 'MMM d, yyyy')}`;
    if (s.getMonth() !== last.getMonth()) return `${format(s, 'MMM d')} – ${format(last, 'MMM d, yyyy')}`;
    return `${format(s, 'MMM d')} – ${format(last, 'd, yyyy')}`;
  }
  const s = new Date(o.start), e = new Date(o.end);
  if (+e === +s) return `${format(s, 'EEEE, MMMM d')} · ${clock(s)}${half(s)}`;
  if (isSameDay(s, e) || (+e - +s < 86_400_000 && e.getHours() === 0 && e.getMinutes() === 0)) {
    return `${format(s, 'EEEE, MMMM d')} · ${clock(s)}${half(s) === half(e) ? '' : half(s)} – ${clock(e)}${half(e)}`;
  }
  return `${format(s, 'MMM d')}, ${clock(s)}${half(s)} – ${format(e, 'MMM d')}, ${clock(e)}${half(e)}`;
}

/** The card's guests: the organizer first, the person second, the rest as the event lists them; each once. */
export function orderedGuests(o: Pick<EventOccurrence, 'organizer' | 'attendees'>): (EventOccurrence['attendees'][number] & { organizer?: true })[] {
  const byEmail = new Map<string, EventOccurrence['attendees'][number] & { organizer?: true }>();
  if (o.organizer) {
    const asGuest = o.attendees.find((a) => a.email === o.organizer!.email);
    byEmail.set(o.organizer.email, { ...o.organizer, ...asGuest, name: asGuest?.name ?? o.organizer.name, organizer: true });
  }
  for (const a of o.attendees) if (!byEmail.has(a.email)) byEmail.set(a.email, a);
  const all = [...byEmail.values()];
  const rank = (a: (typeof all)[number]) => (a.organizer ? 0 : a.self ? 1 : 2);
  return all.map((a, i) => [a, i] as const).sort((x, y) => rank(x[0]) - rank(y[0]) || x[1] - y[1]).map(([a]) => a);
}

/** "5 yes, 2 no, 1 maybe, 4 awaiting", zeros left out. */
export function guestSummary(guests: Pick<EventOccurrence['attendees'][number], 'response'>[]): string {
  const n = (r: string) => guests.filter((g) => g.response === r).length;
  return [[n('accepted'), 'yes'], [n('declined'), 'no'], [n('tentative'), 'maybe'], [n('needs-action'), 'awaiting']].filter(([c]) => c).map(([c, w]) => `${c} ${w}`).join(', ');
}

/** An attendee's name when the invitation has one that is not just the address again. */
export const guestName = (a: { name: string | null; email: string }) => (a.name && a.name.trim().toLowerCase() !== a.email.toLowerCase() ? a.name.trim() : null);
