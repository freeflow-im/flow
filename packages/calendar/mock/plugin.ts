// A dev-only stand-in for the edge Worker's /v1/calendar API (and the few suite routes the page reads), so the client
// runs with no server: `pnpm --filter @flow/calendar dev:mock`. State is in memory and resets on restart.
// CALENDAR_MOCK=empty starts with no account (the "Connect your calendar" page). Adding an account: the password "wrong"
// answers auth_failed, a server address containing "bad" answers connect_failed, and "stale" connects an account whose
// password then stops working (the re-enter banner). Repeating events are expanded here simply (daily, weekly on days,
// monthly and yearly on the start's date), with the three scopes of a change.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin } from 'vite';
import type { CalendarInfo, EventInput, EventOccurrence, EventPatch, NewAccount, Scope } from '../src/api';
import { sampleState, type MockEvent, type MockRule, type MockState } from './data';

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
const DAY = 86_400_000;
const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (t: number) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const ridText = (t: number, allDay: boolean) => (allDay ? ymd(t).replace(/-/g, '') : new Date(t).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, ''));
const parseRid = (s: string, allDay: boolean) => {
  const m = /^(\d{4})(\d\d)(\d\d)(?:T(\d\d)(\d\d)(\d\d)Z)?$/.exec(s);
  if (!m) return null;
  return allDay ? +new Date(+m[1]!, +m[2]! - 1, +m[3]!) : Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
};
/** An API time: a date (local midnight), a wall clock time (local), or an ISO instant. */
const parseTime = (s: string) => (/^\d{4}-\d\d-\d\d$/.test(s) ? +new Date(`${s}T00:00`) : +new Date(s));
const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

function ruleOf(lines: string[] | null | undefined): MockRule | null {
  const line = lines?.find((l) => /^RRULE/i.test(l));
  if (!line) return null;
  const p = new Map(line.replace(/^RRULE:/i, '').split(';').map((x) => x.split('=') as [string, string]));
  const until = p.get('UNTIL');
  return {
    freq: (p.get('FREQ') ?? 'WEEKLY') as MockRule['freq'], interval: Number(p.get('INTERVAL')) || 1,
    byday: (p.get('BYDAY') ?? '').split(',').map((d) => DAYS.indexOf(d.replace(/^-?\d/, ''))).filter((d) => d >= 0),
    ...(p.get('COUNT') ? { count: Number(p.get('COUNT')) } : {}),
    ...(until ? { until: +new Date(+until.slice(0, 4), +until.slice(4, 6) - 1, +until.slice(6, 8), 23, 59, 59) } : {}),
  };
}
function linesOf(r: MockRule | null): string[] | undefined {
  if (!r) return undefined;
  const parts = [`FREQ=${r.freq}`, ...(r.interval > 1 ? [`INTERVAL=${r.interval}`] : []), ...(r.byday.length && r.freq === 'WEEKLY' ? [`BYDAY=${r.byday.map((d) => DAYS[d]).join(',')}`] : []), ...(r.count ? [`COUNT=${r.count}`] : []), ...(r.until ? [`UNTIL=${ymd(r.until).replace(/-/g, '')}T235959Z`] : [])];
  return [`RRULE:${parts.join(';')}`];
}

/** A series' starts up to `to` (local wall clock steps, so 9:30 stays 9:30 across daylight time). */
function starts(e: MockEvent, to: number): number[] {
  if (!e.rule) return [e.start];
  const out: number[] = [];
  const r = e.rule, first = new Date(e.start);
  for (let i = 0, n = 0; i < 4000 && out.length < 2000; i++) {
    const d = new Date(first);
    if (r.freq === 'DAILY') d.setDate(first.getDate() + i * r.interval);
    else if (r.freq === 'WEEKLY') { d.setDate(first.getDate() - first.getDay() + Math.floor(i / 7) * 7 * r.interval + (i % 7)); if (!(r.byday.length ? r.byday : [first.getDay()]).includes(d.getDay())) continue; }
    else if (r.freq === 'MONTHLY') d.setMonth(first.getMonth() + i * r.interval);
    else d.setFullYear(first.getFullYear() + i * r.interval);
    const t = +d;
    if (t < e.start) continue;
    if (t >= to || (r.until && t > r.until) || (r.count && n >= r.count)) break;
    n++;
    out.push(t);
  }
  return out;
}

function occurrence(e: MockEvent, start: number, rid: number | null): EventOccurrence {
  const o = rid !== null ? e.overrides.get(rid) : undefined;
  const s = o?.start ?? start, len = o?.durationMs ?? e.durationMs;
  const iso = (t: number) => (e.allDay ? ymd(t) : new Date(t).toISOString());
  const eventId = `${e.calendarId}:${e.uid}`;
  return {
    id: rid !== null && e.rule ? `${eventId}:${ridText(rid, e.allDay)}` : eventId, eventId, calendarId: e.calendarId,
    summary: o?.summary ?? e.summary, location: o?.location ?? e.location, description: o?.description ?? e.description,
    start: iso(s), end: iso(s + len), allDay: e.allDay, timezone: e.timezone, recurring: !!e.rule, ...(rid !== null && e.rule ? { recurrenceId: ridText(rid, e.allDay) } : {}),
    status: 'confirmed', organizer: e.organizer, attendees: e.attendees, ...(e.myResponse ? { myResponse: e.myResponse } : {}), ...(e.conference ? { conference: e.conference } : {}),
    etag: `"${e.etag}"`, updated: new Date().toISOString(), reminders: e.reminders, ...(e.rule ? { recurrence: linesOf(e.rule) } : {}),
  };
}

function occurrencesIn(e: MockEvent, from: number, to: number): EventOccurrence[] {
  const out: EventOccurrence[] = [];
  for (const s of starts(e, to + 31 * DAY)) {
    if (e.exdates.has(s)) continue;
    const o = e.overrides.get(s);
    const os = o?.start ?? s, len = o?.durationMs ?? e.durationMs;
    if (os < to && os + len > from) out.push(occurrence(e, s, e.rule ? s : null));
  }
  return out;
}

function fields(e: MockEvent, p: EventPatch | EventInput): void {
  if (p.summary !== undefined) e.summary = p.summary;
  if (p.location !== undefined) e.location = p.location ?? null;
  if (p.description !== undefined) e.description = p.description ?? null;
  if (p.attendees !== undefined) e.attendees = p.attendees.map((a) => ({ name: a.name ?? null, email: a.email, role: a.role ?? 'required', response: 'needs-action' }));
  if (p.reminders !== undefined) e.reminders = p.reminders.map((r) => r.minutes);
  if (p.recurrence !== undefined) e.rule = ruleOf(p.recurrence);
  if (p.timezone !== undefined) e.timezone = p.timezone ?? null;
}

export function createMockApi(empty = false) {
  const state: MockState = empty ? { accounts: [], calendars: [], events: [] } : sampleState();
  const cal = (id: string) => { const c = state.calendars.find((x) => x.id === id); if (!c) throw new HttpError(404, 'not_found', 'no such calendar'); return c; };
  const writable = (c: CalendarInfo) => { if (c.role === 'reader') throw new HttpError(400, 'bad_request', 'This calendar is read-only'); return c; };
  const target = (id: string) => {
    const [calendarId = '', uid = '', rid] = id.split(':');
    const e = state.events.find((x) => x.calendarId === calendarId && x.uid === decodeURIComponent(uid));
    if (!e) throw new HttpError(404, 'not_found', 'no such event');
    const ridMs = rid ? parseRid(rid, e.allDay) : null;
    return { e, rid: ridMs };
  };
  const view = (e: MockEvent, rid: number | null) => occurrence(e, rid ?? e.start, rid);
  const ensureDefault = () => {
    if (!state.calendars.some((c) => c.isDefault)) { const c = state.calendars.find((x) => x.role !== 'reader'); if (c) c.isDefault = true; }
  };

  return async function handle(method: string, url: URL, body: unknown): Promise<{ status: number; json: unknown }> {
    const p = url.pathname, q = url.searchParams;
    let m: RegExpMatchArray | null;
    if (p === '/v1/me') return { status: 200, json: { id: 'u1', email: 'ann@icloud.com', displayName: 'Ann Lee', avatarUrl: null, statusEmoji: '', statusText: '' } };
    if (p === '/v1/me/workspaces') return { status: 200, json: { workspaces: [{ id: 'w1', name: 'Acme', avatarUrl: null, role: 'owner', unreadCount: 3 }] } };
    if (p === '/v1/auth/logout') return { status: 200, json: { ok: true } };
    if (p === '/v1/mail/accounts') return { status: 200, json: { accounts: [{ id: 'm1' }] } };
    if (/^\/v1\/mail\/accounts\/[^/]+\/contacts$/.test(p)) {
      const all = [{ name: 'Bo Chen', address: 'bo@acme.test' }, { name: 'Cy Diaz', address: 'cy@acme.test' }, { name: 'Priya Shah', address: 'priya@example.com' }];
      const t = (q.get('q') ?? '').toLowerCase();
      return { status: 200, json: { contacts: all.filter((c) => c.name.toLowerCase().split(' ').some((w) => w.startsWith(t)) || c.address.startsWith(t)) } };
    }
    if (p === '/v1/calendar/providers') {
      const domain = (q.get('email') ?? '').split('@')[1]?.toLowerCase() ?? '';
      if (['gmail.com', 'googlemail.com'].includes(domain)) return { status: 200, json: { google: true, note: 'Google Calendar is coming soon: it needs signing in with Google, not a password.' } };
      if (['icloud.com', 'me.com', 'mac.com'].includes(domain)) return { status: 200, json: { name: 'iCloud', url: 'https://caldav.icloud.com/', username: q.get('email'), appPasswordUrl: 'https://account.apple.com/account/manage' } };
      if (domain === 'fastmail.com') return { status: 200, json: { name: 'Fastmail', url: 'https://caldav.fastmail.com/', username: q.get('email') } };
      return { status: 200, json: null };
    }
    if (p === '/v1/calendar/accounts' && method === 'GET') return { status: 200, json: { accounts: state.accounts } };
    if (p === '/v1/calendar/accounts' && method === 'POST') {
      const a = body as NewAccount;
      if (a.password === 'wrong') throw new HttpError(422, 'auth_failed', 'The calendar server refused the login');
      if (a.server?.url.includes('bad')) throw new HttpError(422, 'connect_failed', 'Could not reach the calendar server: no answer');
      const id = `acct-${Date.now().toString(36)}`;
      const account = { id, kind: 'caldav' as const, email: a.email, displayName: a.displayName || a.email.split('@')[0]!, server: { url: a.server?.url ?? 'https://caldav.icloud.com/', username: a.server?.username || a.email }, status: a.password === 'stale' ? ('auth_failed' as const) : ('ok' as const) };
      state.accounts.push(account);
      const calendars: CalendarInfo[] = [{ id: `${id}-cal`, accountId: id, name: 'Calendar', color: '#33b679', timezone: null, role: 'owner', hidden: false, isDefault: false, syncedAt: new Date().toISOString() }];
      state.calendars.push(...calendars);
      ensureDefault();
      return { status: 201, json: { account, calendars } };
    }
    if ((m = p.match(/^\/v1\/calendar\/accounts\/([^/]+)$/))) {
      const a = state.accounts.find((x) => x.id === m![1]);
      if (!a) throw new HttpError(404, 'not_found', 'no such calendar account');
      if (method === 'DELETE') {
        state.accounts = state.accounts.filter((x) => x !== a);
        const gone = new Set(state.calendars.filter((c) => c.accountId === a.id).map((c) => c.id));
        state.calendars = state.calendars.filter((c) => !gone.has(c.id));
        state.events = state.events.filter((e) => !gone.has(e.calendarId));
        ensureDefault();
        return { status: 200, json: { ok: true } };
      }
      const b = body as { displayName?: string; password?: string; server?: { url: string; username?: string } };
      if (b.password === 'wrong') throw new HttpError(422, 'auth_failed', 'The calendar server refused the login');
      if (b.displayName !== undefined) a.displayName = b.displayName;
      if (b.password) a.status = 'ok';
      if (b.server) a.server = { url: b.server.url, username: b.server.username || a.email };
      return { status: 200, json: { account: a } };
    }
    if (p === '/v1/calendar/calendars') return { status: 200, json: { calendars: state.calendars } };
    if ((m = p.match(/^\/v1\/calendar\/calendars\/([^/]+)$/))) {
      const c = cal(m[1]!);
      const b = body as { hidden?: boolean; color?: string | null; isDefault?: true };
      if (b.hidden !== undefined) c.hidden = b.hidden;
      if (b.color !== undefined) c.color = b.color ?? '#039be5';
      if (b.isDefault) { writable(c); for (const x of state.calendars) x.isDefault = x === c; }
      return { status: 200, json: { calendar: c } };
    }
    if (p === '/v1/calendar/events' && method === 'GET') {
      const text = q.get('q')?.toLowerCase().trim();
      const from = q.get('from') ? Date.parse(q.get('from')!) : Date.now() - 365 * DAY;
      const to = q.get('to') ? Date.parse(q.get('to')!) : Date.now() + 365 * DAY;
      if (to - from > (text && !q.get('from') ? 800 : 93) * DAY) throw new HttpError(400, 'bad_request', 'the window is at most 3 months; ask per visible range');
      const asked = q.get('calendars')?.split(',');
      const ids = new Set(asked ?? state.calendars.filter((c) => !c.hidden).map((c) => c.id));
      let list = state.events.filter((e) => ids.has(e.calendarId)).flatMap((e) => occurrencesIn(e, from, to));
      if (text) list = list.filter((o) => [o.summary, o.location, o.description, ...o.attendees.map((a) => `${a.name} ${a.email}`)].join(' ').toLowerCase().includes(text));
      list.sort((a, b) => (a.start < b.start ? -1 : 1));
      return { status: 200, json: { events: list.slice(0, Number(q.get('limit')) || 2000) } };
    }
    if (p === '/v1/calendar/events' && method === 'POST') {
      const b = body as EventInput;
      const c = writable(b.calendarId ? cal(b.calendarId) : state.calendars.find((x) => x.isDefault)!);
      const start = parseTime(b.start), end = parseTime(b.end);
      const e: MockEvent = { uid: `new-${Date.now().toString(36)}`, calendarId: c.id, summary: b.summary, location: b.location ?? null, description: b.description ?? null, start, durationMs: Math.max(0, end - start), allDay: !!b.allDay, timezone: b.timezone ?? null, rule: null, exdates: new Set(), overrides: new Map(), organizer: null, attendees: [], reminders: [], etag: 1 };
      fields(e, b);
      if (e.attendees.length) e.organizer = { name: 'Ann Lee', email: 'ann@icloud.com', role: 'required', response: 'accepted', self: true };
      state.events.push(e);
      return { status: 201, json: { event: view(e, null) } };
    }
    if ((m = p.match(/^\/v1\/calendar\/events\/([^/]+)\/respond$/))) {
      const { e } = target(decodeURIComponent(m[1]!));
      const r = (body as { response: EventOccurrence['myResponse'] }).response!;
      e.myResponse = r;
      e.attendees = e.attendees.map((a) => (a.self ? { ...a, response: r } : a));
      e.etag++;
      return { status: 200, json: { event: view(e, null) } };
    }
    if ((m = p.match(/^\/v1\/calendar\/events\/([^/]+)$/))) {
      const id = decodeURIComponent(m[1]!);
      const { e, rid } = target(id);
      if (method === 'GET') return { status: 200, json: { event: view(e, rid), raw: 'BEGIN:VCALENDAR\r\n(mock)\r\nEND:VCALENDAR' } };
      writable(cal(e.calendarId));
      const scope = ((method === 'DELETE' ? q.get('scope') : (body as EventPatch).scope) ?? (rid !== null ? 'this' : 'all')) as Scope;
      if (method === 'DELETE') {
        if (!e.rule || scope === 'all' || rid === null || (scope === 'following' && rid <= e.start)) state.events = state.events.filter((x) => x !== e);
        else if (scope === 'this') e.exdates.add(rid);
        else e.rule = { ...e.rule, until: rid - 1000, count: undefined };
        e.etag++;
        return { status: 200, json: { ok: true } };
      }
      const b = body as EventPatch;
      if (b.etag && b.etag !== `"${e.etag}"`) throw new HttpError(409, 'conflict', 'The event changed on the server since it was loaded; look again');
      const at = rid ?? e.start;
      const ov = e.overrides.get(at);
      const curStart = ov?.start ?? at, curLen = ov?.durationMs ?? e.durationMs;
      const newStart = b.start !== undefined ? parseTime(b.start) : curStart;
      const newLen = b.end !== undefined ? parseTime(b.end) - newStart : curLen;
      if (b.allDay !== undefined) e.allDay = b.allDay;
      if (b.calendarId) e.calendarId = writable(cal(b.calendarId)).id;
      e.etag++;
      if (e.rule && rid !== null && scope === 'this') {
        e.overrides.set(rid, { ...ov, start: newStart, durationMs: newLen, ...(b.summary !== undefined ? { summary: b.summary } : {}), ...(b.location !== undefined ? { location: b.location } : {}), ...(b.description !== undefined ? { description: b.description } : {}) });
        return { status: 200, json: { event: view(e, rid) } };
      }
      if (e.rule && rid !== null && scope === 'following' && rid > e.start) {
        const next: MockEvent = { ...e, uid: `${e.uid}-${Date.now().toString(36)}`, start: rid + (newStart - curStart), durationMs: newLen, exdates: new Set([...e.exdates].filter((x) => x > rid)), overrides: new Map(), etag: 1 };
        fields(next, b);
        e.rule = { ...e.rule, until: rid - 1000, count: undefined };
        state.events.push(next);
        return { status: 200, json: { event: view(next, null) } };
      }
      e.start += newStart - curStart;
      e.durationMs = newLen;
      fields(e, b);
      return { status: 200, json: { event: view(e, null) } };
    }
    throw new HttpError(404, 'not_found', 'not found');
  };
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : undefined;
}

export function calendarMock(): Plugin {
  const handle = createMockApi(process.env.CALENDAR_MOCK === 'empty');
  return {
    name: 'flow-calendar-mock',
    configureServer(server) {
      server.middlewares.use(async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        if (!req.url?.startsWith('/v1/')) return next();
        try {
          const out = await handle(req.method ?? 'GET', new URL(req.url, 'http://mock'), await readBody(req));
          res.statusCode = out.status;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(out.json));
        } catch (e) {
          const err = e instanceof HttpError ? e : new HttpError(500, 'server_error', String(e));
          res.statusCode = err.status;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ error: { code: err.code, message: err.message } }));
        }
      });
    },
  };
}
