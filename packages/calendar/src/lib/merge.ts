// The grid's events from every calendar, one copy per event (platform phase 4.5): an invitation on the person's own
// calendar and the organizer's copy on a calendar shared with them share a UID; the person's own wins (it carries the
// RSVP), and between two shared calendars the first. Only shown calendars count, so hiding one brings the other back. Pure.
import type { CalendarInfo, EventOccurrence } from '../api';

/** An occurrence with the other shown calendars the same event is on. */
export type Merged = EventOccurrence & { alsoOn?: string[] };

/** The occurrence's key across calendars: its id less the `<calendarId>:` prefix (the UID, and the recurrence id). */
export const uidKey = (o: Pick<EventOccurrence, 'id' | 'calendarId'>) => (o.id.startsWith(`${o.calendarId}:`) ? o.id.slice(o.calendarId.length + 1) : o.id);

export function mergeByUid(list: EventOccurrence[], calendars: CalendarInfo[]): Merged[] {
  const byId = new Map(calendars.map((c) => [c.id, c]));
  const shown = (o: EventOccurrence) => { const c = byId.get(o.calendarId); return !!c && !c.hidden; };
  const kept = new Map<string, Merged>();
  const rest: EventOccurrence[] = [];
  // Own calendars first, then shared ones in order, so the first to claim a key is the one kept.
  const ordered = [...list.filter((o) => !byId.get(o.calendarId)?.shared), ...list.filter((o) => !!byId.get(o.calendarId)?.shared)];
  for (const o of ordered) {
    if (!shown(o)) { rest.push(o); continue; }
    const k = uidKey(o);
    const first = kept.get(k);
    if (!first) kept.set(k, { ...o });
    else if (first.calendarId !== o.calendarId) first.alsoOn = [...(first.alsoOn ?? []), o.calendarId];
  }
  return [...kept.values(), ...rest];
}

/** The card's muted line for the calendars it is also on, by their owners' names. */
export function alsoOnNote(o: Merged, calendars: CalendarInfo[], ownerName: (accountId: string) => string): string | null {
  const names = [...new Set((o.alsoOn ?? []).map((id) => calendars.find((c) => c.id === id)).map((c) => (c?.shared ? `${ownerName(c.shared.ownerAccountId)}'s calendar` : c?.name ?? 'another calendar')))];
  return names.length ? `Also on ${names.join(', ')}` : null;
}
