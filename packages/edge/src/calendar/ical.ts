// iCalendar for FreeFlow Calendar (docs/specs/calendar.md §3, "Listing a window"): a calendar object resource as the
// server stores it, read into the rows the Calendar object lists from (one per VEVENT: the master or plain event, and
// each exception, RECURRENCE-ID), occurrences of a recurring event expanded over a window, and the edits the API makes
// (a new event, a patch to one occurrence, to this and following, to all, an EXDATE, an RSVP), written back as iCalendar.
// Parsing and the recurrence rules are ical.js's; times in a named zone are converted by tz.ts (the runtime's Intl), so an
// object without its VTIMEZONEs (Google drops them) still lands at the right instant. Pure: object.ts and store.ts use it.
import ICAL from 'ical.js';
import { badRequest } from './rules';
import { ianaOf, utcToWall, vtimezone, wallMs, wallOf, wallToUtc, type Wall } from './tz';

type Component = InstanceType<typeof ICAL.Component>;
type Property = InstanceType<typeof ICAL.Property>;
type Time = InstanceType<typeof ICAL.Time>;
type Timezone = InstanceType<typeof ICAL.Timezone>;

export const DAY_MS = 86_400_000;
/** "Recurs forever": recur_until for a series with no end (SQL compares it as a number; the largest Date). */
export const FOREVER = 8_640_000_000_000_000;
/** A single event longer than this is listed by its own query (kind 2), so the window's index range stays short. */
export const LONG_MS = 14 * DAY_MS;
/** Occurrences a series is walked at most, per window (a safety net; the fast-forward keeps real ones far below). */
const ITERATION_CAP = 50_000;
/** How far a COUNT series is walked to find its last occurrence before it is taken as endless. */
const COUNT_WALK_CAP = 5_000;

export type Response = 'accepted' | 'declined' | 'tentative' | 'needs-action';
export interface Attendee { name: string | null; email: string; role: 'required' | 'optional'; response: Response; self?: true }
/** What the API shows of a VEVENT, kept as JSON on its row so a list never parses iCalendar for a plain event. */
export interface EventData {
  summary: string; location: string | null; description: string | null; allDay: boolean; timezone: string | null;
  status: 'confirmed' | 'tentative' | 'cancelled'; organizer: Attendee | null; attendees: Attendee[]; myResponse?: Response;
  conference?: { url: string; label: string }; updated: string; sequence: number; reminders: number[]; recurrence: string[];
  /** TRANSP:TRANSPARENT: shown, but not busy time. */
  transparent?: true;
}
/**
 * How a time property is written: a date, UTC, a named zone (IANA, or one only the object's VTIMEZONE knows, kept as
 * text), or floating (read in the calendar's zone, `iana`).
 */
export type Form = { kind: 'date' } | { kind: 'utc' } | { kind: 'zone'; tzid: string; iana: string | null; vtz?: string } | { kind: 'floating'; iana: string };
/** A series' rules, kept as JSON on the master's row: enough to expand it without parsing the object again. */
export interface Rules { start: Wall; form: Form; durationMs: number; rrules: string[]; rdates: number[]; exdates: number[] }
/** One VEVENT as a row: `rid` is its RECURRENCE-ID's instant (0 for a master or a plain event). */
export interface ParsedEvent {
  uid: string; rid: number; kind: 0 | 1 | 2; startUtc: number; endUtc: number; recurUntil: number;
  data: EventData; rules: Rules | null; search: string;
}

// ---- zones --------------------------------------------------------------------------------------------------------

const vtzCache = new Map<string, Timezone>();
function vtzOf(text: string): Timezone {
  let tz = vtzCache.get(text);
  if (!tz) {
    tz = new ICAL.Timezone(ICAL.Component.fromString(text));
    if (vtzCache.size > 200) vtzCache.clear();
    vtzCache.set(text, tz);
  }
  return tz;
}
const timeWall = (t: Time): Wall => ({ y: t.year, mo: t.month, d: t.day, h: t.isDate ? 0 : t.hour, mi: t.isDate ? 0 : t.minute, s: t.isDate ? 0 : t.second });
const isUtcTime = (t: Time) => (t.zone as { tzid?: string } | undefined)?.tzid === 'UTC';

/** The instant a wall-clock time names in a form. */
export function toUtc(w: Wall, form: Form): number {
  switch (form.kind) {
    case 'date': return Date.UTC(w.y, w.mo - 1, w.d);
    case 'utc': return wallMs(w);
    case 'floating': return wallToUtc(w, form.iana);
    case 'zone':
      if (form.iana) return wallToUtc(w, form.iana);
      if (form.vtz) return new ICAL.Time({ year: w.y, month: w.mo, day: w.d, hour: w.h, minute: w.mi, second: w.s, isDate: false }, vtzOf(form.vtz)).toUnixTime() * 1000;
      return wallMs(w);
  }
}
/** The wall-clock time of an instant in a form (a date form: its UTC date). */
export function fromUtc(ms: number, form: Form): Wall {
  switch (form.kind) {
    case 'date': { const w = wallOf(ms); return { ...w, h: 0, mi: 0, s: 0 }; }
    case 'utc': return wallOf(ms);
    case 'floating': return utcToWall(ms, form.iana);
    case 'zone':
      if (form.iana) return utcToWall(ms, form.iana);
      if (form.vtz) return timeWall(ICAL.Time.fromJSDate(new Date(ms), true).convertToZone(vtzOf(form.vtz)));
      return wallOf(ms);
  }
}
/** An ICAL.Time of a wall-clock time in a form (floating for a zone: the property carries the TZID). */
function timeOf(w: Wall, form: Form): Time {
  if (form.kind === 'date') return ICAL.Time.fromData({ year: w.y, month: w.mo, day: w.d, isDate: true });
  const t = ICAL.Time.fromData({ year: w.y, month: w.mo, day: w.d, hour: w.h, minute: w.mi, second: w.s, isDate: false }, form.kind === 'utc' ? ICAL.Timezone.utcTimezone : undefined);
  return t;
}

/** Reads the forms of an object's time properties: its VTIMEZONEs by TZID, and the zone floating times are read in. */
class Zones {
  private readonly vtz = new Map<string, string>();
  constructor(vcal: Component, private readonly fallback: string) {
    for (const z of vcal.getAllSubcomponents('vtimezone')) {
      const id = z.getFirstPropertyValue('tzid');
      if (typeof id === 'string') this.vtz.set(id, z.toString());
    }
  }
  formOf(prop: Property): Form {
    const t = prop.getFirstValue() as Time;
    if (t.isDate) return { kind: 'date' };
    if (isUtcTime(t)) return { kind: 'utc' };
    const tzid = prop.getFirstParameter('tzid');
    if (!tzid) return { kind: 'floating', iana: this.fallback };
    const iana = ianaOf(tzid);
    const vtz = iana ? undefined : this.vtz.get(tzid);
    return { kind: 'zone', tzid, iana, ...(vtz ? { vtz } : {}) };
  }
  utcOf(prop: Property, value?: Time): number {
    return toUtc(timeWall(value ?? (prop.getFirstValue() as Time)), this.formOf(prop));
  }
}

// ---- formats ------------------------------------------------------------------------------------------------------

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
/** An occurrence's part of its id: `20261105T100000Z`, or `20261105` for an all-day one. */
export function ridText(ms: number, allDay: boolean): string {
  const w = wallOf(ms);
  return allDay ? `${w.y}${pad(w.mo)}${pad(w.d)}` : `${w.y}${pad(w.mo)}${pad(w.d)}T${pad(w.h)}${pad(w.mi)}${pad(w.s)}Z`;
}
export function parseRid(text: string): number | null {
  const m = /^(\d{4})(\d\d)(\d\d)(?:T(\d\d)(\d\d)(\d\d)Z)?$/.exec(text);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
}
export const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
/** How the API writes an occurrence's start or end: an ISO instant, or a date for an all-day one. */
export const isoOf = (ms: number, allDay: boolean) => (allDay ? isoDate(ms) : new Date(ms).toISOString());

/** An instant from the API: an ISO instant, a date (UTC midnight), or a wall-clock time read in `zone`. */
export function parseInstant(s: string, zone: string | null): number {
  const t = s.trim();
  if (/^\d{4}-\d\d-\d\d$/.test(t)) return Date.parse(`${t}T00:00:00Z`);
  const local = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)(?::(\d\d))?(?:\.\d+)?$/.exec(t);
  if (local) {
    const w = { y: +local[1], mo: +local[2], d: +local[3], h: +local[4], mi: +local[5], s: +(local[6] ?? 0) };
    return wallToUtc(w, ianaOf(zone) ?? 'UTC');
  }
  const ms = Date.parse(t);
  if (Number.isNaN(ms)) throw badRequest(`not a date or time: ${t.slice(0, 40)}`);
  return Math.floor(ms / 1000) * 1000;
}

// ---- reading ------------------------------------------------------------------------------------------------------

const text = (c: Component, name: string): string | null => {
  const v = c.getFirstPropertyValue(name);
  return typeof v === 'string' && v.trim() ? v : null;
};
const mailto = (v: unknown) => (typeof v === 'string' ? v.replace(/^mailto:/i, '').trim().toLowerCase() : '');

function person(p: Property, me: Set<string>, organizer: boolean): Attendee | null {
  const email = mailto(p.getFirstValue());
  if (!email || !email.includes('@')) return null;
  const partstat = String(p.getFirstParameter('partstat') ?? '').toUpperCase();
  const response: Response = organizer ? 'accepted' : partstat === 'ACCEPTED' ? 'accepted' : partstat === 'DECLINED' ? 'declined' : partstat === 'TENTATIVE' ? 'tentative' : 'needs-action';
  const role = String(p.getFirstParameter('role') ?? '').toUpperCase() === 'OPT-PARTICIPANT' ? 'optional' : 'required';
  const cn = p.getFirstParameter('cn');
  return { name: cn ? String(cn) : null, email, role, response, ...(me.has(email) ? { self: true as const } : {}) };
}

const CONFERENCE_HOSTS: [RegExp, string][] = [
  [/https:\/\/[\w.-]*zoom\.us\/[^\s<>"]+/i, 'Zoom'],
  [/https:\/\/meet\.google\.com\/[^\s<>"]+/i, 'Google Meet'],
  [/https:\/\/teams\.(microsoft|live)\.com\/[^\s<>"]+/i, 'Microsoft Teams'],
  [/https:\/\/[\w.-]*webex\.com\/[^\s<>"]+/i, 'Webex'],
  [/https:\/\/(?:app\.)?whereby\.com\/[^\s<>"]+/i, 'Whereby'],
  [/https:\/\/facetime\.apple\.com\/[^\s<>"]+/i, 'FaceTime'],
];
function conferenceOf(ev: Component): EventData['conference'] {
  const sources = [text(ev, 'x-google-conference'), text(ev, 'x-microsoft-skypeteamsmeetingurl'), ...ev.getAllProperties('conference').map((p) => String(p.getFirstValue() ?? '')), text(ev, 'url'), text(ev, 'location'), text(ev, 'description')];
  for (const s of sources) {
    if (!s) continue;
    for (const [re, label] of CONFERENCE_HOSTS) {
      const m = re.exec(s);
      if (m) return { url: m[0].replace(/[).,;]+$/, ''), label };
    }
  }
  return undefined;
}

function reminders(ev: Component): number[] {
  const out: number[] = [];
  for (const a of ev.getAllSubcomponents('valarm')) {
    const t = a.getFirstPropertyValue('trigger');
    if (t && typeof t === 'object' && 'toSeconds' in t) {
      const s = (t as InstanceType<typeof ICAL.Duration>).toSeconds();
      if (s <= 0) out.push(Math.round(-s / 60));
    }
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

/** The recurrence lines of a VEVENT as written (RRULE, RDATE, EXDATE), for the edit dialog and `get_event`. */
function recurrenceLines(ev: Component): string[] {
  return ['rrule', 'rdate', 'exdate'].flatMap((n) => ev.getAllProperties(n).map((p) => p.toICALString()));
}

function instantsOf(props: Property[], zones: Zones): number[] {
  const out: number[] = [];
  for (const p of props) {
    for (const v of p.getValues()) {
      const t = (v && typeof v === 'object' && 'start' in v ? (v as { start: Time }).start : v) as Time;
      if (t && typeof t === 'object' && 'year' in t) out.push(zones.utcOf(p, t));
    }
  }
  return out;
}

const UNTIL = /;?UNTIL=(\d{8})(?:T(\d{6})(Z)?)?/i;
/** A rule's UNTIL as an instant (a date: the end of that day, in the series' form), or null. */
function untilOf(rule: string, form: Form): number | null {
  const m = UNTIL.exec(rule);
  if (!m) return null;
  const [y, mo, d] = [+m[1].slice(0, 4), +m[1].slice(4, 6), +m[1].slice(6, 8)];
  if (!m[2]) return form.kind === 'date' ? Date.UTC(y, mo - 1, d) : toUtc({ y, mo, d, h: 23, mi: 59, s: 59 }, form);
  const w = { y, mo, d, h: +m[2].slice(0, 2), mi: +m[2].slice(2, 4), s: +m[2].slice(4, 6) };
  return m[3] ? wallMs(w) : toUtc(w, form);
}

/** Every VEVENT of an object as a row. `me`: the account's own addresses (its attendee is `self`); `zone`: floating times' zone. */
export function parseObject(raw: string, opts: { me: Set<string>; zone: string }): ParsedEvent[] {
  let vcal: Component;
  try {
    vcal = ICAL.Component.fromString(raw);
  } catch {
    return [];
  }
  const zones = new Zones(vcal, ianaOf(opts.zone) ?? 'UTC');
  const out: ParsedEvent[] = [];
  for (const ev of vcal.getAllSubcomponents('vevent')) {
    const p = parseVevent(ev, zones, opts.me);
    if (p) out.push(p);
  }
  return out;
}

function parseVevent(ev: Component, zones: Zones, me: Set<string>): ParsedEvent | null {
  const uid = text(ev, 'uid');
  const dtstart = ev.getFirstProperty('dtstart');
  if (!uid || !dtstart || !dtstart.getFirstValue()) return null;
  const st = dtstart.getFirstValue() as Time;
  const form = zones.formOf(dtstart);
  const allDay = st.isDate;
  const startUtc = toUtc(timeWall(st), form);
  let endUtc = startUtc + (allDay ? DAY_MS : 0);
  const dtend = ev.getFirstProperty('dtend');
  const duration = ev.getFirstPropertyValue('duration');
  if (dtend?.getFirstValue()) endUtc = zones.utcOf(dtend);
  else if (duration && typeof duration === 'object' && 'toSeconds' in duration) endUtc = startUtc + (duration as InstanceType<typeof ICAL.Duration>).toSeconds() * 1000;
  if (endUtc < startUtc) endUtc = startUtc;
  const ridProp = ev.getFirstProperty('recurrence-id');
  const rid = ridProp?.getFirstValue() ? zones.utcOf(ridProp) : 0;
  const rrules = ev.getAllProperties('rrule').map((p) => String(p.getFirstValue()?.toString() ?? '')).filter(Boolean);
  const rdates = instantsOf(ev.getAllProperties('rdate'), zones);
  const exdates = instantsOf(ev.getAllProperties('exdate'), zones);
  const organizerProp = ev.getFirstProperty('organizer');
  const organizer = organizerProp ? person(organizerProp, me, true) : null;
  const attendees = ev.getAllProperties('attendee').map((a) => person(a, me, false)).filter((a): a is Attendee => !!a);
  const mine = attendees.find((a) => a.self);
  const status = String(ev.getFirstPropertyValue('status') ?? '').toLowerCase();
  const conference = conferenceOf(ev);
  const updated = ev.getFirstProperty('last-modified') ?? ev.getFirstProperty('dtstamp');
  const tzid = form.kind === 'zone' ? (form.iana ?? form.tzid) : form.kind === 'utc' ? 'UTC' : null;
  const data: EventData = {
    summary: text(ev, 'summary') ?? '', location: text(ev, 'location'), description: text(ev, 'description')?.slice(0, 32_000) ?? null,
    allDay, timezone: tzid, status: status === 'tentative' ? 'tentative' : status === 'cancelled' ? 'cancelled' : 'confirmed',
    organizer, attendees, ...(mine && !organizer?.self ? { myResponse: mine.response } : {}),
    ...(conference ? { conference } : {}),
    updated: updated?.getFirstValue() ? new Date(zones.utcOf(updated)).toISOString() : new Date(0).toISOString(),
    sequence: Number(ev.getFirstPropertyValue('sequence') ?? 0) || 0, reminders: reminders(ev), recurrence: rid ? [] : recurrenceLines(ev),
    ...(String(ev.getFirstPropertyValue('transp') ?? '').toUpperCase() === 'TRANSPARENT' ? { transparent: true as const } : {}),
  };
  const search = [data.summary, data.location, data.description, ...attendees.flatMap((a) => [a.name, a.email]), organizer?.name, organizer?.email].filter(Boolean).join('\n').toLowerCase();
  const durationMs = endUtc - startUtc;
  const recurring = !rid && (rrules.length > 0 || rdates.length > 0);
  const rules: Rules | null = recurring ? { start: timeWall(st), form, durationMs, rrules, rdates, exdates } : null;
  const kind: ParsedEvent['kind'] = recurring ? 1 : durationMs > LONG_MS ? 2 : 0;
  return { uid, rid, kind, startUtc, endUtc, recurUntil: rules ? recurUntil(rules, startUtc) : endUtc, data, rules, search };
}

// ---- recurrence ---------------------------------------------------------------------------------------------------

const FAST_PARTS = new Set(['BYDAY']);
const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

/** A rule without UNTIL (enforced here, in UTC: ical.js would compare it in the floating zone) as ical.js reads it. */
function recurOf(rule: string) {
  return ICAL.Recur.fromString(rule.replace(/^RRULE:/i, '').replace(UNTIL, ''));
}

/**
 * How many days a series can be moved on by without changing its occurrences, or 0: DAILY and WEEKLY rules with no COUNT
 * and nothing but plain BYDAY, whose start is one of its days. Lets a series that began years ago be walked from near the
 * window rather than from its start.
 */
function stepDays(recur: ReturnType<typeof recurOf>, start: Wall): number {
  if (recur.count || !['DAILY', 'WEEKLY'].includes(String(recur.freq))) return 0;
  const parts = Object.entries(recur.parts ?? {}).filter(([, v]) => (v as unknown[] | undefined)?.length);
  if (parts.some(([k]) => !FAST_PARTS.has(k))) return 0;
  const byday = (recur.parts?.BYDAY ?? []) as string[];
  if (byday.some((d) => !WEEKDAYS.includes(d))) return 0;
  const wd = WEEKDAYS[new Date(Date.UTC(start.y, start.mo - 1, start.d)).getUTCDay()];
  if (byday.length && !byday.includes(wd)) return 0;
  const interval = recur.interval || 1;
  return recur.freq === 'WEEKLY' || byday.length ? 7 * interval : interval;
}

function startTime(rules: Rules): Time {
  return timeOf(rules.start, rules.form);
}

/**
 * The starts (instants) of a series' occurrences that overlap [from, to): its rules walked in its own wall clock (so a
 * 10:00 meeting stays at 10:00 across a change to daylight time), RDATEs added, EXDATEs dropped. Exceptions are the caller's.
 */
export function expand(rules: Rules, from: number, to: number): number[] {
  const out = new Set<number>();
  const dur = rules.durationMs;
  const inWindow = (s: number) => s < to && (s + dur > from || (dur === 0 && s >= from));
  const firstUtc = toUtc(rules.start, rules.form);
  if (inWindow(firstUtc)) out.add(firstUtc);
  for (const rule of rules.rrules) {
    const recur = recurOf(rule);
    const until = untilOf(rule, rules.form) ?? Infinity;
    let base = startTime(rules);
    const step = stepDays(recur, rules.start);
    if (step) {
      const k = Math.floor((from - dur - firstUtc) / (step * DAY_MS)) - 1;
      if (k > 0) { base = base.clone(); base.adjust(k * step, 0, 0, 0); }
    }
    const it = recur.iterator(base);
    for (let n = 0, t = it.next(); t && n < ITERATION_CAP; n++, t = it.next()) {
      const s = toUtc(timeWall(t), rules.form);
      if (s > until || s >= to) break;
      if (inWindow(s)) out.add(s);
    }
  }
  for (const s of rules.rdates) if (inWindow(s)) out.add(s);
  for (const s of rules.exdates) out.delete(s);
  return [...out].sort((a, b) => a - b);
}

/** When a series' last occurrence ends, or FOREVER: what its row's `recur_until` holds (the window query reads it). */
export function recurUntil(rules: Rules, firstUtc: number): number {
  let last = firstUtc + rules.durationMs;
  for (const rule of rules.rrules) {
    const recur = recurOf(rule);
    const until = untilOf(rule, rules.form);
    if (until !== null) { last = Math.max(last, until + rules.durationMs); continue; }
    if (!recur.count) return FOREVER;
    const it = recur.iterator(startTime(rules));
    let n = 0, s = firstUtc;
    for (let t = it.next(); t; t = it.next()) {
      if (++n > COUNT_WALK_CAP) return FOREVER;
      s = toUtc(timeWall(t), rules.form);
    }
    last = Math.max(last, s + rules.durationMs);
  }
  for (const r of rules.rdates) last = Math.max(last, r + rules.durationMs);
  return last;
}

/** How many occurrences of a series start before an instant (for a COUNT series split in two). */
function occurrencesBefore(rules: Rules, before: number): number {
  return expand(rules, toUtc(rules.start, rules.form) - 1, before).filter((s) => s < before).length;
}

// ---- writing ------------------------------------------------------------------------------------------------------

/** What the API changes on an event (EventInput, all optional for a patch). */
export interface Fields {
  summary?: string; location?: string | null; description?: string | null; start?: string; end?: string; allDay?: boolean;
  timezone?: string | null; recurrence?: string[] | null; attendees?: { email: string; name?: string; role?: 'required' | 'optional' }[];
  reminders?: { minutes: number }[];
}
export interface WriteContext { me: string[]; organizer: string | null; displayName: string; zone: string; now: number }

const PRODID = '-//FreeFlow//Calendar 1.0//EN';
const icalUtc = (ms: number) => ICAL.Time.fromData({ ...timeData(wallOf(ms)), isDate: false }, ICAL.Timezone.utcTimezone);
const timeData = (w: Wall) => ({ year: w.y, month: w.mo, day: w.d, hour: w.h, minute: w.mi, second: w.s });

export function parseCalendar(raw: string): Component {
  try {
    return ICAL.Component.fromString(raw);
  } catch {
    throw badRequest('the event on the server is not valid iCalendar');
  }
}
export const vevents = (vcal: Component, uid: string) => vcal.getAllSubcomponents('vevent').filter((e) => e.getFirstPropertyValue('uid') === uid);
export const masterOf = (vcal: Component, uid: string) => vevents(vcal, uid).find((e) => !e.getFirstProperty('recurrence-id')) ?? null;

function zonesOf(vcal: Component, ctx: WriteContext) {
  return new Zones(vcal, ianaOf(ctx.zone) ?? 'UTC');
}
function exceptionAt(vcal: Component, uid: string, rid: number, zones: Zones): Component | null {
  return vevents(vcal, uid).find((e) => { const p = e.getFirstProperty('recurrence-id'); return !!p && zones.utcOf(p) === rid; }) ?? null;
}

function ensureVtimezone(vcal: Component, zone: string, year: number): void {
  if (zone === 'UTC' || vcal.getAllSubcomponents('vtimezone').some((z) => z.getFirstPropertyValue('tzid') === zone)) return;
  const tz = ICAL.Component.fromString(vtimezone(zone, year).join('\r\n'));
  // VTIMEZONEs first, as most writers put them.
  const events = vcal.getAllSubcomponents('vevent');
  for (const e of events) vcal.removeSubcomponent(e);
  vcal.addSubcomponent(tz);
  for (const e of events) vcal.addSubcomponent(e);
}

/** Sets a time property to an instant in a form (TZID and its VTIMEZONE for a zone). */
function setTime(vcal: Component, ev: Component, name: string, ms: number, form: Form): void {
  ev.removeAllProperties(name);
  const p = new ICAL.Property(name, ev);
  if (form.kind === 'zone') {
    p.setParameter('tzid', form.iana ?? form.tzid);
    if (form.iana) ensureVtimezone(vcal, form.iana, new Date(ms).getUTCFullYear());
  }
  p.setValue(timeOf(fromUtc(ms, form), form));
  ev.addProperty(p);
}
function addInstant(vcal: Component, ev: Component, name: string, ms: number, form: Form): void {
  const p = new ICAL.Property(name, ev);
  if (form.kind === 'zone') p.setParameter('tzid', form.iana ?? form.tzid);
  p.setValue(timeOf(fromUtc(ms, form), form));
  ev.addProperty(p);
}
const setText = (ev: Component, name: string, value: string | null | undefined) => {
  if (value === undefined) return;
  ev.removeAllProperties(name);
  if (value !== null && value !== '') ev.addPropertyWithValue(name, value);
};

/** The form an event's times are written in: a named zone (IANA) asked for, else the one it has, else UTC; all-day: dates. */
function formFor(allDay: boolean, timezone: string | null | undefined, current: Form | null, zone: string): Form {
  if (allDay) return { kind: 'date' };
  if (timezone === undefined && current && current.kind !== 'date') return current;
  const iana = ianaOf(timezone === undefined ? zone : timezone);
  return iana && iana !== 'UTC' ? { kind: 'zone', tzid: iana, iana } : { kind: 'utc' };
}

function stamp(ev: Component, now: number, bump: boolean): void {
  for (const name of ['dtstamp', 'last-modified']) { ev.removeAllProperties(name); ev.addPropertyWithValue(name, icalUtc(now)); }
  if (bump) {
    const seq = Number(ev.getFirstPropertyValue('sequence') ?? 0) || 0;
    ev.removeAllProperties('sequence');
    ev.addPropertyWithValue('sequence', seq + 1);
  }
}

const RECURRENCE_LINE = /^(RRULE|RDATE|EXDATE)[;:]/i;
function setRecurrence(ev: Component, lines: string[] | null): void {
  for (const n of ['rrule', 'rdate', 'exdate', 'exrule']) ev.removeAllProperties(n);
  for (const line of lines ?? []) {
    const l = line.trim();
    if (!l) continue;
    if (!RECURRENCE_LINE.test(l)) throw badRequest(`recurrence: expected RRULE, RDATE or EXDATE lines, not ${l.slice(0, 40)}`);
    let prop: Property;
    try {
      prop = ICAL.Property.fromString(l);
      if (prop.name === 'rrule') ICAL.Recur.fromString(String(prop.getFirstValue()));
    } catch {
      throw badRequest(`recurrence: not a valid line: ${l.slice(0, 60)}`);
    }
    ev.addProperty(prop);
  }
}

function setAttendees(ev: Component, list: NonNullable<Fields['attendees']>, ctx: WriteContext): void {
  const kept = new Map(ev.getAllProperties('attendee').map((p) => [mailto(p.getFirstValue()), p] as const));
  ev.removeAllProperties('attendee');
  const seen = new Set<string>();
  for (const a of list) {
    const email = a.email.trim().toLowerCase();
    if (seen.has(email)) continue;
    seen.add(email);
    const old = kept.get(email);
    const p = old ?? new ICAL.Property('attendee', ev);
    if (!old) {
      p.setValue(`mailto:${email}`);
      p.setParameter('partstat', ctx.me.includes(email) ? 'ACCEPTED' : 'NEEDS-ACTION');
      if (!ctx.me.includes(email)) p.setParameter('rsvp', 'TRUE');
      p.setParameter('cutype', 'INDIVIDUAL');
    }
    p.setParameter('role', a.role === 'optional' ? 'OPT-PARTICIPANT' : 'REQ-PARTICIPANT');
    if (a.name) p.setParameter('cn', a.name);
    ev.addProperty(p);
  }
  const organizer = ev.getFirstProperty('organizer');
  if (list.length && !organizer && ctx.organizer) {
    const p = new ICAL.Property('organizer', ev);
    p.setValue(`mailto:${ctx.organizer}`);
    if (ctx.displayName) p.setParameter('cn', ctx.displayName);
    ev.addProperty(p);
    // The organizer attends too, as every server expects.
    if (!seen.has(ctx.organizer.toLowerCase())) {
      const me = new ICAL.Property('attendee', ev);
      me.setValue(`mailto:${ctx.organizer}`);
      me.setParameter('partstat', 'ACCEPTED');
      me.setParameter('role', 'CHAIR');
      if (ctx.displayName) me.setParameter('cn', ctx.displayName);
      ev.addProperty(me);
    }
  }
  if (!list.length && organizer && ctx.me.includes(mailto(organizer.getFirstValue()))) {
    ev.removeAllProperties('organizer');
    ev.removeAllProperties('attendee');
  }
}

function setReminders(ev: Component, list: NonNullable<Fields['reminders']>): void {
  for (const a of ev.getAllSubcomponents('valarm')) ev.removeSubcomponent(a);
  for (const r of list) {
    const a = new ICAL.Component('valarm', ev);
    a.addPropertyWithValue('action', 'DISPLAY');
    a.addPropertyWithValue('description', 'Reminder');
    const trigger = new ICAL.Property('trigger', a);
    trigger.setValue(ICAL.Duration.fromSeconds(-Math.max(0, Math.round(r.minutes)) * 60));
    a.addProperty(trigger);
    ev.addSubcomponent(a);
  }
}

/** The event's current start and end (instants) and form. */
function timesOf(ev: Component, zones: Zones): { start: number; end: number; form: Form; allDay: boolean } {
  const dtstart = ev.getFirstProperty('dtstart')!;
  const form = zones.formOf(dtstart);
  const start = zones.utcOf(dtstart);
  const allDay = form.kind === 'date';
  const dtend = ev.getFirstProperty('dtend');
  const duration = ev.getFirstPropertyValue('duration');
  let end = start + (allDay ? DAY_MS : 0);
  if (dtend?.getFirstValue()) end = zones.utcOf(dtend);
  else if (duration && typeof duration === 'object' && 'toSeconds' in duration) end = start + (duration as InstanceType<typeof ICAL.Duration>).toSeconds() * 1000;
  return { start, end: Math.max(end, start), form, allDay };
}

/**
 * The start and end a patch asks for, from the times an event (or occurrence) has now: a start alone keeps the duration,
 * all-day on or off converts (a timed event made all-day covers its days; the other way, 9:00–10:00 on its first day).
 */
function nextTimes(cur: { start: number; end: number; allDay: boolean }, f: Fields, zone: string): { start: number; end: number; allDay: boolean } {
  const allDay = f.allDay ?? cur.allDay;
  const z = f.timezone ?? zone;
  if (allDay) {
    const dateOf = (ms: number) => { const w = cur.allDay ? wallOf(ms) : utcToWall(ms, ianaOf(z) ?? 'UTC'); return Date.UTC(w.y, w.mo - 1, w.d); };
    const toDate = (s: string) => parseInstant(s.trim().slice(0, 10), null);
    const start = f.start ? toDate(f.start) : dateOf(cur.start);
    let end = f.end ? toDate(f.end) : start + (cur.allDay ? cur.end - cur.start : DAY_MS);
    if (end <= start) end = start + DAY_MS;
    return { start, end, allDay };
  }
  let start: number, end: number;
  if (f.start) start = parseInstant(f.start, z);
  else if (cur.allDay) { const d = wallOf(cur.start); start = wallToUtc({ ...d, h: 9, mi: 0, s: 0 }, ianaOf(z) ?? 'UTC'); }
  else start = cur.start;
  if (f.end) end = parseInstant(f.end, z);
  else if (cur.allDay) end = start + 3_600_000;
  else end = start + (cur.end - cur.start);
  if (end < start) throw badRequest('end: before the start');
  return { start, end, allDay };
}

const changesTime = (f: Fields) => f.start !== undefined || f.end !== undefined || f.allDay !== undefined || f.timezone !== undefined;

/** Applies a patch to one VEVENT. `occurrence`: the times the change is relative to (an occurrence's, for a series). */
function apply(vcal: Component, ev: Component, f: Fields, ctx: WriteContext, zones: Zones, occurrence?: { start: number; end: number }): void {
  setText(ev, 'summary', f.summary);
  setText(ev, 'location', f.location);
  setText(ev, 'description', f.description);
  let bump = f.location !== undefined || f.recurrence !== undefined;
  if (changesTime(f)) {
    const cur = timesOf(ev, zones);
    const base = occurrence ? { ...cur, start: occurrence.start, end: occurrence.end } : cur;
    const next = nextTimes(base, f, ctx.zone);
    const form = formFor(next.allDay, f.timezone, cur.form, ctx.zone);
    const shift = next.start - base.start;
    const newStart = occurrence ? cur.start + shift : next.start;
    setTime(vcal, ev, 'dtstart', newStart, form);
    ev.removeAllProperties('duration');
    setTime(vcal, ev, 'dtend', newStart + (next.end - next.start), form);
    bump = true;
  }
  if (f.recurrence !== undefined) setRecurrence(ev, f.recurrence);
  if (f.attendees !== undefined) setAttendees(ev, f.attendees, ctx);
  if (f.reminders !== undefined) setReminders(ev, f.reminders);
  stamp(ev, ctx.now, bump);
}

/** A new event as an object resource: a VCALENDAR with its VEVENT (and VTIMEZONE). */
export function newEvent(uid: string, f: Fields & { summary: string; start: string; end: string }, ctx: WriteContext): string {
  const vcal = new ICAL.Component('vcalendar');
  vcal.addPropertyWithValue('version', '2.0');
  vcal.addPropertyWithValue('prodid', PRODID);
  vcal.addPropertyWithValue('calscale', 'GREGORIAN');
  const ev = new ICAL.Component('vevent', vcal);
  vcal.addSubcomponent(ev);
  ev.addPropertyWithValue('uid', uid);
  ev.addPropertyWithValue('created', icalUtc(ctx.now));
  ev.addPropertyWithValue('sequence', 0);
  const allDay = f.allDay ?? (/^\d{4}-\d\d-\d\d$/.test(f.start.trim()) && /^\d{4}-\d\d-\d\d$/.test(f.end.trim()));
  // Placeholder times, replaced by `apply` (which reads the event's current times).
  setTime(vcal, ev, 'dtstart', parseInstant(f.start, f.timezone ?? ctx.zone), formFor(allDay, f.timezone, null, ctx.zone));
  apply(vcal, ev, { ...f, allDay, timezone: f.timezone ?? (allDay ? undefined : ctx.zone) }, ctx, zonesOf(vcal, ctx));
  ev.removeAllProperties('sequence');
  ev.addPropertyWithValue('sequence', 0);
  return vcal.toString();
}

/** An exception VEVENT for one occurrence of a series: a copy of the master at that occurrence's time. */
function makeException(vcal: Component, master: Component, rid: number, zones: Zones): Component {
  const m = timesOf(master, zones);
  const ex = new ICAL.Component(JSON.parse(JSON.stringify(master.toJSON())), vcal);
  for (const n of ['rrule', 'rdate', 'exdate', 'exrule', 'recurrence-id']) ex.removeAllProperties(n);
  addInstant(vcal, ex, 'recurrence-id', rid, m.form);
  setTime(vcal, ex, 'dtstart', rid, m.form);
  ex.removeAllProperties('duration');
  setTime(vcal, ex, 'dtend', rid + (m.end - m.start), m.form);
  vcal.addSubcomponent(ex);
  return ex;
}

function rulesOf(master: Component, zones: Zones): Rules {
  const parsed = parseVevent(master, zones, new Set());
  if (!parsed?.rules) throw badRequest('this event does not repeat');
  return parsed.rules;
}

/** Moves the rids of a series' exceptions and its EXDATEs by a change of wall-clock time (a series moved as a whole). */
function shiftSeries(vcal: Component, uid: string, form: Form, zones: Zones, deltaWall: number, from = -Infinity): void {
  if (!deltaWall) return;
  const shift = (ms: number) => toUtc(wallOf(wallMs(fromUtc(ms, form)) + deltaWall), form);
  const master = masterOf(vcal, uid);
  if (master) {
    const ex = instantsOf(master.getAllProperties('exdate'), zones);
    master.removeAllProperties('exdate');
    for (const s of ex) addInstant(vcal, master, 'exdate', s >= from ? shift(s) : s, form);
  }
  for (const e of vevents(vcal, uid)) {
    const p = e.getFirstProperty('recurrence-id');
    if (!p) continue;
    const at = zones.utcOf(p);
    if (at < from) continue;
    e.removeAllProperties('recurrence-id');
    addInstant(vcal, e, 'recurrence-id', shift(at), form);
  }
}

/** Ends a series before an occurrence (UNTIL, COUNT gone), dropping its EXDATEs and exceptions from there on. */
function endBefore(vcal: Component, uid: string, rid: number, zones: Zones): void {
  const master = masterOf(vcal, uid)!;
  const { form } = timesOf(master, zones);
  const until = form.kind === 'date' ? ridText(rid - DAY_MS, true) : ridText(rid - 1000, false);
  const rules = master.getAllProperties('rrule').map((p) => String(p.getFirstValue()?.toString() ?? ''));
  master.removeAllProperties('rrule');
  for (const r of rules) {
    const kept = r.split(';').filter((part) => !/^(UNTIL|COUNT)=/i.test(part)).join(';');
    master.addPropertyWithValue('rrule', ICAL.Recur.fromString(`${kept};UNTIL=${until}`));
  }
  const rdates = instantsOf(master.getAllProperties('rdate'), zones).filter((s) => s < rid);
  const exdates = instantsOf(master.getAllProperties('exdate'), zones).filter((s) => s < rid);
  master.removeAllProperties('rdate');
  master.removeAllProperties('exdate');
  for (const s of rdates) addInstant(vcal, master, 'rdate', s, form);
  for (const s of exdates) addInstant(vcal, master, 'exdate', s, form);
  for (const e of vevents(vcal, uid)) {
    const p = e.getFirstProperty('recurrence-id');
    if (p && zones.utcOf(p) >= rid) vcal.removeSubcomponent(e);
  }
}

export type Scope = 'this' | 'following' | 'all';

/**
 * Applies a patch to an event. `rid` names an occurrence (0 for a plain event or the series as a whole); `scope` says how
 * far a change to an occurrence reaches: `this` writes an exception, `following` splits the series (the old one ends
 * before it with UNTIL, a new one with `newUid` starts there), `all` changes the master (a time change moves every
 * occurrence by as much as this one moved). Returns the object's new text, and the new series' for `following`.
 */
export function editEvent(raw: string, uid: string, rid: number, scope: Scope, f: Fields, ctx: WriteContext, newUid: () => string): { raw: string; created?: { uid: string; raw: string } } {
  const vcal = parseCalendar(raw);
  const zones = zonesOf(vcal, ctx);
  const master = masterOf(vcal, uid);
  const recurring = !!master && (master.getAllProperties('rrule').length > 0 || master.getAllProperties('rdate').length > 0);
  if (!rid || !recurring || !master) {
    // A plain event, the series as a whole, or an exception with no master here: the VEVENT itself.
    const ev = rid ? exceptionAt(vcal, uid, rid, zones) : (master ?? vevents(vcal, uid)[0]);
    if (!ev) throw badRequest('no such occurrence');
    if (rid && f.recurrence !== undefined) throw badRequest('recurrence: set it on the whole series');
    if (!rid && master && recurring && changesTime(f)) {
      const before = timesOf(master, zones);
      apply(vcal, master, f, ctx, zones);
      const after = timesOf(master, zones);
      shiftSeries(vcal, uid, after.form, zones, wallMs(fromUtc(after.start, after.form)) - wallMs(fromUtc(before.start, before.form)));
    } else apply(vcal, ev, f, ctx, zones);
    return { raw: vcal.toString() };
  }
  const m = timesOf(master, zones);
  const ex = exceptionAt(vcal, uid, rid, zones);
  const occ = ex ? timesOf(ex, zones) : { start: rid, end: rid + (m.end - m.start) };
  if (scope === 'this') {
    if (f.recurrence !== undefined) throw badRequest('recurrence: set it on the whole series (scope all or following)');
    apply(vcal, ex ?? makeException(vcal, master, rid, zones), f, ctx, zones);
    return { raw: vcal.toString() };
  }
  if (scope === 'all' || rid <= m.start) {
    apply(vcal, master, f, ctx, zones, changesTime(f) ? occ : undefined);
    const after = timesOf(master, zones);
    shiftSeries(vcal, uid, after.form, zones, wallMs(fromUtc(after.start, after.form)) - wallMs(fromUtc(m.start, m.form)));
    return { raw: vcal.toString() };
  }
  // This and following: a new series from this occurrence, carrying the rules, its later EXDATEs and exceptions.
  const rules = rulesOf(master, zones);
  const before = occurrencesBefore(rules, rid);
  const id = newUid();
  const next = new ICAL.Component('vcalendar');
  for (const p of vcal.getAllProperties()) next.addProperty(new ICAL.Property(JSON.parse(JSON.stringify(p.toJSON()))));
  for (const z of vcal.getAllSubcomponents('vtimezone')) next.addSubcomponent(new ICAL.Component(JSON.parse(JSON.stringify(z.toJSON()))));
  const copy = (e: Component) => { const c = new ICAL.Component(JSON.parse(JSON.stringify(e.toJSON())), next); c.updatePropertyWithValue('uid', id); next.addSubcomponent(c); return c; };
  const nm = copy(master);
  setTime(next, nm, 'dtstart', rid, m.form);
  nm.removeAllProperties('duration');
  setTime(next, nm, 'dtend', rid + (m.end - m.start), m.form);
  const rr = nm.getAllProperties('rrule').map((p) => String(p.getFirstValue()?.toString() ?? ''));
  nm.removeAllProperties('rrule');
  for (const r of rr) nm.addPropertyWithValue('rrule', ICAL.Recur.fromString(r.replace(/COUNT=(\d+)/i, (_, n) => `COUNT=${Math.max(1, Number(n) - before)}`)));
  const nz = zonesOf(next, ctx);
  const keepLater = (name: string) => {
    const later = instantsOf(nm.getAllProperties(name), nz).filter((s) => s >= rid);
    nm.removeAllProperties(name);
    for (const s of later) addInstant(next, nm, name, s, m.form);
  };
  keepLater('exdate');
  keepLater('rdate');
  nm.removeAllProperties('created');
  nm.addPropertyWithValue('created', icalUtc(ctx.now));
  for (const e of vevents(vcal, uid)) {
    const p = e.getFirstProperty('recurrence-id');
    // The exception at the split itself is not carried: the patch is what that occurrence becomes.
    if (p && zones.utcOf(p) > rid) copy(e);
  }
  endBefore(vcal, uid, rid, zones);
  stamp(master, ctx.now, true);
  const nmTimes = { start: occ.start, end: occ.end };
  apply(next, nm, f, ctx, nz, changesTime(f) ? nmTimes : undefined);
  const after = timesOf(nm, nz);
  shiftSeries(next, id, after.form, nz, wallMs(fromUtc(after.start, after.form)) - wallMs(fromUtc(rid, m.form)));
  return { raw: vcal.toString(), created: { uid: id, raw: next.toString() } };
}

/**
 * Deletes an occurrence (`this`: an EXDATE, its exception gone), this and following (the series ends before it), or the
 * whole event. Returns the object's new text, or null when nothing is left of it (delete the resource).
 */
export function deleteFromEvent(raw: string, uid: string, rid: number, scope: Scope, ctx: WriteContext): string | null {
  if (!rid || scope === 'all') return null;
  const vcal = parseCalendar(raw);
  const zones = zonesOf(vcal, ctx);
  const master = masterOf(vcal, uid);
  if (!master) {
    const ex = exceptionAt(vcal, uid, rid, zones);
    if (ex) vcal.removeSubcomponent(ex);
    return vcal.getAllSubcomponents('vevent').length ? vcal.toString() : null;
  }
  const m = timesOf(master, zones);
  if (scope === 'following') {
    if (rid <= m.start) return null;
    endBefore(vcal, uid, rid, zones);
  } else {
    const ex = exceptionAt(vcal, uid, rid, zones);
    if (ex) vcal.removeSubcomponent(ex);
    if (rid === m.start && !master.getAllProperties('rrule').length && !master.getAllProperties('rdate').length) return null;
    addInstant(vcal, master, 'exdate', rid, m.form);
  }
  stamp(master, ctx.now, true);
  return vcal.toString();
}

/** Sets the person's own PARTSTAT (an RSVP) on the series (and its exceptions), or on one occurrence. */
export function respondTo(raw: string, uid: string, rid: number, response: Exclude<Response, 'needs-action'>, comment: string | undefined, ctx: WriteContext): string {
  const vcal = parseCalendar(raw);
  const zones = zonesOf(vcal, ctx);
  const master = masterOf(vcal, uid);
  let targets: Component[];
  if (rid && master && (master.getAllProperties('rrule').length || master.getAllProperties('rdate').length)) targets = [exceptionAt(vcal, uid, rid, zones) ?? makeException(vcal, master, rid, zones)];
  else if (rid) targets = [exceptionAt(vcal, uid, rid, zones) ?? master].filter((e): e is Component => !!e);
  else targets = vevents(vcal, uid);
  let found = false;
  for (const ev of targets) {
    const mine = ev.getAllProperties('attendee').find((p) => ctx.me.includes(mailto(p.getFirstValue())));
    if (!mine) continue;
    found = true;
    mine.setParameter('partstat', response.toUpperCase());
    mine.removeParameter('rsvp');
    if (comment !== undefined) { ev.removeAllProperties('comment'); if (comment) ev.addPropertyWithValue('comment', comment); }
    stamp(ev, ctx.now, false);
  }
  if (!found) throw badRequest('you are not an attendee of this event');
  return vcal.toString();
}

/** The UID of an object's events (an object holds one), for a resource the server sent. */
export function uidOf(raw: string): string | null {
  const m = /^UID:(.*)$/im.exec(raw.replace(/\r?\n[ \t]/g, ''));
  return m ? m[1].trim() : null;
}
