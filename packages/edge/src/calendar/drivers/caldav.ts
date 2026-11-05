// The CalDAV driver (docs/specs/calendar.md §2.3, §3): discovery (.well-known/caldav, current-user-principal,
// calendar-home-set), the calendars of the home, sync (sync-collection, RFC 6578, where the server has it; else the ctag and
// the etags of every VEVENT), calendar-multiget, PUT with If-Match / If-None-Match, DELETE, and free-busy. The DAV verbs and
// their XML are tsdav's; every request goes through `request` here, which adds the login, follows redirects itself (each
// target checked like the URL the person typed), times out, adds the time to the request's timing, and turns a 401 into
// `auth_failed`. Later drivers (Google) sit behind the same `Driver` interface.
import { calendarMultiGet, calendarQuery, createAccount, fetchCalendarUserAddresses, fetchCalendars, propfind, syncCollection } from 'tsdav';
import { ApiError } from '../../errors';
import { authFailed, calendarError, checkUrl, conflict, connectFailed } from '../rules';

export interface Discovery { principal: string; home: string; addresses: string[]; outbox: string | null }
export interface RemoteCalendar { href: string; name: string; color: string | null; timezone: string | null; role: 'owner' | 'writer' | 'reader'; supportsSync: boolean; ctag: string | null }
export interface RemoteObject { href: string; etag: string; data: string }
export interface Changes { changed: { href: string; etag: string }[]; deleted: string[]; token: string | null }
export type Interval = [string, string];

/** What the Calendar object asks of a calendar server. */
export interface Driver {
  discover(): Promise<Discovery>;
  calendars(home: string): Promise<RemoteCalendar[]>;
  /** The collection's sync token and ctag now (PROPFIND depth 0). */
  state(href: string): Promise<{ token: string | null; ctag: string | null }>;
  /** What changed since a sync token (sync-collection), or null when the server no longer knows the token. */
  changes(href: string, token: string): Promise<Changes | null>;
  /** Every VEVENT object of the collection and its etag. */
  etags(href: string): Promise<{ href: string; etag: string }[]>;
  get(href: string, objects: string[]): Promise<RemoteObject[]>;
  /** Creates (etag null: If-None-Match *) or replaces (If-Match) an object; the new etag when the server says it. */
  put(href: string, data: string, etag: string | null): Promise<{ etag: string | null }>;
  delete(href: string, etag: string | null): Promise<void>;
  /** The busy times of other people (scheduling outbox, RFC 6638), or null where the server has none. */
  freebusy(d: Discovery, organizer: string, emails: string[], from: number, to: number): Promise<Map<string, Interval[]> | null>;
}

export interface CalDavOptions {
  url: string; username: string; password: string; allowInsecure: boolean;
  /** Added to the request's server time (the timing line). */
  onTime?: (ms: number) => void;
  /** Tests: a fake server. */
  fetch?: typeof fetch;
  timeoutMs?: number;
}

const MULTIGET_BATCH = 50;
const MAX_REDIRECTS = 5;
const ETAG_PROPS = { 'd:getetag': {} };
const VEVENTS = { 'c:comp-filter': { _attributes: { name: 'VCALENDAR' }, 'c:comp-filter': { _attributes: { name: 'VEVENT' } } } };

const textOf = (v: unknown): string | null => {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && '_cdata' in v) return String((v as { _cdata: unknown })._cdata);
  if (v && typeof v === 'object' && '_text' in v) return String((v as { _text: unknown })._text);
  return null;
};
const absolute = (href: string, base: string) => new URL(href, base).href;
const pathOf = (href: string) => new URL(href).pathname;

export class CalDav implements Driver {
  private readonly auth: string;
  private readonly base: typeof fetch;
  constructor(private readonly o: CalDavOptions) {
    this.auth = `Basic ${Buffer.from(`${o.username}:${o.password}`, 'utf8').toString('base64')}`;
    this.base = o.fetch ?? ((input, init) => fetch(input, init));
  }

  /** Every request: the login added, redirects followed here (each target checked), a timeout, a 401 as auth_failed. */
  readonly request: typeof fetch = async (input, init) => {
    let url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const started = Date.now();
    try {
      for (let hop = 0; ; hop++) {
        checkUrl(url, this.o.allowInsecure);
        const headers = new Headers(init?.headers);
        headers.set('authorization', this.auth);
        let res: Response;
        try {
          res = await this.base(url, { ...init, headers, redirect: 'manual', signal: AbortSignal.timeout(this.o.timeoutMs ?? 20_000) });
        } catch (err) {
          throw connectFailed(`Could not reach the calendar server: ${(err as Error).message || 'no answer'}`);
        }
        if (res.status === 401) throw authFailed();
        const location = res.headers.get('location');
        if (res.status >= 300 && res.status < 400 && location && init?.redirect !== 'manual') {
          if (hop >= MAX_REDIRECTS) throw connectFailed('The calendar server redirected too many times');
          url = absolute(location, url);
          continue;
        }
        return res;
      }
    } finally {
      this.o.onTime?.(Date.now() - started);
    }
  };

  private get account() {
    return { serverUrl: this.o.url, accountType: 'caldav' as const, credentials: { username: this.o.username, password: this.o.password } };
  }

  async discover(): Promise<Discovery> {
    let found;
    try {
      found = await createAccount({ account: this.account, loadCollections: false, loadObjects: false, fetch: this.request });
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw connectFailed(`No calendars were found at that address (${(err as Error).message})`);
    }
    if (!found.homeUrl || !found.principalUrl) throw connectFailed('No calendars were found at that address');
    const account = { ...found, homeUrl: found.homeUrl, rootUrl: found.rootUrl ?? this.o.url };
    const addresses = await fetchCalendarUserAddresses({ account, fetch: this.request }).catch((err) => { if (err instanceof ApiError && err.code === 'auth_failed') throw err; return [] as string[]; });
    let outbox: string | null = null;
    try {
      const [r] = await propfind({ url: found.principalUrl, props: { 'c:schedule-outbox-URL': {} }, depth: '0', fetch: this.request });
      const href = textOf((r?.props?.scheduleOutboxURL as { href?: unknown } | undefined)?.href);
      if (href) outbox = absolute(href, found.principalUrl);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'auth_failed') throw err;
    }
    return { principal: found.principalUrl, home: account.homeUrl, addresses: addresses.map((a) => a.replace(/^mailto:/i, '').toLowerCase()).filter((a) => a.includes('@')), outbox };
  }

  async calendars(home: string): Promise<RemoteCalendar[]> {
    const account = { ...this.account, rootUrl: home, homeUrl: home };
    const props = {
      'c:calendar-description': {}, 'c:calendar-timezone': {}, 'd:displayname': {}, 'ca:calendar-color': {}, 'cs:getctag': {}, 'd:resourcetype': {},
      'c:supported-calendar-component-set': {}, 'd:sync-token': {}, 'd:current-user-privilege-set': {},
    };
    let list;
    try {
      list = await fetchCalendars({ account, props, projectedProps: { currentUserPrivilegeSet: true }, fetch: this.request });
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw connectFailed(`Could not list the calendars (${(err as Error).message})`);
    }
    return list
      .filter((c) => !c.components?.length || c.components.includes('VEVENT'))
      .map((c) => {
        const privileges = JSON.stringify(c.projectedProps?.currentUserPrivilegeSet ?? null);
        const writable = privileges === 'null' || /"(write|write-content|writeContent|all)"/.test(privileges);
        const color = /#[0-9a-f]{6}/i.exec(textOf(c.calendarColor) ?? '')?.[0]?.toLowerCase() ?? null;
        const tz = /^TZID:(.+)$/m.exec(String(c.timezone ?? '').replace(/\r/g, ''))?.[1]?.trim() ?? null;
        const name = (typeof c.displayName === 'string' && c.displayName.trim()) || decodeURIComponent(new URL(c.url).pathname.split('/').filter(Boolean).at(-1) ?? 'Calendar');
        const reports = (c.reports ?? []) as string[];
        return { href: c.url, name, color, timezone: tz, role: writable ? 'owner' as const : 'reader' as const, supportsSync: reports.includes('syncCollection'), ctag: c.ctag ?? null };
      });
  }

  async state(href: string): Promise<{ token: string | null; ctag: string | null }> {
    const [r] = await propfind({ url: href, props: { 'd:sync-token': {}, 'cs:getctag': {} }, depth: '0', fetch: this.request });
    if (r && !r.ok && r.status === 404) throw calendarError(404, 'not_found', 'The calendar is no longer on the server');
    return { token: textOf(r?.props?.syncToken), ctag: textOf(r?.props?.getctag) };
  }

  async changes(href: string, token: string): Promise<Changes | null> {
    const res = await syncCollection({ url: href, props: ETAG_PROPS, syncLevel: 1, syncToken: token, fetch: this.request });
    // A token the server no longer knows: 403 or 409 (valid-sync-token), or 400 on some servers; the caller lists all.
    if (res.length === 1 && res[0].ok === false && [400, 403, 409, 410, 412, 507].includes(res[0].status ?? 0)) return null;
    if (res.some((r) => r.ok === false && !r.href?.endsWith('.ics') && (r.status ?? 0) >= 400 && (r.status ?? 0) !== 404)) throw connectFailed(`The calendar server refused the sync (${res[0].status})`);
    const out: Changes = { changed: [], deleted: [], token: null };
    for (const r of res) {
      const next = textOf((r.raw as { multistatus?: { syncToken?: unknown } } | undefined)?.multistatus?.syncToken);
      if (next) out.token = next;
      if (!r.href) continue;
      const abs = absolute(r.href, href);
      if (abs.replace(/\/$/, '') === href.replace(/\/$/, '')) continue;
      const etag = textOf(r.props?.getetag);
      if (etag && r.status !== 404) out.changed.push({ href: abs, etag });
      else out.deleted.push(abs);
    }
    return out;
  }

  async etags(href: string): Promise<{ href: string; etag: string }[]> {
    const res = await calendarQuery({ url: href, props: ETAG_PROPS, filters: VEVENTS, depth: '1', fetch: this.request });
    const failed = res.find((r) => r.ok === false && (r.status ?? 0) >= 400);
    if (failed) throw connectFailed(`The calendar server refused to list the events (${failed.status})`);
    return res.flatMap((r) => {
      const etag = textOf(r.props?.getetag);
      if (!r.href || !etag) return [];
      const abs = absolute(r.href, href);
      return abs.replace(/\/$/, '') === href.replace(/\/$/, '') ? [] : [{ href: abs, etag }];
    });
  }

  async get(href: string, objects: string[]): Promise<RemoteObject[]> {
    const out: RemoteObject[] = [];
    for (let i = 0; i < objects.length; i += MULTIGET_BATCH) {
      const batch = objects.slice(i, i + MULTIGET_BATCH);
      const res = await calendarMultiGet({ url: href, props: { ...ETAG_PROPS, 'c:calendar-data': {} }, objectUrls: batch.map(pathOf), depth: '1', fetch: this.request });
      for (const r of res) {
        const data = textOf(r.props?.calendarData);
        const etag = textOf(r.props?.getetag);
        if (r.href && data && etag) out.push({ href: absolute(r.href, href), etag, data });
      }
    }
    return out;
  }

  async put(href: string, data: string, etag: string | null): Promise<{ etag: string | null }> {
    const res = await this.request(href, { method: 'PUT', headers: { 'content-type': 'text/calendar; charset=utf-8', ...(etag ? { 'if-match': etag } : { 'if-none-match': '*' }) }, body: data });
    if (res.status === 412) throw conflict();
    if (!res.ok) throw refused(res, await res.text().catch(() => ''));
    return { etag: res.headers.get('etag') };
  }

  async delete(href: string, etag: string | null): Promise<void> {
    const res = await this.request(href, { method: 'DELETE', headers: etag ? { 'if-match': etag } : {} });
    if (res.status === 412) throw conflict();
    if (!res.ok && res.status !== 404 && res.status !== 410) throw refused(res, await res.text().catch(() => ''));
  }

  async freebusy(d: Discovery, organizer: string, emails: string[], from: number, to: number): Promise<Map<string, Interval[]> | null> {
    if (!d.outbox || !emails.length) return null;
    const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
    const body = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//FreeFlow//Calendar 1.0//EN', 'METHOD:REQUEST', 'BEGIN:VFREEBUSY', `UID:${crypto.randomUUID()}`, `DTSTAMP:${stamp(Date.now())}`,
      `DTSTART:${stamp(from)}`, `DTEND:${stamp(to)}`, `ORGANIZER:mailto:${organizer}`, ...emails.map((e) => `ATTENDEE:mailto:${e}`), 'END:VFREEBUSY', 'END:VCALENDAR', ''].join('\r\n');
    const res = await this.request(d.outbox, { method: 'POST', headers: { 'content-type': 'text/calendar; charset=utf-8', originator: `mailto:${organizer}`, recipient: emails.map((e) => `mailto:${e}`).join(', ') }, body });
    if (!res.ok) return null;
    return parseScheduleResponse(await res.text());
  }
}

function refused(res: Response, body: string): ApiError {
  if (res.status === 403) return calendarError(400, 'bad_request', 'The calendar server does not allow that change (the calendar may be read-only)');
  if (res.status === 409 || /no-uid-conflict/i.test(body)) return calendarError(409, 'conflict', 'The calendar server already has that event');
  if (res.status === 413) return calendarError(400, 'bad_request', 'The event is too large for the calendar server');
  return calendarError(502, 'server_error', `The calendar server refused the change (${res.status})`);
}

/** A schedule-response (RFC 6638): each recipient's VFREEBUSY FREEBUSY periods, for those the server could answer for. */
export function parseScheduleResponse(xml: string): Map<string, Interval[]> {
  const out = new Map<string, Interval[]>();
  for (const m of xml.matchAll(/<(?:\w+:)?response>([\s\S]*?)<\/(?:\w+:)?response>/g)) {
    const block = m[1];
    const who = /<(?:\w+:)?recipient>[\s\S]*?mailto:([^<\s]+)[\s\S]*?<\/(?:\w+:)?recipient>/i.exec(block)?.[1]?.toLowerCase();
    const status = /<(?:\w+:)?request-status>([^<]*)</i.exec(block)?.[1] ?? '';
    const data = /<(?:\w+:)?calendar-data[^>]*>([\s\S]*?)<\/(?:\w+:)?calendar-data>/i.exec(block)?.[1];
    if (!who || !data || !status.startsWith('2.')) continue;
    const text = data.replace(/&#13;/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\r?\n[ \t]/g, '');
    const intervals: Interval[] = [];
    for (const line of text.split(/\r?\n/)) {
      const fb = /^FREEBUSY(;[^:]*)?:(.+)$/i.exec(line.trim());
      if (!fb || /FBTYPE=FREE\b/i.test(fb[1] ?? '')) continue;
      for (const period of fb[2].split(',')) {
        const [a, b] = period.split('/');
        const iso = (s: string) => s.replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/, '$1-$2-$3T$4:$5:$6Z');
        const start = Date.parse(iso(a));
        const end = /^P/.test(b ?? '') ? start + durationMs(b) : Date.parse(iso(b ?? ''));
        if (!Number.isNaN(start) && !Number.isNaN(end)) intervals.push([new Date(start).toISOString(), new Date(end).toISOString()]);
      }
    }
    out.set(who, intervals);
  }
  return out;
}

function durationMs(d: string): number {
  const m = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(d);
  if (!m) return 0;
  return ((+(m[1] ?? 0) * 7 + +(m[2] ?? 0)) * 86_400 + +(m[3] ?? 0) * 3600 + +(m[4] ?? 0) * 60 + +(m[5] ?? 0)) * 1000;
}
