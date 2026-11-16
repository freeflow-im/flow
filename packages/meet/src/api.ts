// What Meet asks the suite's API (the session cookie, same origin): the organization's object keeps the rooms and gives
// out RealtimeKit tokens (packages/edge/src/org/services/meetings.ts).
import type { LiveMeetingDTO, MeetingDTO, MeetingJoinDTO } from '@flow/shared';

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
  join: (ref: string) => call<MeetingJoinDTO>('POST', `/v1/meetings/${ref}/join`, {}),
};

/** A room's link: the page that joins it, by the room's short code. */
export const meetingUrl = (code: string) => new URL(`${import.meta.env.BASE_URL}${code}`, window.location.origin).toString();

/** The room a path names (`/meet/<code>`, or `/meet/<id>` from before codes), or null for Meet's home. */
export function meetingRefOf(pathname: string): string | null {
  const rest = pathname.startsWith(import.meta.env.BASE_URL) ? pathname.slice(import.meta.env.BASE_URL.length) : '';
  const id = rest.split('/')[0] ?? '';
  return /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(id) || /^[0-9a-f-]{36}$/.test(id) ? id : null;
}
