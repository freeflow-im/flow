// The calendar API on the edge Worker (packages/edge, /v1/calendar/*), typed as its contract states it
// (docs/specs/calendar.md §4). Same origin, with the suite's session cookie; a 401 means the session ended, and the
// suite's sign-in page brings the person back here.
import { readActiveOrganization } from './suite';

export type AccountStatus = 'ok' | 'auth_failed' | 'connect_failed';
export interface CalendarAccount {
  id: string;
  /** `native`: the account's own FreeFlow calendar (no server, no account form). */
  kind: 'caldav' | 'google' | 'native';
  email: string;
  displayName: string;
  server?: { url: string; username: string };
  status: AccountStatus;
  statusMessage?: string;
}
export interface CalendarInfo {
  id: string;
  accountId: string;
  name: string;
  color: string;
  timezone: string | null;
  role: 'owner' | 'writer' | 'reader';
  hidden: boolean;
  isDefault: boolean;
  /** Null until the calendar's first sync. */
  syncedAt: string | null;
  /** Another account's native calendar shared with this person (`GET /v1/calendar/shared`, phase 4.4); `role` above is then
   * `reader` for a viewer, `writer` for an editor or manager. */
  shared?: { ownerAccountId: string; role: GrantRole; principal: string };
}
/** A role a calendar is shared with (platform.md §4.3). */
export type GrantRole = 'viewer' | 'editor' | 'manager';
/** One grant on a native calendar: `account:<id>`, `channel:<id>` or `org`. */
export interface CalendarGrant { principal: string; role: GrantRole; grantedBy: string; grantedAt: string }
/** A calendar's grants, and the caller's own role on it. */
export interface CalendarSharing { grants: CalendarGrant[]; role: GrantRole | 'owner' | null }
/** A native calendar of another account shared with this person, and the principal it is shared through. */
export interface SharedCalendar { id: string; name: string; color: string; role: GrantRole; ownerAccountId: string; grantedBy: string; url: string; principal: string }
export type Response = 'accepted' | 'declined' | 'tentative' | 'needs-action';
/** `accountId`: on a native event, the platform account the address resolved to (a member); none for someone outside. */
export interface Attendee { name: string | null; email: string; role: 'required' | 'optional'; response: Response; self?: true; accountId?: string }
/** What the views show: one per occurrence of a recurring event. */
export interface EventOccurrence {
  /** `<calendarId>:<uid>` for an event, `<calendarId>:<uid>:<recurrenceId>` for one occurrence. */
  id: string;
  /** The event (the series as a whole). */
  eventId: string;
  calendarId: string;
  summary: string;
  location: string | null;
  description: string | null;
  /** ISO instants; dates (`2026-11-05`, the end exclusive) for an all-day event. */
  start: string;
  end: string;
  allDay: boolean;
  timezone: string | null;
  recurring: boolean;
  recurrenceId?: string;
  status: 'confirmed' | 'tentative' | 'cancelled';
  organizer: Attendee | null;
  attendees: Attendee[];
  myResponse?: Response;
  conference?: { url: string; label: string };
  etag: string;
  updated: string;
  reminders: number[];
  /** The series' RRULE / RDATE / EXDATE lines. */
  recurrence?: string[];
  transparent?: true;
}
export interface EventInput {
  calendarId?: string;
  summary: string;
  location?: string | null;
  description?: string | null;
  start: string;
  end: string;
  allDay?: boolean;
  timezone?: string | null;
  recurrence?: string[] | null;
  attendees?: { email: string; name?: string; role?: 'required' | 'optional' }[];
  reminders?: { minutes: number }[];
}
export type Scope = 'this' | 'following' | 'all';
export type EventPatch = Partial<EventInput> & { scope?: Scope; etag?: string };
export type Provider = { name: string; url: string; username: string; appPasswordUrl?: string } | { google: true; note: string } | null;
export interface NewAccount { email: string; displayName: string; password: string; server?: { url: string; username?: string } }

export type ErrorCode = 'auth_failed' | 'connect_failed' | 'not_found' | 'bad_request' | 'conflict' | 'rate_limited' | 'server_error' | 'unauthorized' | (string & {});
export class CalendarApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  constructor(code: ErrorCode, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** The session ended: to the suite's sign-in, which comes back here. Arriving with `next` already in the address means this
 * page is standing in for the sign-in (the Vite dev server has none and serves the app at `/` too), so it stops there and
 * App shows SignedOut instead of looping. */
function onSignedOut(): void {
  if (new URLSearchParams(window.location.search).has('next')) return;
  const next = window.location.pathname + window.location.search;
  window.location.assign(`/?next=${encodeURIComponent(next)}`);
}

/** Signs in with the suite's email and password (`POST /v1/auth/login`, which sets the session cookie): SignedOut's form. */
export async function signIn(email: string, password: string): Promise<void> {
  const res = await fetch('/v1/auth/login', { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
  if (res.ok) return;
  const err = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  throw new CalendarApiError('auth_failed', err?.error?.message ?? (res.status === 401 ? 'That email or password is not right.' : `${res.status} ${res.statusText}`), res.status);
}

/** The organization every /v1/calendar request names (`?workspace=`): its Calendar is that account's (platform.md §3.6).
 * Set from the suite bar's selection (App.tsx); until then, the one Chat selected. */
let workspace: string | null = null;
export const setCalendarWorkspace = (id: string | null) => {
  workspace = id;
};
/** A /v1/calendar (or /v1/mail: contacts) path, naming the organization. */
export function inWorkspace(path: string): string {
  const id = workspace ?? readActiveOrganization();
  return id && /^\/v1\/(mail|calendar)\//.test(path) ? `${path}${path.includes('?') ? '&' : '?'}workspace=${encodeURIComponent(id)}` : path;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(inWorkspace(path), {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    onSignedOut();
    throw new CalendarApiError('unauthorized', 'Your session has ended. Sign in again.', 401);
  }
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
    throw new CalendarApiError(err?.error?.code ?? 'server_error', err?.error?.message ?? `${res.status} ${res.statusText}`, res.status);
  }
  return (await res.json()) as T;
}

const enc = encodeURIComponent;
const query = (params: Record<string, string | number | undefined | null>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : '';
};

export const calendarApi = {
  provider: (email: string) => request<Provider>('GET', `/v1/calendar/providers${query({ email })}`),
  /** Google's consent page for connecting (or reconnecting) a Google Calendar account; the callback comes back to `returnTo`. */
  googleStart: async (returnTo: string, email?: string) => (await request<{ url: string }>('GET', `/v1/calendar/google/start${query({ return: returnTo, email })}`)).url,
  accounts: async () => (await request<{ accounts: CalendarAccount[] }>('GET', '/v1/calendar/accounts')).accounts,
  addAccount: (body: NewAccount) => request<{ account: CalendarAccount; calendars: CalendarInfo[] }>('POST', '/v1/calendar/accounts', body),
  updateAccount: async (id: string, patch: Partial<Pick<NewAccount, 'displayName' | 'password' | 'server'>>) => (await request<{ account: CalendarAccount }>('PATCH', `/v1/calendar/accounts/${enc(id)}`, patch)).account,
  /** Lists the account's calendars again now (one ticked or added elsewhere since). */
  refreshAccount: (id: string) => request<{ calendars: CalendarInfo[]; added: number; removed: number }>('POST', `/v1/calendar/accounts/${enc(id)}/refresh`),
  removeAccount: (id: string) => request<{ ok: true }>('DELETE', `/v1/calendar/accounts/${enc(id)}`),
  calendars: async () => (await request<{ calendars: CalendarInfo[] }>('GET', '/v1/calendar/calendars')).calendars,
  updateCalendar: async (id: string, patch: { hidden?: boolean; color?: string | null; isDefault?: true }) => (await request<{ calendar: CalendarInfo }>('PATCH', `/v1/calendar/calendars/${enc(id)}`, patch)).calendar,
  events: async (from: string, to: string, calendars?: string[], q?: string) => (await request<{ events: EventOccurrence[] }>('GET', `/v1/calendar/events${query({ from, to, calendars: calendars?.join(','), q })}`)).events,
  search: async (q: string) => (await request<{ events: EventOccurrence[] }>('GET', `/v1/calendar/events${query({ q, limit: 200 })}`)).events,
  event: (id: string) => request<{ event: EventOccurrence; master?: EventOccurrence; raw: string }>('GET', `/v1/calendar/events/${enc(id)}`),
  createEvent: async (body: EventInput) => (await request<{ event: EventOccurrence }>('POST', '/v1/calendar/events', body)).event,
  updateEvent: async (id: string, patch: EventPatch) => (await request<{ event: EventOccurrence }>('PATCH', `/v1/calendar/events/${enc(id)}`, patch)).event,
  deleteEvent: (id: string, scope?: Scope) => request<{ ok: true }>('DELETE', `/v1/calendar/events/${enc(id)}${query({ scope })}`),
  /** Other accounts' native calendars shared with this person, the organization's included. */
  shared: async () => (await request<{ calendars: SharedCalendar[] }>('GET', '/v1/calendar/shared')).calendars,
  grants: (id: string) => request<CalendarSharing>('GET', `/v1/calendar/calendars/${enc(id)}/grants`),
  setGrant: (id: string, principal: string, role: GrantRole) => request<CalendarSharing>('PUT', `/v1/calendar/calendars/${enc(id)}/grants`, { principal, role }),
  removeGrant: (id: string, principal: string) => request<CalendarSharing>('DELETE', `/v1/calendar/calendars/${enc(id)}/grants/${enc(principal)}`),
  respond: async (id: string, response: Exclude<Response, 'needs-action'>) => (await request<{ event: EventOccurrence }>('POST', `/v1/calendar/events/${enc(id)}/respond`, { response })).event,
  /** People to invite, from the person's Mail accounts (written to and heard from); [] when Mail has none. */
  contacts: async (q: string): Promise<{ name: string; address: string }[]> => {
    try {
      const { accounts } = await request<{ accounts: { id: string }[] }>('GET', '/v1/mail/accounts');
      const lists = await Promise.all(accounts.slice(0, 3).map((a) => request<{ contacts: { name: string; address: string }[] }>('GET', `/v1/mail/accounts/${enc(a.id)}/contacts${query({ q, limit: 8 })}`).then((r) => r.contacts, () => [])));
      const seen = new Set<string>();
      return lists.flat().filter((c) => !seen.has(c.address.toLowerCase()) && seen.add(c.address.toLowerCase())).slice(0, 8);
    } catch {
      return [];
    }
  },
};

/** Leaves for Google's consent page; it comes back to this page with `?connected=<id>` or `?error=<code>`. */
/** Where a Google account chooses which calendars it shares (others' calendars are off there by default; Birthdays never). */
export const GOOGLE_SYNC_SETTINGS = 'https://calendar.google.com/calendar/syncselect';

export async function connectGoogle(email?: string): Promise<void> {
  window.location.assign(await calendarApi.googleStart(`${window.location.origin}${import.meta.env.BASE_URL}`, email));
}

/** What a `?error=` from Google's callback means to the person. */
export function googleErrorText(code: string): string {
  return ({
    access_denied: 'Google Calendar was not connected: the access was declined.',
    scope_denied: 'Google Calendar was not connected: FreeFlow needs access to your calendars. Try again and leave that box ticked.',
    expired: 'That Google sign-in took too long or was already used. Try again.',
    google_disabled: 'Google Calendar is not set up on this server yet.',
    no_refresh_token: 'Google did not give FreeFlow lasting access. Try again.',
    auth_failed: 'Google did not accept the sign-in. Try again.',
    connect_failed: 'Could not reach Google Calendar. Try again in a moment.',
  } as Record<string, string>)[code] ?? 'Google Calendar could not be connected. Try again.';
}
