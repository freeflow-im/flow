// The address (docs/specs/calendar.md §5): /calendar/week/2026-11-09, /calendar/month/2026-11, /calendar/day/2026-11-09,
// /calendar/agenda (or /agenda/2026-11-09), with ?event=<id> for an open event, so links from Mail and the assistant land on it.
import { format } from 'date-fns';
import { parseDate, type View } from './ranges';

export interface Place { view: View; date: Date; eventId: string | null }

export function parsePlace(pathname: string, search: string, base: string, today = new Date()): Place {
  const rest = pathname.startsWith(base) ? pathname.slice(base.length) : pathname.replace(/^\/calendar\/?/, '');
  const [view, date] = rest.replace(/^\/+|\/+$/g, '').split('/');
  const eventId = new URLSearchParams(search).get('event');
  const v: View = view === 'day' || view === 'month' || view === 'agenda' || view === 'week' ? view : 'week';
  let d = today;
  if (date && /^\d{4}-\d\d(-\d\d)?$/.test(date)) {
    const parsed = parseDate(date.length === 7 ? `${date}-01` : date);
    if (!Number.isNaN(+parsed)) d = parsed;
  }
  return { view: v, date: d, eventId };
}

export function pathOf(p: Place, base: string): string {
  const b = base.endsWith('/') ? base : `${base}/`;
  const date = p.view === 'month' ? format(p.date, 'yyyy-MM') : format(p.date, 'yyyy-MM-dd');
  return `${b}${p.view}/${date}${p.eventId ? `?event=${encodeURIComponent(p.eventId)}` : ''}`;
}
