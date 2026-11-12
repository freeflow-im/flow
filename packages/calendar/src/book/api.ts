// The guest scheduler's public API (packages/edge src/routes/book.ts, docs/specs/guest-scheduler.md §3.3): no session. A
// page is `/v1/book/<token>`, one booking's own link `/v1/book/m/<manage token>`; both answer `{ error: { code, message } }`
// on failure, and a slot taken meanwhile is 409 `slot_taken` with that day's starts.

export interface PageInfo {
  ownerName: string;
  title: string;
  description: string;
  durations: number[];
  defaultDuration: number;
  /** `link`: a video call, given with the confirmation; `text`: an address shown now. */
  location: { kind: 'none' | 'text' | 'link'; label: string | null };
  ownerTimezone: string;
  horizonEnd: string;
}
export interface Booking {
  id: string;
  status: 'booked' | 'cancelled';
  start: string;
  end: string;
  duration: number;
  guestName: string;
  timezone: string;
  title: string;
  ownerName: string;
  location: string | null;
  canReschedule: boolean;
  canCancel: boolean;
}

export class BookError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly body: Record<string, unknown> = {}) { super(message); }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { ...init, headers: { ...(init?.body ? { 'content-type': 'application/json' } : {}), ...init?.headers } });
  const body = (await res.json().catch(() => ({}))) as Record<string, any>;
  if (!res.ok) throw new BookError(res.status, body.error?.code ?? 'server_error', body.error?.message ?? 'Something went wrong; try again', body);
  return body as T;
}

/** Where a page's or a booking's requests go: `/v1/book/<token>` or `/v1/book/m/<manage>`. */
export type Base = string;
const q = (o: Record<string, string | number>) => new URLSearchParams(Object.entries(o).map(([k, v]) => [k, String(v)])).toString();

export const getPage = (base: Base) => call<{ page: PageInfo }>(base);
export const getManaged = (base: Base) => call<{ booking: Booking; page: PageInfo }>(base);
export const getDays = (base: Base, month: string, duration: number, tz: string) => call<{ days: string[]; syncing?: true }>(`${base}/days?${q({ month, duration, tz })}`);
export const getSlots = (base: Base, date: string, duration: number, tz: string) => call<{ slots: string[] }>(`${base}/slots?${q({ date, duration, tz })}`);
export const book = (base: Base, body: { start: string; duration: number; name: string; email: string; note?: string; tz: string; website?: string }) =>
  call<{ booking: Booking; manageUrl: string }>(base, { method: 'POST', body: JSON.stringify(body) });
export const reschedule = (base: Base, body: { start: string; duration: number; tz: string }) => call<{ booking: Booking }>(`${base}/reschedule`, { method: 'POST', body: JSON.stringify(body) });
export const cancel = (base: Base) => call<{ booking: Booking }>(`${base}/cancel`, { method: 'POST' });

/** What the address names: `/calendar/book/<token>` (a page) or `/calendar/book/m/<manage>` (a booking). */
export function routeOf(pathname: string): { kind: 'page' | 'manage'; base: Base } | null {
  const m = /^\/calendar\/book\/(?:(m)\/)?([A-Za-z0-9_-]+)\/?$/.exec(pathname);
  if (!m) return null;
  return m[1] ? { kind: 'manage', base: `/v1/book/m/${m[2]}` } : { kind: 'page', base: `/v1/book/${m[2]}` };
}
