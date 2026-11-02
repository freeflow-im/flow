// Timezone-aware next-occurrence computation for scheduled messages (#419).
//
// Rules are written in *local* terms ("daily at 9:00", "Mondays at 9:30") and
// stored alongside an IANA zone; `next_run_at` — the only thing the scheduler
// queries — is the absolute instant that local wall-clock time lands on. That
// split is what makes a daily 9 AM message stay at 9 AM across a DST boundary
// instead of drifting by an hour.
//
// No date library: `Intl.DateTimeFormat` already knows every zone the runtime
// does, and the two operations we need (instant → local parts, local parts →
// instant) are a dozen lines each on top of it.
import type { Recurrence } from '@flow/shared';

/** How far ahead we are willing to look for a match before calling a rule dead
 * (a cron like `0 0 30 2 *` — February 30th — never fires). */
const HORIZON_DAYS = 400;

export interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number;
  weekday: number; // 0 = Sunday
}

const partsCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = partsCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      weekday: 'short',
    });
    partsCache.set(timeZone, f);
  }
  return f;
}

/** Is this an IANA zone the runtime actually knows? Used to validate input —
 * an unknown zone must be rejected at the API, not discovered at fire time. */
export function isValidTimezone(tz: string): boolean {
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

/** Wall-clock reading of `instant` in `timeZone`. */
export function localParts(instant: Date, timeZone: string): LocalParts {
  const parts = formatter(timeZone).formatToParts(instant);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '0';
  // en-US with hour12:false renders midnight as "24" in some ICU versions.
  const hour = Number(get('hour')) % 24;
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour,
    minute: Number(get('minute')),
    weekday: WEEKDAY_INDEX[get('weekday')] ?? 0,
  };
}

/** Zone offset (local − UTC, in ms) in effect at `instant`. */
function offsetMs(instant: Date, timeZone: string): number {
  const p = localParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0, 0);
  // The formatter drops seconds/ms, so compare against a truncated instant.
  const truncated = Math.floor(instant.getTime() / 60000) * 60000;
  return asUtc - truncated;
}

/**
 * The instant at which `timeZone` reads the given wall-clock time. Two passes:
 * guess with the offset in force at the naive UTC reading, then re-resolve with
 * the offset actually in force there. That converges everywhere the requested
 * time exists — including a fall-back hour, where it picks the first of the two
 * readings.
 *
 * Inside a spring-forward gap the requested time never exists, and the second
 * pass would land an hour *before* it (00:30 for a 2:30 rule). We detect that
 * by reading the answer back, and fall through to the first pass, which shifts
 * forward instead: a 2:30 AM daily message fires at 3:30 on the day 2:30 is
 * skipped, rather than at 1:30 the night before the user expected.
 */
export function zonedTimeToUtc(
  p: { year: number; month: number; day: number; hour: number; minute: number },
  timeZone: string,
): Date {
  const naive = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, 0, 0);
  const first = naive - offsetMs(new Date(naive), timeZone);
  const second = naive - offsetMs(new Date(first), timeZone);
  const back = localParts(new Date(second), timeZone);
  const exact =
    back.year === p.year && back.month === p.month && back.day === p.day
    && back.hour === p.hour && back.minute === p.minute;
  return new Date(exact ? second : first);
}

/** Advance a local calendar date by `days`, staying in local terms. */
function addLocalDays(p: LocalParts, days: number): { year: number; month: number; day: number } {
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day));
  d.setUTCDate(d.getUTCDate() + days);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** Weekday (0 = Sunday) of a local calendar date. */
function localWeekday(d: { year: number; month: number; day: number }): number {
  return new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay();
}

// ---- cron ------------------------------------------------------

interface CronRule {
  minutes: number[];
  hours: number[];
  daysOfMonth: number[] | null; // null = unrestricted (`*`)
  months: number[];
  daysOfWeek: number[] | null; // null = unrestricted (`*`)
}

function parseField(field: string, min: number, max: number): number[] {
  const out = new Set<number>();
  for (const part of field.split(',')) {
    const [range, stepText] = part.split('/');
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) throw new Error(`bad cron step: ${part}`);
    let lo: number;
    let hi: number;
    if (range === '*' || range === undefined) {
      lo = min;
      hi = max;
    } else if (range.includes('-')) {
      const [a, b] = range.split('-');
      lo = Number(a);
      hi = Number(b);
    } else {
      lo = Number(range);
      // `5/10` means "from 5 to the end of the field, every 10" — the same
      // reading crontab uses; a bare `5` is just itself.
      hi = stepText === undefined ? lo : max;
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) {
      throw new Error(`bad cron field: ${part}`);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return [...out].sort((a, b) => a - b);
}

/** Parse a 5-field cron expression (`min hour dom mon dow`). Throws on junk. */
export function parseCron(expression: string): CronRule {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error('cron must have 5 fields: min hour dom mon dow');
  const [minute, hour, dom, mon, dow] = fields as [string, string, string, string, string];
  return {
    minutes: parseField(minute, 0, 59),
    hours: parseField(hour, 0, 23),
    daysOfMonth: dom === '*' ? null : parseField(dom, 1, 31),
    months: parseField(mon, 1, 12),
    // Both 0 and 7 mean Sunday in crontab.
    daysOfWeek: dow === '*' ? null : parseField(dow, 0, 7).map((d) => d % 7),
  };
}

/** Standard crontab semantics: with both day fields restricted, a day matches
 * if *either* does. With one restricted, only that one is consulted. */
function cronDayMatches(rule: CronRule, date: { year: number; month: number; day: number }): boolean {
  if (!rule.months.includes(date.month)) return false;
  const domOk = rule.daysOfMonth === null || rule.daysOfMonth.includes(date.day);
  const dowOk = rule.daysOfWeek === null || rule.daysOfWeek.includes(localWeekday(date));
  if (rule.daysOfMonth !== null && rule.daysOfWeek !== null) return domOk || dowOk;
  return domOk && dowOk;
}

// ---- next occurrence -------------------------------------------

/**
 * The first instant strictly after `after` at which `recurrence` fires, or null
 * when it never will again (a one-shot already past, or an impossible cron).
 *
 * Strictly-after matters: the scheduler computes the *next* run from `now`
 * right after firing, and a rule whose next occurrence equalled the moment it
 * just ran would fire twice on the same tick.
 */
export function nextOccurrence(recurrence: Recurrence, timeZone: string, after: Date): Date | null {
  switch (recurrence.type) {
    case 'once': {
      const at = new Date(recurrence.at);
      if (Number.isNaN(at.getTime())) return null;
      return at > after ? at : null;
    }
    case 'everyNHours': {
      const anchor = new Date(recurrence.anchor);
      if (Number.isNaN(anchor.getTime())) return null;
      const interval = recurrence.hours * 3_600_000;
      if (anchor > after) return anchor;
      // Absolute spacing, deliberately: "every 12 hours" is a duration, and a
      // DST shift must not turn one gap into 11 or 13.
      const steps = Math.floor((after.getTime() - anchor.getTime()) / interval) + 1;
      return new Date(anchor.getTime() + steps * interval);
    }
    case 'hourly': {
      const p = localParts(after, timeZone);
      // Local hours rather than +1h steps: at a DST boundary the wall clock is
      // what the user set the rule in.
      for (let i = 0; i <= 48; i++) {
        const base = addLocalDays(p, Math.floor((p.hour + i) / 24));
        const candidate = zonedTimeToUtc(
          { ...base, hour: (p.hour + i) % 24, minute: recurrence.minute },
          timeZone,
        );
        if (candidate > after) return candidate;
      }
      return null;
    }
    case 'daily':
    case 'weekly': {
      const p = localParts(after, timeZone);
      for (let i = 0; i <= HORIZON_DAYS; i++) {
        const date = addLocalDays(p, i);
        if (recurrence.type === 'weekly' && localWeekday(date) !== recurrence.weekday) continue;
        const candidate = zonedTimeToUtc(
          { ...date, hour: recurrence.hour, minute: recurrence.minute },
          timeZone,
        );
        if (candidate > after) return candidate;
      }
      return null;
    }
    case 'cron': {
      const rule = parseCron(recurrence.expression);
      const p = localParts(after, timeZone);
      for (let i = 0; i <= HORIZON_DAYS; i++) {
        const date = addLocalDays(p, i);
        if (!cronDayMatches(rule, date)) continue;
        for (const hour of rule.hours) {
          for (const minute of rule.minutes) {
            const candidate = zonedTimeToUtc({ ...date, hour, minute }, timeZone);
            if (candidate > after) return candidate;
          }
        }
      }
      return null;
    }
  }
}
