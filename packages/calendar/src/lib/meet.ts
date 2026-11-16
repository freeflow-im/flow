// FreeFlow Meet on an event (docs/specs/meetings.md phase 3): "Add FreeFlow Meet" makes a meeting in the organization
// Calendar is showing and writes its link into the description as one line, `Join with FreeFlow Meet: <link>`, the way
// Google writes its Meet block. Any calendar the invitation reaches shows the line, and anyone with the link can join
// (a guest types a name). The event card reads the line back as its Join button (lib/conference.ts).
import { calendarWorkspace } from '../api';

export const MEET_LINE = 'Join with FreeFlow Meet:';
/** A Meet room's link, on any FreeFlow server: `https://<host>/meet/kqd-wmzt-fra`. */
export const MEET_URL = /https?:\/\/[^\s/]+\/meet\/[a-z]{3}-[a-z]{4}-[a-z]{3}(?![a-z-])/;
const LINE_RE = /^\s*Join with FreeFlow Meet:\s*(\S+)\s*$/im;

/** The Meet link a description carries, or null. */
export function meetLinkIn(description: string | null | undefined): string | null {
  const m = description ? LINE_RE.exec(description) : null;
  return m && MEET_URL.test(m[1]!) ? m[1]! : null;
}

/** The description with a Meet line at its end (replacing any it had). */
export function withMeetLink(description: string, url: string): string {
  const rest = withoutMeetLink(description);
  return `${rest}${rest ? '\n\n' : ''}${MEET_LINE} ${url}`;
}

/** The description without its Meet line. */
export function withoutMeetLink(description: string): string {
  return description.replace(new RegExp(LINE_RE.source, 'gim'), '').replace(/\n{3,}/g, '\n\n').trim();
}

/** Makes a meeting for this event and returns its link. */
export async function createMeetLink(title: string): Promise<string> {
  const org = calendarWorkspace();
  if (!org) throw new Error('Choose an organization first.');
  const res = await fetch(`/v1/workspaces/${encodeURIComponent(org)}/meetings`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(title.trim() ? { title: title.trim() } : {}),
  });
  const json = (await res.json().catch(() => null)) as { code?: string; error?: { message?: string } } | null;
  if (!res.ok || !json?.code) throw new Error(json?.error?.message ?? 'The meeting could not be made.');
  return `${window.location.origin}/meet/${json.code}`;
}
