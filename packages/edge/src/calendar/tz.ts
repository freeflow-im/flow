// Time zones for FreeFlow Calendar (docs/specs/calendar.md §3): wall-clock times in a named zone to and from UTC, through
// the runtime's Intl (the IANA database the Worker carries), and the VTIMEZONE an event we write takes with its TZID.
// ical.js knows no zones beyond those an object carries, and servers such as Google's drop them, so an IANA name is
// always converted here; a zone named otherwise (Outlook's "Eastern Standard Time") is the object's own VTIMEZONE's (ical.ts).

/** A wall-clock time: month 1–12. */
export interface Wall { y: number; mo: number; d: number; h: number; mi: number; s: number }

const formats = new Map<string, Intl.DateTimeFormat | null>();
function format(zone: string): Intl.DateTimeFormat | null {
  let f = formats.get(zone);
  if (f === undefined) {
    try {
      f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    } catch {
      f = null;
    }
    formats.set(zone, f);
  }
  return f;
}

/** The IANA zone a TZID names, or null: `America/New_York`, Mozilla's `/mozilla.org/20050126_1/America/New_York`, `UTC`. */
export function ianaOf(tzid: string | null | undefined): string | null {
  if (!tzid) return null;
  const t = tzid.trim().replace(/^"|"$/g, '');
  if (/^(utc|gmt|z|etc\/utc|etc\/gmt)$/i.test(t)) return 'UTC';
  if (format(t)) return t;
  const tail = /([A-Za-z_]+\/[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+)?)$/.exec(t)?.[1];
  return tail && format(tail) ? tail : null;
}

export const isIana = (zone: string) => ianaOf(zone) === zone;

export const wallMs = (w: Wall) => Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi, w.s);
export const wallOf = (ms: number): Wall => {
  const d = new Date(ms);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds() };
};

/** The wall clock in `zone` at an instant. */
export function utcToWall(ms: number, zone: string): Wall {
  if (zone === 'UTC') return wallOf(ms);
  const f = format(zone);
  if (!f) return wallOf(ms);
  const parts: Record<string, number> = {};
  for (const p of f.formatToParts(new Date(ms))) if (p.type !== 'literal') parts[p.type] = Number(p.value);
  return { y: parts.year, mo: parts.month, d: parts.day, h: parts.hour === 24 ? 0 : parts.hour, mi: parts.minute, s: parts.second };
}

/** How far `zone` is ahead of UTC at an instant, in ms. */
export const offsetMs = (ms: number, zone: string) => wallMs(utcToWall(ms, zone)) - Math.floor(ms / 1000) * 1000;

/** The instant a wall-clock time in `zone` names. A time in a spring-forward gap moves on by the gap, as calendars do. */
export function wallToUtc(w: Wall, zone: string): number {
  const local = wallMs(w);
  if (zone === 'UTC' || !format(zone)) return local;
  const first = local - offsetMs(local, zone);
  const second = local - offsetMs(first, zone);
  if (second === first) return first;
  // Either side of a change: take the one whose wall clock is the time asked for, else (a gap) the later reading.
  const third = local - offsetMs(second, zone);
  return wallMs(utcToWall(second, zone)) === local ? second : Math.max(second, third);
}

const pad = (n: number, w = 2) => String(Math.abs(n)).padStart(w, '0');
const offsetText = (ms: number) => `${ms < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(ms) / 3_600_000))}${pad(Math.floor((Math.abs(ms) % 3_600_000) / 60_000))}`;
const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const daysIn = (y: number, mo: number) => new Date(Date.UTC(y, mo, 0)).getUTCDate();

/** The date of the nth (or, n = -1, last) weekday `wd` (0 = Sunday) of a month. */
function nthWeekday(y: number, mo: number, n: number, wd: number): number {
  if (n > 0) {
    const first = new Date(Date.UTC(y, mo - 1, 1)).getUTCDay();
    return 1 + ((wd - first + 7) % 7) + (n - 1) * 7;
  }
  const last = daysIn(y, mo);
  const lastWd = new Date(Date.UTC(y, mo - 1, last)).getUTCDay();
  return last - ((lastWd - wd + 7) % 7);
}

/** The instants in `year` where the zone's offset changes, found from monthly samples and narrowed to the minute. */
function transitions(zone: string, year: number): { at: number; from: number; to: number }[] {
  const out: { at: number; from: number; to: number }[] = [];
  let prev = Date.UTC(year, 0, 1);
  for (let m = 1; m <= 12; m++) {
    const next = Date.UTC(year, m, 1);
    const a = offsetMs(prev, zone), b = offsetMs(next, zone);
    if (a !== b) {
      let lo = prev, hi = next;
      while (hi - lo > 60_000) {
        const mid = lo + Math.floor((hi - lo) / 2 / 60_000) * 60_000;
        if (offsetMs(mid, zone) === a) lo = mid; else hi = mid;
      }
      out.push({ at: hi, from: a, to: b });
    }
    prev = next;
  }
  return out;
}

/**
 * A VTIMEZONE for an IANA zone, as the events we write carry with their TZID (RFC 5545 asks for one; the servers read the
 * name). Its rules are the zone's in `year`, as yearly rules from 1970; a zone without daylight time has one STANDARD.
 */
export function vtimezone(zone: string, year: number): string[] {
  const lines = ['BEGIN:VTIMEZONE', `TZID:${zone}`];
  const changes = transitions(zone, year);
  if (changes.length !== 2) {
    const off = offsetText(offsetMs(Date.UTC(year, 0, 1), zone));
    lines.push('BEGIN:STANDARD', `TZOFFSETFROM:${off}`, `TZOFFSETTO:${off}`, 'DTSTART:19700101T000000', 'END:STANDARD');
  } else {
    for (const c of changes) {
      const w = wallOf(c.at + c.from);
      const wd = new Date(Date.UTC(w.y, w.mo - 1, w.d)).getUTCDay();
      const n = w.d + 7 > daysIn(w.y, w.mo) ? -1 : Math.ceil(w.d / 7);
      const day = nthWeekday(1970, w.mo, n, wd);
      const kind = c.to > c.from ? 'DAYLIGHT' : 'STANDARD';
      lines.push(`BEGIN:${kind}`, `TZOFFSETFROM:${offsetText(c.from)}`, `TZOFFSETTO:${offsetText(c.to)}`,
        `DTSTART:1970${pad(w.mo)}${pad(day)}T${pad(w.h)}${pad(w.mi)}00`, `RRULE:FREQ=YEARLY;BYMONTH=${w.mo};BYDAY=${n}${DAYS[wd]}`, `END:${kind}`);
    }
  }
  lines.push('END:VTIMEZONE');
  return lines;
}
