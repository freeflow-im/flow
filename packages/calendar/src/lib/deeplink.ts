// "Create event" from elsewhere in the suite (docs/specs/calendar.md §14): Mail's thread menu opens
// `/calendar/?new=<title>&guests=Ann Lee <ann@x.org>,bo@y.org`, and Calendar opens the edit dialog with them filled in.
// A share's notice links `/calendar/?calendar=<id>` (phase 4.1's address): Calendar opens with that calendar ticked.
// Pure: what the address asks for, and the address without it.

export interface NewEventLink { summary: string; attendees: { email: string; name?: string }[] }

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
  return { summary: (q.get('new') ?? '').trim().slice(0, 1000), attendees };
}

/** The query string with `new` and `guests` taken out ('' when nothing is left; else with its `?`). */
export function withoutNewEvent(search: string): string {
  const q = new URLSearchParams(search);
  q.delete('new');
  q.delete('guests');
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
