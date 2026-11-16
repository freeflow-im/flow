// The video call an event on the Today card joins (Meet phase 3, "Home Today Join"): the call the server read from the
// invitation, else a FreeFlow Meet line in the description (Calendar's "Add FreeFlow Meet"), else a known call link in
// the location or description. Calendar's card reads a fuller set (packages/calendar/src/lib/conference.ts).
import type { CalendarEvent } from '../api';

const MEET_LINE = /^\s*Join with FreeFlow Meet:\s*(https?:\/\/\S+)/im;
const CALL_URL = /https?:\/\/(?:[^\s/]+\/meet\/[a-z]{3}-[a-z]{4}-[a-z]{3}(?![a-z-])|meet\.google\.com\/[^\s<>"')]+|[\w.-]*zoom\.us\/j\/[^\s<>"')]+|teams\.(?:microsoft|live)\.com\/[^\s<>"')]+)/i;

export function joinLink(e: Pick<CalendarEvent, 'conference' | 'description' | 'location'>): string | null {
  if (e.conference?.url) return e.conference.url;
  const line = e.description ? MEET_LINE.exec(e.description)?.[1] : undefined;
  if (line) return line;
  return CALL_URL.exec(e.location ?? '')?.[0] ?? CALL_URL.exec(e.description ?? '')?.[0] ?? null;
}
