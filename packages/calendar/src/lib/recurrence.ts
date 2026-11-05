// Repeating events in the edit dialog (docs/specs/calendar.md §5): the usual presets for an event's start, a custom rule
// (every N days, weeks on some days, months or years; ending never, after N times or on a date), each as an RRULE line and
// back, and the rule put in words ("Every 2 weeks on Tuesday and Thursday, 10 times").
import { format } from 'date-fns';

export type Freq = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';
export const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const;
export type Weekday = (typeof WEEKDAYS)[number];
const DAY_NAMES: Record<Weekday, string> = { SU: 'Sunday', MO: 'Monday', TU: 'Tuesday', WE: 'Wednesday', TH: 'Thursday', FR: 'Friday', SA: 'Saturday' };
const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth'];

export interface Rule {
  freq: Freq;
  interval: number;
  /** WEEKLY: the days. MONTHLY: one entry with its position ("2TU", "-1FR") for "on the second Tuesday". */
  byday: string[];
  /** MONTHLY: the day of the month. */
  bymonthday?: number;
  end: { kind: 'never' } | { kind: 'count'; count: number } | { kind: 'until'; date: string };
}

export function parseRule(line: string): Rule | null {
  const value = line.replace(/^RRULE:/i, '').trim();
  const parts = new Map(value.split(';').map((p) => { const [k = '', v = ''] = p.split('='); return [k.toUpperCase(), v] as const; }));
  const freq = parts.get('FREQ') as Freq | undefined;
  if (!freq || !['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'].includes(freq)) return null;
  const known = new Set(['FREQ', 'INTERVAL', 'BYDAY', 'BYMONTHDAY', 'COUNT', 'UNTIL', 'WKST', 'BYMONTH']);
  if ([...parts.keys()].some((k) => !known.has(k))) return null;
  const until = parts.get('UNTIL');
  const count = Number(parts.get('COUNT'));
  return {
    freq,
    interval: Math.max(1, Number(parts.get('INTERVAL')) || 1),
    byday: parts.get('BYDAY') ? parts.get('BYDAY')!.split(',') : [],
    ...(parts.get('BYMONTHDAY') ? { bymonthday: Number(parts.get('BYMONTHDAY')) } : {}),
    end: until ? { kind: 'until', date: `${until.slice(0, 4)}-${until.slice(4, 6)}-${until.slice(6, 8)}` } : count ? { kind: 'count', count } : { kind: 'never' },
  };
}

export function ruleLine(r: Rule): string {
  const parts = [`FREQ=${r.freq}`];
  if (r.interval > 1) parts.push(`INTERVAL=${r.interval}`);
  if (r.byday.length) parts.push(`BYDAY=${r.byday.join(',')}`);
  if (r.bymonthday) parts.push(`BYMONTHDAY=${r.bymonthday}`);
  if (r.end.kind === 'count') parts.push(`COUNT=${r.end.count}`);
  if (r.end.kind === 'until') parts.push(`UNTIL=${r.end.date.replace(/-/g, '')}T235959Z`);
  return `RRULE:${parts.join(';')}`;
}

const weekday = (d: Date): Weekday => WEEKDAYS[d.getDay()] ?? 'SU';
/** "2TU" for the second Tuesday, "-1TU" when it is the month's last. */
export function positionOf(d: Date): string {
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  return d.getDate() + 7 > last ? `-1${weekday(d)}` : `${Math.ceil(d.getDate() / 7)}${weekday(d)}`;
}

export type PresetId = 'none' | 'daily' | 'weekly' | 'weekdays' | 'monthly-day' | 'monthly-position' | 'yearly' | 'custom';
export interface Preset { id: PresetId; label: string; line: string | null }

/** The repeat choices for an event starting on `start`, as Google Calendar offers them. */
export function presetsFor(start: Date): Preset[] {
  const pos = positionOf(start);
  const nth = pos.startsWith('-1') ? 'last' : ORDINALS[Number(pos[0]) - 1] ?? 'first';
  return [
    { id: 'none', label: 'Does not repeat', line: null },
    { id: 'daily', label: 'Daily', line: 'RRULE:FREQ=DAILY' },
    { id: 'weekly', label: `Weekly on ${DAY_NAMES[weekday(start)]}`, line: `RRULE:FREQ=WEEKLY;BYDAY=${weekday(start)}` },
    { id: 'weekdays', label: 'Every weekday (Monday to Friday)', line: 'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR' },
    { id: 'monthly-day', label: `Monthly on day ${start.getDate()}`, line: `RRULE:FREQ=MONTHLY;BYMONTHDAY=${start.getDate()}` },
    { id: 'monthly-position', label: `Monthly on the ${nth} ${DAY_NAMES[weekday(start)]}`, line: `RRULE:FREQ=MONTHLY;BYDAY=${pos}` },
    { id: 'yearly', label: `Annually on ${format(start, 'MMMM d')}`, line: 'RRULE:FREQ=YEARLY' },
    { id: 'custom', label: 'Custom…', line: null },
  ];
}

const norm = (line: string) => { const r = parseRule(line); return r ? ruleLine(r) : line.trim().toUpperCase(); };
/** Which preset an event's recurrence lines are, for its start ('custom' for anything else; 'none' for none). */
export function presetOf(lines: string[] | undefined | null, start: Date): PresetId {
  const rrules = (lines ?? []).filter((l) => /^RRULE/i.test(l));
  if (!rrules.length) return 'none';
  if (rrules.length > 1 || (lines ?? []).some((l) => /^RDATE/i.test(l))) return 'custom';
  const found = presetsFor(start).find((p) => p.line && norm(p.line) === norm(rrules[0] ?? ''));
  return found?.id ?? 'custom';
}

const list = (xs: string[]) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`);
/** A rule in words. */
export function describeRule(line: string): string {
  const r = parseRule(line);
  if (!r) return 'Repeats';
  const n = r.interval;
  const unit = { DAILY: 'day', WEEKLY: 'week', MONTHLY: 'month', YEARLY: 'year' }[r.freq];
  let text: string;
  const days = r.byday.filter((d) => d in DAY_NAMES) as Weekday[];
  if (r.freq === 'WEEKLY' && days.length === 5 && ['MO', 'TU', 'WE', 'TH', 'FR'].every((d) => days.includes(d as Weekday)) && n === 1) text = 'Every weekday';
  else if (n === 1) text = { DAILY: 'Daily', WEEKLY: 'Weekly', MONTHLY: 'Monthly', YEARLY: 'Annually' }[r.freq];
  else text = `Every ${n} ${unit}s`;
  if (r.freq === 'WEEKLY' && days.length && text !== 'Every weekday') text += ` on ${list(days.map((d) => DAY_NAMES[d]))}`;
  if (r.freq === 'MONTHLY' && r.bymonthday) text += ` on day ${r.bymonthday}`;
  const pos = r.freq === 'MONTHLY' ? /^(-?\d)(\w\w)$/.exec(r.byday[0] ?? '') : null;
  if (pos) text += ` on the ${pos[1] === '-1' ? 'last' : ORDINALS[Number(pos[1]) - 1]} ${DAY_NAMES[(pos[2] ?? 'SU') as Weekday]}`;
  if (r.end.kind === 'count') text += `, ${r.end.count} ${r.end.count === 1 ? 'time' : 'times'}`;
  if (r.end.kind === 'until') { const [y = 1970, m = 1, d = 1] = r.end.date.split('-').map(Number); text += `, until ${format(new Date(y, m - 1, d), 'MMM d, yyyy')}`; }
  return text;
}

/** The recurrence of an event in words, from its lines (an RRULE; RDATEs and EXDATEs are not spelled out). */
export function describeRecurrence(lines: string[] | undefined): string | null {
  const rrule = lines?.find((l) => /^RRULE/i.test(l));
  return rrule ? describeRule(rrule) : lines?.length ? 'Repeats on chosen dates' : null;
}

/** A custom rule's starting point for an event: weekly on its day. */
export const defaultRule = (start: Date): Rule => ({ freq: 'WEEKLY', interval: 1, byday: [weekday(start)], end: { kind: 'never' } });

/** The lines a series keeps when its rule changes: its EXDATEs and RDATEs stay, the RRULE is replaced (or removed). */
export function withRule(lines: string[] | undefined, line: string | null): string[] {
  const rest = (lines ?? []).filter((l) => !/^RRULE/i.test(l));
  return line ? [line, ...rest] : rest.filter((l) => !/^EXDATE/i.test(l));
}
