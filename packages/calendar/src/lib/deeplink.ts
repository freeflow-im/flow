// "Create event" from elsewhere in the suite (docs/specs/calendar.md §14): Mail's thread menu opens
// `/calendar/?new=<title>&guests=Ann Lee <ann@x.org>,bo@y.org`, and Calendar opens the edit dialog with them filled in.
// A share's notice links `/calendar/?calendar=<id>` (phase 4.1's address): Calendar opens with that calendar ticked.
// The suite's intents (@flow/suite-bar intents, platform phase 6.4) write these: `create` the `?new=` one (with an
// optional `start`), and `share` `/calendar/?share=<ref>`, which opens the calendar's Share dialog.
// Pure: what the address asks for, and the address without it.

export interface NewEventLink { summary: string; attendees: { email: string; name?: string }[]; start?: Date }

const ADDRESS = /^[^\s@<>,]+@[^\s@<>,]+\.[^\s@<>,]+$/;

/** What `?new=` asks for (the title, and the guests as `Name <address>` or `address`, comma-separated), or null. */
export function parseNewEvent(search: string): NewEventLink | null {
  const q = new URLSearchParams(search);
  if (!q.has('new')) return null;
  const seen = new Set<string>();
  const attendees: NewEventLink['attendees'] = [];
  for (const raw of (q.get('guests') ?? '').split(',')) {
    const t = raw.trim();
    const m = /^(.*?)\s*<([^<>]+)>$/.exec(t);
    const email = (m ? m[2]! : t).trim().toLowerCase();
    if (!ADDRESS.test(email) || seen.has(email) || attendees.length >= 50) continue;
    seen.add(email);
    const name = m?.[1]?.trim().replace(/^"|"$/g, '');
    attendees.push({ email, ...(name ? { name } : {}) });
  }
  const start = q.get('start') ? new Date(q.get('start')!) : null;
  return { summary: (q.get('new') ?? '').trim().slice(0, 1000), attendees, ...(start && !Number.isNaN(+start) ? { start } : {}) };
}

/** The query string with `new` and `guests` taken out ('' when nothing is left; else with its `?`). */
export function withoutNewEvent(search: string): string {
  const q = new URLSearchParams(search);
  q.delete('new');
  q.delete('guests');
  q.delete('start');
  const s = q.toString();
  return s ? `?${s}` : '';
}

/** The calendar a share's link names (`?calendar=<id>`), or null. */
export function parseCalendarLink(search: string): string | null {
  const id = new URLSearchParams(search).get('calendar')?.trim();
  return id && id.length <= 200 ? id : null;
}

/** The query string with `calendar` taken out ('' when nothing is left; else with its `?`). */
export function withoutCalendarLink(search: string): string {
  const q = new URLSearchParams(search);
  q.delete('calendar');
  const s = q.toString();
  return s ? `?${s}` : '';
}

/** The calendar a share intent names (`?share=<org>/calendar/calendar/<id>`, or an event's, whose calendar it is), or null. */
export function parseShareLink(search: string): string | null {
  const m = /^[^/]+\/calendar\/(calendar|event)\/(.+)$/.exec(new URLSearchParams(search).get('share')?.trim() ?? '');
  const id = m ? (m[1] === 'event' ? m[2]!.split(':')[0]! : m[2]!) : '';
  return id && id.length <= 200 ? id : null;
}

/** The query string with `share` taken out ('' when nothing is left; else with its `?`). */
export function withoutShareLink(search: string): string {
  const q = new URLSearchParams(search);
  q.delete('share');
  const s = q.toString();
  return s ? `?${s}` : '';
}
