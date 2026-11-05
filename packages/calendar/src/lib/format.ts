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
