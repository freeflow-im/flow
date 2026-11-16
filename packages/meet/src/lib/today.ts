// Meet home's Today list (docs/specs/meetings.md §2.1): the calls left on the person's calendar today, from Calendar's
// API. A call is any event with a Join link: FreeFlow Meet, and the Google Meet, Zoom and Teams links Calendar reads
// (@flow/shared callLinks.ts), so it is one list of all their calls.
import { callKind, joinLink } from '@flow/shared';
import type { CalendarEvent } from '../api';

export interface TodayCall {
  id: string;
  title: string;
  start: Date;
  end: Date;
  url: string;
  /** "FreeFlow Meet", "Zoom", …; null for a link of another kind. */
  kind: string | null;
  /** Started and not yet over. */
  now: boolean;
}

/** From the start of `now`'s day to the start of the next, in the browser's time zone. */
export function dayAround(now: Date): { from: Date; to: Date } {
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return { from, to: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1) };
}

/** Today's calls not yet over, earliest first. All-day and cancelled events are left out. */
export function todayCalls(events: CalendarEvent[], now: Date): TodayCall[] {
  const out: TodayCall[] = [];
  for (const e of events) {
    if (e.allDay || e.status === 'cancelled') continue;
    const url = joinLink(e);
    if (!url) continue;
    const start = new Date(e.start), end = new Date(e.end);
    if (end <= now) continue;
    out.push({ id: e.id, title: e.summary || '(No title)', start, end, url, kind: callKind(url), now: start <= now });
  }
  return out.sort((a, b) => +a.start - +b.start);
}
