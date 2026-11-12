// The guest scheduler's rules that need no storage (docs/specs/guest-scheduler.md §3): the booking page's settings and
// their defaults, the public link's token, and the open slots of a window. The Calendar object (object.ts) keeps the page
// and its bookings and passes in the busy time it reads from its own cache; nothing here talks to a server.
import { z } from 'zod';
import { badRequest } from './rules';
import { utcToWall, wallToUtc } from './tz';

export const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type Weekday = (typeof WEEKDAYS)[number];
/** The meeting lengths a page may offer, in minutes. */
export const LENGTHS = [15, 30, 45, 60, 90] as const;

/** A booking page's settings. Times of day are minutes from midnight in `timezone`; `weekly` ranges are [start, end). */
export interface SchedulerConfig {
  enabled: boolean;
  title: string;
  description: string;
  durations: number[];
  defaultDuration: number;
  timezone: string;
  weekly: Record<Weekday, [number, number][]>;
  minNoticeMin: number;
  horizonDays: number;
  bufferBeforeMin: number;
  bufferAfterMin: number;
  /** Bookings from this page per day (in the page's zone); null for no limit. */
  maxPerDay: number | null;
  /** How far apart start times are; null for the shortest length, at most 30. */
  incrementMin: number | null;
  /** The calendars whose events make time busy; null for every calendar shown. */
  busyCalendarIds: string[] | null;
  /** Where bookings go; null for the default calendar. */
  targetCalendarId: string | null;
  location: { kind: 'text' | 'none'; value: string };
}

const WORKDAY: [number, number][] = [[9 * 60, 17 * 60]];
/** Monday to Friday, 9:00 to 17:00, 30 minutes, in the owner's zone; off until the owner turns it on. */
export function defaultConfig(timezone: string): SchedulerConfig {
  return {
    enabled: false, title: '30 Minute Meeting', description: '', durations: [30], defaultDuration: 30, timezone,
    weekly: { sun: [], mon: WORKDAY, tue: WORKDAY, wed: WORKDAY, thu: WORKDAY, fri: WORKDAY, sat: [] },
    minNoticeMin: 4 * 60, horizonDays: 60, bufferBeforeMin: 0, bufferAfterMin: 0, maxPerDay: null, incrementMin: null,
    busyCalendarIds: null, targetCalendarId: null, location: { kind: 'none', value: '' },
  };
}

const Range = z.tuple([z.number().int().min(0).max(1440), z.number().int().min(0).max(1440)]);
export const ConfigPatch = z.object({
  enabled: z.boolean(),
  title: z.string().trim().min(1).max(120),
  description: z.string().max(2000),
  durations: z.array(z.number().int().refine((n) => (LENGTHS as readonly number[]).includes(n), 'a length of 15, 30, 45, 60 or 90 minutes')).min(1).max(LENGTHS.length),
  defaultDuration: z.number().int(),
  timezone: z.string().min(1).max(100),
  weekly: z.object(Object.fromEntries(WEEKDAYS.map((d) => [d, z.array(Range).max(6)])) as Record<Weekday, z.ZodArray<typeof Range>>).partial().strict(),
  minNoticeMin: z.number().int().min(0).max(30 * 24 * 60),
  horizonDays: z.number().int().min(1).max(365),
  bufferBeforeMin: z.number().int().min(0).max(240),
  bufferAfterMin: z.number().int().min(0).max(240),
  maxPerDay: z.number().int().min(1).max(50).nullable(),
  incrementMin: z.number().int().refine((n) => [5, 10, 15, 20, 30, 60].includes(n), 'every 5, 10, 15, 20, 30 or 60 minutes').nullable(),
  busyCalendarIds: z.array(z.string().min(1).max(100)).max(100).nullable(),
  targetCalendarId: z.string().min(1).max(100).nullable(),
  location: z.object({ kind: z.enum(['text', 'none']), value: z.string().max(500) }),
}).partial().strict();

/**
 * The settings with a patch applied, checked as a whole: lengths sorted and unique, the default one of them, each day's
 * ranges inside the day, not empty and not overlapping (sorted), and the zone one the runtime knows.
 */
export function applyPatch(current: SchedulerConfig, patch: z.infer<typeof ConfigPatch>): SchedulerConfig {
  const next: SchedulerConfig = { ...current, ...patch, location: patch.location ?? current.location, weekly: { ...current.weekly, ...(patch.weekly ?? {}) } };
  next.durations = [...new Set(next.durations)].sort((a, b) => a - b);
  if (patch.durations && patch.defaultDuration === undefined && !next.durations.includes(next.defaultDuration)) next.defaultDuration = next.durations[0]!;
  if (!next.durations.includes(next.defaultDuration)) throw badRequest('defaultDuration: one of the lengths offered');
  try { new Intl.DateTimeFormat('en-US', { timeZone: next.timezone }); } catch { throw badRequest('timezone: not a time zone this server knows'); }
  for (const d of WEEKDAYS) {
    const ranges = [...next.weekly[d]].sort((a, b) => a[0] - b[0]);
    for (const [i, [a, b]] of ranges.entries()) {
      if (b <= a) throw badRequest(`weekly.${d}: a range must end after it starts`);
      if (i > 0 && a < ranges[i - 1]![1]) throw badRequest(`weekly.${d}: the ranges overlap`);
    }
    next.weekly[d] = ranges;
  }
  if (next.location.kind === 'none') next.location = { kind: 'none', value: '' };
  else if (!next.location.value.trim()) throw badRequest('location.value: required for a text location');
  return next;
}

// ---- the public link's token -------------------------------------------------------------------------------------

/** Crockford's base32 in lower case: no i, l, o or u, so a token read aloud or retyped is not misread. */
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

/** A new page token: 12 characters (60 bits) in three groups, `k7mq-x3vd-p9tr`. */
export function newPageToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const chars = [...bytes].map((b) => ALPHABET[b & 31]).join('');
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8)}`;
}

/** A page token as typed, in its one form (no dashes, lower case; i and l read as 1, o as 0), or null for none. */
export function normalizePageToken(raw: string): string | null {
  const t = raw.trim().toLowerCase().replace(/[-\s]/g, '').replace(/[il]/g, '1').replace(/o/g, '0');
  return /^[0-9a-hjkmnp-tv-z]{12}$/.test(t) ? t : null;
}

/** A booking's own link (sent to its guest only, never typed): 16 random bytes, base64url. */
export const newManageToken = () => Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString('base64url');
export const isManageToken = (t: string) => /^[A-Za-z0-9_-]{22}$/.test(t);

export async function sha256(text: string): Promise<string> {
  return Buffer.from(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))).toString('hex');
}

// ---- dates and slots ---------------------------------------------------------------------------------------------

export type Interval = [number, number];
const pad = (n: number) => String(n).padStart(2, '0');
/** The date (YYYY-MM-DD) an instant falls on in a zone. */
export const dateIn = (ms: number, zone: string) => { const w = utcToWall(ms, zone); return `${w.y}-${pad(w.mo)}-${pad(w.d)}`; };
/** The instant a date's wall-clock minute names in a zone (minute 1440 is the next midnight). */
export function atMinute(date: string, minute: number, zone: string): number {
  const [y, mo, d] = date.split('-').map(Number) as [number, number, number];
  const day = new Date(Date.UTC(y, mo - 1, d + Math.floor(minute / 1440)));
  const m = minute % 1440;
  return wallToUtc({ y: day.getUTCFullYear(), mo: day.getUTCMonth() + 1, d: day.getUTCDate(), h: Math.floor(m / 60), mi: m % 60, s: 0 }, zone);
}
const nextDate = (date: string) => { const [y, mo, d] = date.split('-').map(Number) as [number, number, number]; const n = new Date(Date.UTC(y, mo - 1, d + 1)); return `${n.getUTCFullYear()}-${pad(n.getUTCMonth() + 1)}-${pad(n.getUTCDate())}`; };
const weekdayOf = (date: string) => WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()]!;
export const isDate = (s: string) => /^\d{4}-\d\d-\d\d$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));

/** An occurrence as the busy time needs it (store.ts EventOccurrence's fields). */
export interface BusySource { eventId: string; start: string; end: string; allDay: boolean; transparent?: true; status: string; myResponse?: string | null }

/**
 * Busy intervals from a calendar's occurrences, merged: every event that is not free (transparent), cancelled or declined.
 * An all-day event covers its dates in the page's zone, not in UTC. `except` leaves one event out (a booking being moved).
 */
export function busyOf(occurrences: BusySource[], zone: string, except?: string | null): Interval[] {
  const spans = occurrences
    .filter((o) => !o.transparent && o.status !== 'cancelled' && o.myResponse !== 'declined' && o.eventId !== except)
    .map((o): Interval => (o.allDay ? [atMinute(o.start.slice(0, 10), 0, zone), atMinute(o.end.slice(0, 10), 0, zone)] : [Date.parse(o.start), Date.parse(o.end)]))
    .filter(([a, b]) => b > a)
    .sort((a, b) => a[0] - b[0]);
  const merged: Interval[] = [];
  for (const [a, b] of spans) {
    const last = merged.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  return merged;
}

export interface SlotQuery {
  now: number;
  /** The window asked about: starts in [from, to). */
  from: number;
  to: number;
  duration: number;
  /** Merged and sorted (busyOf). */
  busy: Interval[];
  /** Bookings from this page per date in the page's zone, for `maxPerDay`. */
  bookedOn?: Map<string, number>;
}

/** How far apart start times are: the page's step, else the shortest length, at most 30 minutes. */
export const stepOf = (c: SchedulerConfig) => c.incrementMin ?? Math.min(30, ...c.durations);

/** The latest instant a meeting may end: the end of the page's day `horizonDays` from today, in its zone. */
export const horizonEnd = (c: SchedulerConfig, now: number) => atMinute(dateIn(now + c.horizonDays * DAY, c.timezone), 1440, c.timezone);

/**
 * The open start times in a window: each day's weekly ranges in the page's zone, stepped from each range's start; a start
 * is open when the meeting fits in its range, starts after now plus the notice, ends by the horizon, and neither it nor its
 * buffers touch busy time, on a day that has not had its most bookings.
 */
export function openSlots(c: SchedulerConfig, q: SlotQuery): number[] {
  const zone = c.timezone, dur = q.duration * MINUTE, step = stepOf(c) * MINUTE;
  const earliest = Math.max(q.from, q.now + c.minNoticeMin * MINUTE), lastEnd = horizonEnd(c, q.now);
  const before = c.bufferBeforeMin * MINUTE, after = c.bufferAfterMin * MINUTE;
  const out: number[] = [];
  let b = 0;
  // A day's ranges may start the evening before in UTC: begin a day early, stop a day late.
  for (let date = dateIn(q.from - DAY, zone), stop = dateIn(q.to + DAY, zone); date <= stop; date = nextDate(date)) {
    if (c.maxPerDay !== null && (q.bookedOn?.get(date) ?? 0) >= c.maxPerDay) continue;
    for (const [rs, re] of c.weekly[weekdayOf(date)]) {
      const start = atMinute(date, rs, zone), end = atMinute(date, re, zone);
      for (let s = start; s + dur <= end; s += step) {
        if (s < earliest || s >= q.to || s + dur > lastEnd) continue;
        const lo = s - before, hi = s + dur + after;
        while (b > 0 && q.busy[b - 1]![1] > lo) b--;
        while (b < q.busy.length && q.busy[b]![1] <= lo) b++;
        if (b < q.busy.length && q.busy[b]![0] < hi) continue;
        out.push(s);
      }
    }
  }
  return out.sort((x, y) => x - y);
}

/** The instants a month spans in a zone: `2026-11` → [Nov 1 00:00, Dec 1 00:00). */
export function monthWindow(month: string, zone: string): Interval {
  const m = /^(\d{4})-(\d\d)$/.exec(month);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) throw badRequest('month: YYYY-MM');
  const y = Number(m[1]), mo = Number(m[2]);
  const next = mo === 12 ? `${y + 1}-01-01` : `${y}-${pad(mo + 1)}-01`;
  return [atMinute(`${month}-01`, 0, zone), atMinute(next, 0, zone)];
}

/** The dates (in the guest's zone) that have at least one open start. */
export function daysWithSlots(slots: number[], zone: string): string[] {
  return [...new Set(slots.map((s) => dateIn(s, zone)))];
}

/** A zone the guest asked for, when the runtime knows it; else the page's. */
export function guestZone(asked: string | undefined | null, fallback: string): string {
  if (!asked) return fallback;
  try { new Intl.DateTimeFormat('en-US', { timeZone: asked }); return asked; } catch { return fallback; }
}

/** A booking's request body. `website` is the form's hidden field: a person leaves it empty. */
export const BookingBody = z.object({
  start: z.string().trim().min(10).max(40),
  duration: z.number().int(),
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().email().max(320),
  note: z.string().max(2000).optional(),
  tz: z.string().max(100).optional(),
  website: z.string().max(200).optional(),
});
export const RescheduleBody = z.object({ start: z.string().trim().min(10).max(40), duration: z.number().int(), tz: z.string().max(100).optional() });
