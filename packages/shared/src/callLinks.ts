// The video call a calendar event joins, for the suite's Join buttons (Home's Today card, Meet's Today list): the call
// the server read from the invitation, else a FreeFlow Meet line in the description (Calendar's "Add FreeFlow Meet",
// docs/specs/meetings.md phase 3), else a known call link in the location or description. Calendar's own card reads a
// fuller set (packages/calendar/src/lib/conference.ts).

export interface CallLinkSource {
  conference?: { url: string; label?: string } | null;
  description?: string | null;
  location?: string | null;
}

const MEET_LINE = /^\s*Join with FreeFlow Meet:\s*(https?:\/\/\S+)/im;
const CALL_URL = /https?:\/\/(?:[^\s/]+\/meet\/[a-z]{3}-[a-z]{4}-[a-z]{3}(?![a-z-])|meet\.google\.com\/[^\s<>"')]+|[\w.-]*zoom\.us\/j\/[^\s<>"')]+|teams\.(?:microsoft|live)\.com\/[^\s<>"')]+)/i;

/** The link an event's Join button opens, or null when it has no call. */
export function joinLink(e: CallLinkSource): string | null {
  if (e.conference?.url) return e.conference.url;
  const line = e.description ? MEET_LINE.exec(e.description)?.[1] : undefined;
  if (line) return line;
  return CALL_URL.exec(e.location ?? '')?.[0] ?? CALL_URL.exec(e.description ?? '')?.[0] ?? null;
}

/** The kind of call a link is, for a label: FreeFlow Meet, Google Meet, Zoom, Teams, or null. */
export function callKind(url: string): 'FreeFlow Meet' | 'Google Meet' | 'Zoom' | 'Teams' | null {
  if (/\/meet\/[a-z]{3}-[a-z]{4}-[a-z]{3}(?![a-z-])/.test(url) && !/meet\.google\.com/i.test(url)) return 'FreeFlow Meet';
  if (/meet\.google\.com/i.test(url)) return 'Google Meet';
  if (/zoom\.us\//i.test(url)) return 'Zoom';
  if (/teams\.(microsoft|live)\.com/i.test(url)) return 'Teams';
  return null;
}
