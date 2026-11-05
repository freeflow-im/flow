// The views and the ranges they show (docs/specs/calendar.md §5): which days a view covers for a date, a step back or on,
// the neighbours to read ahead, the title, and FullCalendar's name for the view. Local time throughout: the views are in
// the browser's zone, and the API is asked for the instants those days begin and end at.
import { addDays, addMonths, addWeeks, endOfMonth, format, isSameMonth, isSameYear, startOfDay, startOfMonth, startOfWeek } from 'date-fns';

export type View = 'day' | 'week' | 'month' | 'agenda';
export const VIEWS: View[] = ['day', 'week', 'month', 'agenda'];
export interface Range { start: Date; end: Date }

/** FullCalendar's view for ours. */
export const fcView = (v: View) => ({ day: 'timeGridDay', week: 'timeGridWeek', month: 'dayGridMonth', agenda: 'listWeek' })[v];

/** The days a view shows around a date: a day, a week, six weeks for a month (as FullCalendar draws it), a week of agenda. */
export function rangeOf(view: View, date: Date, weekStartsOn: 0 | 1 = 0): Range {
  if (view === 'day') { const start = startOfDay(date); return { start, end: addDays(start, 1) }; }
  if (view === 'month') { const start = startOfWeek(startOfMonth(date), { weekStartsOn }); return { start, end: addDays(start, 42) }; }
  const start = startOfWeek(date, { weekStartsOn });
  return { start, end: addDays(start, 7) };
}

/** A view's date moved one step: a day, a week, or a month (to the same day of the month, or its last). */
export function step(view: View, date: Date, dir: 1 | -1): Date {
  if (view === 'day') return addDays(date, dir);
  if (view === 'month') return addMonths(date, dir);
  return addWeeks(date, dir);
}

/** The ranges on either side of a view's, read ahead so a step back or on shows at once. */
export const neighbours = (view: View, date: Date, weekStartsOn: 0 | 1 = 0): Range[] => [rangeOf(view, step(view, date, -1), weekStartsOn), rangeOf(view, step(view, date, 1), weekStartsOn)];

/** The toolbar's title: "November 2026", "Nov 8 – 14, 2026", "Monday, November 9, 2026". */
export function titleOf(view: View, date: Date, weekStartsOn: 0 | 1 = 0): string {
  if (view === 'day') return format(date, 'EEEE, MMMM d, yyyy');
  if (view === 'month') return format(date, 'MMMM yyyy');
  const { start } = rangeOf(view, date, weekStartsOn);
  const last = addDays(start, 6);
  if (isSameMonth(start, last)) return `${format(start, 'MMM d')} – ${format(last, 'd, yyyy')}`;
  if (isSameYear(start, last)) return `${format(start, 'MMM d')} – ${format(last, 'MMM d, yyyy')}`;
  return `${format(start, 'MMM d, yyyy')} – ${format(last, 'MMM d, yyyy')}`;
}

/** A range as the API asks for it, and as the cache keys it. */
export const rangeKey = (r: Range) => ({ from: r.start.toISOString(), to: r.end.toISOString() });
export const sameRange = (a: Range, b: Range) => +a.start === +b.start && +a.end === +b.end;
/** Whether an occurrence (ISO start and end, dates for all-day) falls in a range. */
export function overlaps(r: Range, start: string, end: string, allDay: boolean): boolean {
  const s = allDay ? parseDate(start) : new Date(start);
  const e = allDay ? parseDate(end) : new Date(end);
  return s < r.end && (e > r.start || (+e === +s && s >= r.start));
}
/** A date (`2026-11-05`) as local midnight. */
export const parseDate = (d: string) => { const [y = 1970, m = 1, day = 1] = d.slice(0, 10).split('-').map(Number); return new Date(y, m - 1, day); };
export const dateText = (d: Date) => format(d, 'yyyy-MM-dd');
export { endOfMonth };
