// The API's occurrences as FullCalendar's events and back (docs/specs/calendar.md §2.6: the grid only draws them): colours
// from the calendar, the look of a declined or unanswered invitation, what a drag or resize asks the API for, and the same
// change made to a cached window at once (optimistic, rolled back on failure).
import { format } from 'date-fns';
import type { EventInput as FcEventInput } from '@fullcalendar/core';
import type { CalendarInfo, EventOccurrence, EventPatch, Scope } from '../api';
import { parseDate } from './ranges';

/** Black or white text, whichever reads on a colour. */
export function textOn(hex: string): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex);
  if (!m) return '#ffffff';
  const lin = (x: string | undefined) => { const c = parseInt(x ?? '0', 16) / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * lin(m[1]) + 0.7152 * lin(m[2]) + 0.0722 * lin(m[3]) > 0.45 ? '#1f1f1f' : '#ffffff';
}

export function toFcEvent(o: EventOccurrence, cal: CalendarInfo | undefined): FcEventInput {
  const color = cal?.color ?? '#1a73e8';
  const pending = o.myResponse === 'needs-action' || o.myResponse === 'tentative';
  return {
    id: o.id,
    title: o.summary || '(No title)',
    start: o.start,
    end: o.end,
    allDay: o.allDay,
    backgroundColor: pending ? '#ffffff' : color,
    borderColor: color,
    textColor: pending ? color : textOn(color),
    editable: !!cal && cal.role !== 'reader',
    classNames: [o.myResponse === 'declined' ? 'cal-declined' : '', pending ? 'cal-pending' : '', o.status === 'cancelled' ? 'cal-cancelled' : ''].filter(Boolean),
    extendedProps: { occurrence: o },
  };
}

/** A FullCalendar time as the API writes it: a date for all-day, an ISO instant otherwise. */
export const apiTime = (d: Date, allDay: boolean) => (allDay ? format(d, 'yyyy-MM-dd') : d.toISOString());

/** What a drag or resize asks for: the new start and end, all-day or not (FullCalendar's end is null for a default length). */
export function movePatch(o: EventOccurrence, start: Date, end: Date | null, allDay: boolean, scope: Scope | undefined): EventPatch {
  const length = allDay ? 86_400_000 : o.allDay ? 3_600_000 : Date.parse(o.end) - Date.parse(o.start);
  const to = end ?? new Date(+start + length);
  return { start: apiTime(start, allDay), end: apiTime(to, allDay), ...(allDay !== o.allDay ? { allDay } : {}), ...(scope ? { scope } : {}), etag: o.etag };
}

const ms = (iso: string, allDay: boolean) => (allDay ? +parseDate(iso) : Date.parse(iso));
const iso = (t: number, allDay: boolean) => (allDay ? format(new Date(t), 'yyyy-MM-dd') : new Date(t).toISOString());

/**
 * A cached window's occurrences after a change to one of them, as the server will have it: the occurrence itself (`this`,
 * or a plain event), every occurrence of the series moved by as much (`all`), or this one and those after it (`following`).
 * Times move by the start's change; a patch's end sets the length. The server's answer replaces this guess.
 */
export function applyPatch(list: EventOccurrence[], target: EventOccurrence, patch: EventPatch, scope: Scope): EventOccurrence[] {
  const allDay = patch.allDay ?? target.allDay;
  const newStart = patch.start !== undefined ? ms(patch.start, allDay) : ms(target.start, target.allDay);
  const delta = patch.start !== undefined && allDay === target.allDay ? newStart - ms(target.start, target.allDay) : 0;
  const length = patch.end !== undefined ? ms(patch.end, allDay) - newStart : null;
  const fields = { ...(patch.summary !== undefined ? { summary: patch.summary } : {}), ...(patch.location !== undefined ? { location: patch.location } : {}), ...(patch.description !== undefined ? { description: patch.description } : {}) };
  const hit = (o: EventOccurrence) => o.id === target.id || (target.recurring && o.eventId === target.eventId && (scope === 'all' || (scope === 'following' && o.start >= target.start)));
  return list.map((o) => {
    if (!hit(o)) return o;
    if (o.id === target.id && (allDay !== o.allDay || patch.start !== undefined)) {
      const end = length !== null ? newStart + length : newStart + (ms(o.end, o.allDay) - ms(o.start, o.allDay));
      return { ...o, ...fields, allDay, start: iso(newStart, allDay), end: iso(end, allDay) };
    }
    const s = ms(o.start, o.allDay) + delta;
    const e = length !== null ? s + length : ms(o.end, o.allDay) + delta;
    return { ...o, ...fields, start: iso(s, o.allDay), end: iso(e, o.allDay) };
  });
}

/** A cached window after a delete: the occurrence (`this`), it and those after (`following`), or the whole event (`all`). */
export function applyDelete(list: EventOccurrence[], target: EventOccurrence, scope: Scope): EventOccurrence[] {
  return list.filter((o) => !(o.id === target.id || (o.eventId === target.eventId && (scope === 'all' || (scope === 'following' && o.start >= target.start)))));
}

/** The scope an occurrence's change asks for: none for a plain event, else what the person chose. */
export const needsScope = (o: EventOccurrence) => o.recurring;
