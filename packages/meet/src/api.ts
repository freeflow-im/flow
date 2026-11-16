// What Meet asks the suite's API (the session cookie, same origin): the organization's object keeps the rooms and gives
// out RealtimeKit tokens (packages/edge/src/org/services/meetings.ts).
import type { LiveMeetingDTO, MeetingDTO, MeetingGuestJoinDTO, MeetingJoinDTO, MeetingPreviewDTO } from '@flow/shared';

export class MeetApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
    throw new MeetApiError(res.status, err?.error?.code ?? 'error', err?.error?.message ?? `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export const api = {
  /** Whether Meet is set up on this server (`/v1/config` → `meet`). */
  enabled: async () => (await call<{ meet?: boolean }>('GET', '/v1/config')).meet === true,
  create: (workspaceId: string, title?: string) => call<MeetingDTO>('POST', `/v1/workspaces/${workspaceId}/meetings`, title ? { title } : {}),
  live: async (workspaceId: string) => (await call<{ meetings: LiveMeetingDTO[] }>('GET', `/v1/workspaces/${workspaceId}/meetings/live`)).meetings,
  /** A room, for a member of its organization (401 signed out, 404 for anyone else). */
  get: (ref: string) => call<MeetingDTO>('GET', `/v1/meetings/${ref}`),
  join: (ref: string) => call<MeetingJoinDTO>('POST', `/v1/meetings/${ref}/join`, {}),
  /** What the link shows anyone, signed in or not (phase 3's check screen). */
  preview: (code: string) => call<MeetingPreviewDTO>('GET', `/v1/meetings/${code}/guest`),
  joinAsGuest: (code: string, name: string) => call<MeetingGuestJoinDTO>('POST', `/v1/meetings/${code}/guest`, { name }),
  setLocked: (ref: string, locked: boolean) => call<MeetingDTO>('PATCH', `/v1/meetings/${ref}`, { locked }),
  leave: (ref: string) => call<{ ok: true }>('POST', `/v1/meetings/${ref}/leave`, {}),
  /** The tab is closing: a request that outlives the page (no answer is read). */
  leaveOnClose: (ref: string) => navigator.sendBeacon(`/v1/meetings/${ref}/leave`),
  /** The person's events between two times, from Calendar's API, in this organization (Meet home's Today list). */
  events: async (workspaceId: string, from: Date, to: Date) =>
    (
      await call<{ events: CalendarEvent[] }>(
        'GET',
        `/v1/calendar/events?from=${encodeURIComponent(from.toISOString())}&to=${encodeURIComponent(to.toISOString())}&workspace=${encodeURIComponent(workspaceId)}`,
      )
    ).events,
};

/** The fields of a Calendar event Meet's Today list reads (packages/calendar has the rest). */
export interface CalendarEvent {
  id: string;
  summary: string;
  start: string;
  end: string;
  allDay: boolean;
  status: 'confirmed' | 'tentative' | 'cancelled';
  location?: string | null;
  description?: string | null;
  conference?: { url: string; label: string };
}

/** Calendar's new-event editor with a FreeFlow Meet link already added (docs/specs/meetings.md §1.2). */
export const scheduleUrl = () => '/calendar/?new=&meet=1';

/** The room code in what someone pasted: a code (`kqd-wmzt-fra`, any case, dashes or not) or a Meet link. */
export function codeFrom(text: string): string | null {
  const t = text.trim().toLowerCase();
  const inLink = /\/meet\/([a-z]{3}-[a-z]{4}-[a-z]{3})(?![a-z-])/.exec(t);
  if (inLink) return inLink[1]!;
  const letters = t.replace(/[\s-]/g, '');
  return /^[a-z]{10}$/.test(letters) ? `${letters.slice(0, 3)}-${letters.slice(3, 7)}-${letters.slice(7)}` : null;
}

/** A guest's RealtimeKit participant id starts with this (the server's GUEST_ID_PREFIX). */
export const isGuestId = (id: string | undefined) => !!id?.startsWith('guest-');

/** The sign-in page, coming back to this room afterwards. */
export const signInUrl = (code: string) => `/?next=${encodeURIComponent(`${import.meta.env.BASE_URL}${code}`)}`;

/** A room's link: the page that joins it, by the room's short code. */
export const meetingUrl = (code: string) => new URL(`${import.meta.env.BASE_URL}${code}`, window.location.origin).toString();

/** The room a path names (`/meet/<code>`, or `/meet/<id>` from before codes), or null for Meet's home. */
export function meetingRefOf(pathname: string): string | null {
  const rest = pathname.startsWith(import.meta.env.BASE_URL) ? pathname.slice(import.meta.env.BASE_URL.length) : '';
  const id = rest.split('/')[0] ?? '';
  return /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(id) || /^[0-9a-f-]{36}$/.test(id) ? id : null;
}
