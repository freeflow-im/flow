// FreeFlow Calendar's checks that need no calendar server (docs/specs/calendar.md §3, §4): which servers a person may
// connect (https to public hosts; CALENDAR_ALLOW_INSECURE=1 lifts it for Radicale in local dev), the provider presets,
// the request bodies, ids, and the timing line. The Calendar object (object.ts) and routes/calendar.ts use them.
import { z } from 'zod';
import { ApiError } from '../errors';
import { isPrivateHost } from '../imap/rules';

export const calendarError = (status: number, code: string, message: string) => new ApiError(status, code, message);
export const badRequest = (message: string) => calendarError(400, 'bad_request', message);
export const notFound = (message: string) => calendarError(404, 'not_found', message);
/** The server's copy changed since ours (a 412 to If-Match): the cache is synced again and the client looks again. */
export const conflict = (message = 'The event changed on the server since it was loaded; look again') => calendarError(409, 'conflict', message);
export const authFailed = (message = 'The calendar server refused the login') => calendarError(422, 'auth_failed', message);
export const connectFailed = (message: string) => calendarError(422, 'connect_failed', message);

export interface Provider { name: string; url: string; appPasswordUrl?: string; note?: string }
const PROVIDERS: { domains: string[]; provider: Provider }[] = [
  { domains: ['icloud.com', 'me.com', 'mac.com'], provider: { name: 'iCloud', url: 'https://caldav.icloud.com/', appPasswordUrl: 'https://account.apple.com/account/manage' } },
  { domains: ['fastmail.com', 'fastmail.fm', 'fastmail.net', 'messagingengine.com'], provider: { name: 'Fastmail', url: 'https://caldav.fastmail.com/', appPasswordUrl: 'https://app.fastmail.com/settings/security/apps' } },
];
const GOOGLE = ['gmail.com', 'googlemail.com'];

/** `GET /v1/calendar/providers?email=`: a preset (with the address as the username), `google` (sign in with Google), or null. */
export function providerFor(email: string): (Provider & { username: string }) | { google: true; note: string } | null {
  const domain = email.trim().toLowerCase().split('@')[1];
  if (!domain) return null;
  if (GOOGLE.includes(domain)) return { google: true, note: 'Google Calendar connects by signing in with Google, not with a password.' };
  const found = PROVIDERS.find((p) => p.domains.includes(domain));
  return found ? { ...found.provider, username: email.trim() } : null;
}

/** A CalDAV URL as typed ("caldav.example.com", "https://example.com/dav"), made absolute; https unless it says http. */
export function normalizeUrl(raw: string): string {
  const t = raw.trim();
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`;
}

/** Throws `bad_request` for a URL a Worker should not talk to: not https, or a private or local host (allowed in local dev). */
export function checkUrl(url: string, allowInsecure: boolean): URL {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw badRequest('server.url: not a URL');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw badRequest('server.url: use an https:// address');
  if (u.username || u.password) throw badRequest('server.url: put the username and password in their own fields');
  if (allowInsecure) return u;
  if (u.protocol !== 'https:') throw badRequest('server.url: use an https:// address');
  if (u.port && u.port !== '443') throw badRequest('server.url: only the standard https port is allowed');
  if (isPrivateHost(u.hostname)) throw badRequest('server.url: a private or local address is not allowed');
  return u;
}

// ---- ids ----------------------------------------------------------------------------------------------------------

/**
 * Event ids: `<calendarId>:<uid>` for an event (a series as a whole), `<calendarId>:<uid>:<recurrenceId>` for one occurrence
 * (`20261105T100000Z`, or `20261105` all-day). The UID is percent-encoded, so a UID with a colon still splits; opaque to agents.
 */
export const eventIdOf = (calendarId: string, uid: string) => `${calendarId}:${encodeURIComponent(uid)}`;
export const occurrenceIdOf = (calendarId: string, uid: string, rid: string) => `${eventIdOf(calendarId, uid)}:${rid}`;
export function splitId(id: string): { calendarId: string; uid: string; rid: string | null } {
  const parts = id.split(':');
  if (parts.length < 2 || parts.length > 3 || !parts[0] || !parts[1]) throw badRequest('id: not an event id');
  let uid: string;
  try {
    uid = decodeURIComponent(parts[1]);
  } catch {
    throw badRequest('id: not an event id');
  }
  return { calendarId: parts[0], uid, rid: parts[2] ?? null };
}

// ---- request bodies -----------------------------------------------------------------------------------------------

const Server = z.object({ url: z.string().trim().min(1).max(2000), username: z.string().trim().max(320).optional() });
export const NewAccount = z.object({
  email: z.string().trim().email().max(320),
  displayName: z.string().max(200).default(''),
  password: z.string().min(1).max(1000),
  server: Server.optional(),
});
export const AccountPatch = z.object({
  displayName: z.string().max(200).optional(),
  password: z.string().min(1).max(1000).optional(),
  server: Server.optional(),
});
export const CalendarPatch = z.object({
  hidden: z.boolean().optional(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'a colour such as #3b82f6').nullable().optional(),
  isDefault: z.literal(true).optional(),
});
const Instant = z.string().trim().min(10).max(40);
const AttendeeInput = z.object({ email: z.string().trim().email().max(320), name: z.string().max(200).optional(), role: z.enum(['required', 'optional']).optional() });
const EventFields = {
  summary: z.string().max(1000),
  location: z.string().max(2000).nullable().optional(),
  description: z.string().max(32_000).nullable().optional(),
  start: Instant,
  end: Instant,
  allDay: z.boolean().optional(),
  timezone: z.string().max(100).nullable().optional(),
  recurrence: z.array(z.string().max(1000)).max(20).nullable().optional(),
  attendees: z.array(AttendeeInput).max(200).optional(),
  reminders: z.array(z.object({ minutes: z.number().int().min(0).max(40_320) })).max(10).optional(),
  /** `auto`: a conference link where the server makes one (none of the CalDAV servers does; kept for the Google driver). */
  conference: z.literal('auto').optional(),
};
export const EventInput = z.object({ calendarId: z.string().min(1).max(100).optional(), ...EventFields });
export const EventPatch = z.object({
  calendarId: z.string().min(1).max(100).optional(),
  ...Object.fromEntries(Object.entries(EventFields).map(([k, v]) => [k, (v as z.ZodTypeAny).optional()])) as { [K in keyof typeof EventFields]: z.ZodOptional<(typeof EventFields)[K]> },
  scope: z.enum(['this', 'following', 'all']).optional(),
  /** The etag the client saw: a different one in the cache is a `conflict` at once. */
  etag: z.string().max(500).optional(),
});
export const RespondBody = z.object({ response: z.enum(['accepted', 'declined', 'tentative']), comment: z.string().max(2000).optional() });
export const FreeBusyBody = z.object({ emails: z.array(z.string().trim().email()).max(50).default([]), from: Instant, to: Instant });

/** Parses a body with a schema, or throws `bad_request` naming the first problem. */
export function parse<S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  const issue = r.error.issues[0];
  throw badRequest(issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'invalid request');
}

// ---- timing -------------------------------------------------------------------------------------------------------

/** The response header that carries the time a request spent talking to calendar servers, from the object to routes/calendar.ts. */
export const TIMING_HEADER = 'x-calendar-timing';

/** A request's route for its log line, ids taken out (no account, calendar or event ever appears). */
export const routeOf = (method: string, url: string) =>
  `${method} ${new URL(url).pathname.replace(/\/accounts\/[^/]+/, '/accounts/:id').replace(/\/calendars\/[^/]+/, '/calendars/:id').replace(/\/events\/(?!.*\/respond$)[^/]+/, '/events/:id').replace(/\/events\/[^/]+\/respond$/, '/events/:id/respond')}`;

/** `[calendar] <METHOD> <route> <status> <ms>ms (server <ms>ms)`, from the total and the object's `x-calendar-timing` (`server=<ms>`). */
export function timingLine(method: string, url: string, status: number, ms: number, header: string | null | undefined): string {
  const server = Number(/(?:^|;)server=(\d+)/.exec(header ?? '')?.[1] ?? 0);
  return `[calendar] ${routeOf(method, url)} ${status} ${ms}ms (server ${server}ms)`;
}

// ---- the alarm's cadence ------------------------------------------------------------------------------------------

/** A person is "active" this long after their last request: the alarm then syncs every ACTIVE_CADENCE_MS. */
export const ACTIVE_MS = 10 * 60_000;
export const ACTIVE_CADENCE_MS = 60_000;
/** Idle under a day: every 10 minutes; then the alarm stops until the next request. */
export const IDLE_CADENCE_MS = 10 * 60_000;
export const IDLE_STOP_MS = 24 * 60 * 60_000;
/** One alarm run may spend this long syncing; what is left waits for the next. */
export const SYNC_BUDGET_MS = 10_000;
/** An account's list of calendars is read again this often (a calendar added or removed elsewhere). */
export const RELIST_MS = 10 * 60_000;

/** How often the alarm runs now, from the person's last request; null: not at all. */
export function cadenceMs(lastActiveAt: number, now: number): number | null {
  const idle = Math.max(0, now - lastActiveAt);
  if (idle < ACTIVE_MS) return ACTIVE_CADENCE_MS;
  if (idle < IDLE_STOP_MS) return IDLE_CADENCE_MS;
  return null;
}
export function nextAlarmAt(lastActiveAt: number, now: number, hasAccounts: boolean): number | null {
  if (!hasAccounts) return null;
  const every = cadenceMs(lastActiveAt, now);
  return every === null ? null : now + every;
}
