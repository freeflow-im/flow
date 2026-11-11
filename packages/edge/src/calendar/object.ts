// FreeFlow Calendar: one object per account (`idFromName(accountId)`, platform.md §3.6), holding the calendar accounts its
// holder connected and a complete copy of their calendars, kept fresh by the alarm. The contract is docs/specs/calendar.md (§3, §4).
//
// Every read is from SQLite (store.ts); a recurring event is expanded here for the window asked for (ical.ts). Writes go to
// the server first (PUT with If-Match, so a change made elsewhere meanwhile is a `conflict`, never lost), then into the
// cache, and the calendar is synced right after. Passwords are sealed with FLOW_DATA_KEY (org/crypto, as Mail's are) and
// never returned or logged; no address, summary or id goes in a log line.
//
// Each account also has a native calendar (platform.md §3.5, phase 4.1; calendar.md §15) whose store is this object: its
// writes go to SQLite with etags of our own and are published into the organization's event log, and it can be shared by
// grants, a reader's requests arriving through `handleShared`. Its events with attendees are scheduled between accounts
// (phase 4.2; itip.ts): the organizer's object calls each platform attendee's object (`receiveItip`) with REQUEST and
// CANCEL, an attendee's REPLY comes back the same way, and attendees outside the platform get iMIP by mail.
import { AsyncLocalStorage } from 'node:async_hooks';
import { formatReference, type AccountDTO } from '@flow/shared';
import {
  atLeast, effectiveRole, grantFromRow, grantSql, grantsForChainSql, parsePrincipal, revokeSql,
  type Grant, type GrantPrincipal, type GrantReader, type GrantRow, type Role,
} from '@flow/shared/grants';
import type { CallerContext, ObjectBindings } from '../org/routes/compat';
import type { ImportRow } from '../importing';
import { exportTables, importTable, ownerMismatch, ownerRefusal } from '../perAccount';
import { DurableObject } from 'cloudflare:workers';
import { Hono, type Context } from 'hono';
import { ApiError } from '../errors';
import { decryptBlob, encryptBlob } from '../org/crypto/index';
import { CalDav, type Credential, type Discovery, type Driver, type Interval, type RemoteCalendar } from './drivers/caldav';
import { googlePrincipal, refreshAccess, type GoogleClient } from './google';
import { DAY_MS, deleteFromEvent, editEvent, itipReply, itipRequest, newEvent, organizerOf, parseInstant, parseRid, respondTo, type Fields, type Scope, type WriteContext } from './ical';
import { ITIP_METHODS, acceptCancel, acceptReply, acceptRequest, attendeeAddresses, decide, markAccounts, platformAttendees, summaryOf, type ItipMethodIn, type ResolvedAttendee } from './itip';
import type { CalendarMail } from './imip';
import { Invites, type InviteMail, type Notified } from './invites';
import { CALENDAR_TABLES, CalendarStore, type CalendarRow, type EventOccurrence } from './store';
import {
  AccountPatch, CalendarPatch, EventInput, EventPatch, FreeBusyBody, GrantBody, NATIVE_HREF, NewAccount, RELIST_MS, RespondBody, SYNC_BUDGET_MS, TIMING_HEADER, badRequest, calendarError,
  cadenceMs, checkUrl, conflict, eventIdOf, nextAlarmAt, normalizeUrl, notFound, parse, providerFor, splitId,
} from './rules';

export interface CalendarEnv {
  FLOW_DATA_KEY?: string;
  /** `off` stops the alarm (a kill switch): the cache then stands as it is until a write. */
  CALENDAR_ALARM?: string;
  /** `1` lets an account use http and local hosts: local dev against Radicale only (a `--var`, never in wrangler.toml). */
  CALENDAR_ALLOW_INSECURE?: string;
  /** Google's OAuth client (the Worker's): refreshing a Google account's access token. */
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** The person's Mail object (the same user id names both): invitations' parts, and iMIP sent from their mail accounts. */
  MAIL?: DurableObjectNamespace<import('../imap/object').Mail>;
  /** The organization's event log: native calendars' `calendar.event.*` (platform.md §5.2, phase 4.1). */
  EVENTS?: DurableObjectNamespace<import('../events/object').Events>;
  /** The organization's object: its share index, told of each grant on a native calendar (§4.5). */
  ORG?: DurableObjectNamespace<import('../org/object').Org>;
  /** The directory: an address resolved to a member's account, for free/busy. */
  DIRECTORY?: DurableObjectNamespace<import('../directory/object').Directory>;
  /** Other accounts' Calendar objects: a member's busy time. */
  CALENDAR?: DurableObjectNamespace<Calendar>;
  /** The web client's origin, for the links in events. */
  WEB_URL_BASE?: string;
}

/** A request's bindings: the caller context, and for a reader's request about a shared native calendar, the reader. */
type Bindings = ObjectBindings & { reader?: GrantReader };
/** What a reader of a shared calendar may ask (handleShared); anything else is not_found. */
const SHARED_ROUTES: [string, RegExp][] = [
  ['GET', /^\/v1\/calendar\/events$/], ['POST', /^\/v1\/calendar\/events$/],
  ['GET', /^\/v1\/calendar\/events\/[^/]+$/], ['PATCH', /^\/v1\/calendar\/events\/[^/]+$/], ['DELETE', /^\/v1\/calendar\/events\/[^/]+$/],
  ['GET', /^\/v1\/calendar\/calendars\/[^/]+\/grants$/], ['PUT', /^\/v1\/calendar\/calendars\/[^/]+\/grants$/],
  ['DELETE', /^\/v1\/calendar\/calendars\/[^/]+\/grants\/[^/]+$/],
];
/** An iTIP message from another account's Calendar object (`receiveItip`, platform.md §3.5): `to` is the account it is for, when known. */
export interface ItipDelivery {
  method: ItipMethodIn; ics: string;
  from: { accountId: string; email: string };
  to?: { accountId: string; email: string; name: string; organizationId: string };
}
/** What `receiveItip` did; a refusal crosses the binding as `{ ok: false, … }` (an ApiError's code does not). */
export type ItipAnswer = { ok: true; action: 'created' | 'updated' | 'cancelled' | 'replied' | 'added' | 'ignored'; eventId?: string; reason?: string } | { ok: false; status: number; code: string; message: string };
/** A delivery is tried this many times (one retry) before it is logged as failed; the organizer's write stands either way. */
const DELIVERY_TRIES = 2;
/** A native calendar as a reader of it sees it (GET /v1/calendar/shared). */
export interface SharedCalendarInfo { id: string; name: string; color: string; role: Role }

/** A Google account as the callback hands it over (routes/calendar.ts): who, and the tokens the consent gave. */
export interface GoogleGrant { email: string; displayName: string; refreshToken: string; accessToken: string; expiresAt: number }

interface AccountRow {
  id: string; kind: string; email: string; display_name: string; server: string; secret: ArrayBuffer; key_id: string;
  status: string; status_message: string | null; created_at: number; calendars_at: number;
}
interface ServerState { url: string; username: string; principal: string; home: string; addresses: string[]; outbox: string | null }
export interface CalendarAccount { id: string; kind: 'caldav' | 'google' | 'native'; email: string; displayName: string; server?: { url: string; username: string }; status: 'ok' | 'auth_failed' | 'connect_failed'; statusMessage?: string }
export interface CalendarInfo { id: string; accountId: string; name: string; color: string; timezone: string | null; role: 'owner' | 'writer' | 'reader'; hidden: boolean; isDefault: boolean; syncedAt: string | null }

/** Where a request's time went, for its log line: talking to calendar servers; and whose request it is (an event's actor). */
interface Timing { server: number; actor?: string | null; via?: string | null; invokedBy?: string | null }
const timing = new AsyncLocalStorage<Timing | undefined>();

const VERIFY_LIMIT = 10;
const VERIFY_WINDOW_MS = 15 * 60_000;
/** A window is at most this long (3 months, with room for the weeks a month view shows around it). */
const MAX_WINDOW_MS = 93 * DAY_MS;
/** A search without a range covers a year each way. */
const SEARCH_SPAN_MS = 365 * DAY_MS;
/** The account's first sync, before POST answers; the rest goes on in the background. */
const FIRST_SYNC_MS = 8_000;
const PALETTE = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316', '#6366f1', '#84cc16'];
const json = async (c: Context) => c.req.json().catch(() => { throw badRequest('the body is not JSON'); });

export class Calendar extends DurableObject<CalendarEnv> {
  private readonly sql: SqlStorage;
  private readonly store: CalendarStore;
  private readonly app = new Hono<{ Bindings: Bindings }>();
  /** One sync or write at a time per calendar, so a sync never writes back what a PUT just replaced. */
  private readonly locks = new Map<string, Promise<unknown>>();
  private syncing = false;
  private lastTouch = 0;
  /** Google accounts' access tokens, in memory only (an hour each; a woken object refreshes). Never logged or returned. */
  private readonly access = new Map<string, { token: string; exp: number }>();
  /** Whose object this is (the account it is named by, kept for an alarm's wake), for the Mail object of the same account. */
  private accountId: string | null = null;

  constructor(ctx: DurableObjectState, env: CalendarEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.store = new CalendarStore(this.sql);
    this.store.init();
    this.accountId = (ctx.id as { name?: string }).name ?? this.store.state('owner_account_id');
    this.routes();
  }

  /** A page of every table's rows (or the one named), for the move to the per-account objects (routes/admin.ts). */
  exportRows(opts: { table?: string; offset?: number; limit?: number } = {}): { table: string; rows: ImportRow[] }[] {
    return exportTables(this.sql, CALENDAR_TABLES, opts);
  }

  /** Rows from another Calendar object, keeping any already here; never the owner keys (perAccount.ts). */
  importRows(table: string, rows: ImportRow[]): { added: number } {
    return importTable(this.sql, CALENDAR_TABLES, 'calendar_state', table, rows);
  }

  /**
   * A request from routes/calendar.ts (or Docs' tools), for the account this object belongs to, with the caller context
   * (`c.env.caller` to the routes); a caller of another account is refused. The account id is kept: the Mail object is
   * named by it too. Its server time goes back in `x-calendar-timing`, which the route logs (as Mail's).
   */
  async handle(request: Request, caller: CallerContext): Promise<Response> {
    const wrong = ownerMismatch(this.store, caller, 'the Calendar');
    if (wrong) { console.error(`[calendar] ${wrong}`); return ownerRefusal(wrong); }
    this.accountId = caller.account!.id;
    // A guest has no address and no native calendar (platform.md §3.3).
    if (caller.account!.address) this.store.ensureNative({ accountId: caller.account!.id, email: caller.account!.address, displayName: caller.account!.displayName ?? '' });
    const t: Timing = { server: 0, actor: caller.account!.id, via: caller.via ?? null, invokedBy: caller.invokedBy ?? null };
    const res = await timing.run(t, () => this.app.fetch(request, { caller } satisfies Bindings));
    this.touch();
    await this.armAlarm().catch((err) => console.warn(`[calendar] alarm: ${(err as Error).message}`));
    const out = new Response(res.body, res);
    out.headers.set(TIMING_HEADER, `server=${Math.round(t.server)}`);
    return out;
  }

  /**
   * A reader's request about one of this account's native calendars (routes/calendar.ts forwards a request naming a native
   * calendar id of another account here, platform.md §4.4): the owner guard lets it through as a reader, not as the owner;
   * the routes then check the reader's role on the calendar (viewer reads, editor changes, manager shares) and answer
   * not_found where it has none. Only a member of the same organization is a reader, and only the routes in SHARED_ROUTES
   * exist for one. The owner's alarm and activity are not touched.
   */
  async handleShared(request: Request, caller: CallerContext, channelIds: string[]): Promise<Response> {
    const owner = this.store.state('owner_account_id'), org = this.store.state('owner_organization_id');
    const account = caller.account;
    if (account && owner === account.id) return this.handle(request, caller);
    if (!account || !owner || !org || (account.organizationId || caller.organizationId) !== org) return Response.json({ error: { code: 'not_found', message: 'no such calendar' } }, { status: 404 });
    const t: Timing = { server: 0, actor: account.id };
    const reader: GrantReader = { accountId: account.id, channelIds };
    const res = await timing.run(t, () => this.app.fetch(request, { caller, reader } satisfies Bindings));
    const out = new Response(res.body, res);
    out.headers.set(TIMING_HEADER, `server=${Math.round(t.server)}`);
    return out;
  }

  /**
   * Busy time on this account's native calendars (an RPC for another member's free/busy, platform.md §3.5): the start and
   * end of every event that is not transparent, cancelled or declined, merged; no details.
   */
  busy(from: number, to: number): Interval[] {
    return this.busyIn(this.store.calendars().filter((c) => c.href.startsWith(NATIVE_HREF)).map((c) => c.id), from, to);
  }

  /** The native calendars named that the reader may see, with its role on each (GET /v1/calendar/shared, routes/calendar.ts). */
  sharedCalendars(caller: CallerContext, channelIds: string[], ids: string[]): SharedCalendarInfo[] {
    const org = this.store.state('owner_organization_id');
    const account = caller.account;
    if (!account || !org || (account.organizationId || caller.organizationId) !== org) return [];
    const reader: GrantReader = { accountId: account.id, channelIds };
    const out: SharedCalendarInfo[] = [];
    for (const id of new Set(ids)) {
      const c = this.store.calendar(id);
      const role = c ? this.roleFor(reader, c) : null;
      if (c && role) { const info = this.toCalendar(c); out.push({ id: c.id, name: info.name, color: info.color, role }); }
    }
    return out;
  }

  /**
   * A calendar or an event of this account's, described for a reference's chip (GET /v1/references, platform.md §5.3):
   * its name (an event's title, and its calendar's name as the summary) and the caller's role. The account's own caller
   * is the owner of every calendar; a member of the organization reads only the native calendars shared with it. Null
   * for none, or nothing to see.
   */
  describe(caller: CallerContext, channelIds: string[], kind: 'calendar' | 'event', id: string): { title: string; summary?: string; role: Role } | null {
    const owner = this.store.state('owner_account_id'), org = this.store.state('owner_organization_id');
    const account = caller.account;
    if (!account || !owner) return null;
    const own = owner === account.id;
    if (!own && (!org || (account.organizationId || caller.organizationId) !== org)) return null;
    const reader: GrantReader | undefined = own ? undefined : { accountId: account.id, channelIds };
    if (kind === 'calendar') {
      const c = this.store.calendar(id);
      const role = c ? this.roleFor(reader, c) : null;
      return c && role ? { title: this.toCalendar(c).name, role } : null;
    }
    let parts: ReturnType<typeof splitId>;
    try { parts = splitId(id); } catch { return null; }
    const c = this.store.calendar(parts.calendarId);
    const role = c ? this.roleFor(reader, c, eventIdOf(parts.calendarId, parts.uid)) : null;
    const found = c && role ? this.store.find(parts.calendarId, parts.uid, null) : null;
    return found && role ? { title: found.event.summary || '(No title)', summary: this.toCalendar(c!).name, role } : null;
  }

  /** Provisioning's calendars step (platform.md §3.4, provisioning/consumer.ts): the account's native calendar, made now
   * rather than on first use. Safe to run again. A call for another account than the object's is refused. */
  async provisionNative(account: AccountDTO): Promise<{ ok: true } | { ok: false; message: string }> {
    const wrong = ownerMismatch(this.store, { account, user: null }, 'the Calendar');
    if (wrong) { console.error(`[calendar] ${wrong}`); return { ok: false, message: wrong }; }
    this.accountId = account.id;
    if (account.address) this.store.ensureNative({ accountId: account.id, email: account.address, displayName: account.displayName });
    return { ok: true };
  }

  /**
   * An iTIP message from another account's Calendar object, by binding (platform.md §3.5, phase 4.2): a REQUEST, ADD or
   * CANCEL from an event's organizer to this attendee, or a REPLY from an attendee to this organizer. The rules are
   * itip.ts's (who may send what, SEQUENCE and DTSTAMP order). A new invitation goes on the account's native calendar
   * with `needs-action` and publishes `calendar.invited` to the account; an update keeps the account's own answer and
   * reminders; a cancellation keeps the event as cancelled; a reply changes the replier's answer on the organizer's copy.
   * `to` names the account for an object that has not been used yet (an agent's), so its native calendar can be made.
   */
  async receiveItip(m: ItipDelivery): Promise<ItipAnswer> {
    const refuse = (status: number, code: string, message: string): ItipAnswer => ({ ok: false, status, code, message });
    if (!m || !ITIP_METHODS.includes(m.method) || typeof m.ics !== 'string' || m.ics.length > 512 * 1024 || !m.from?.accountId || !m.from.email) return refuse(400, 'bad_request', 'not an iTIP message');
    if (m.to) {
      const account = { id: m.to.accountId, principalId: '', organizationId: m.to.organizationId } as NonNullable<CallerContext['account']>;
      const wrong = ownerMismatch(this.store, { account, user: null }, 'the Calendar');
      if (wrong) { console.error(`[calendar] ${wrong}`); return refuse(500, 'wrong_account', wrong); }
      if (m.to.organizationId !== this.store.state('owner_organization_id')) return refuse(403, 'forbidden', 'an invitation from another organization');
      this.accountId = m.to.accountId;
      this.store.ensureNative({ accountId: m.to.accountId, email: m.to.email, displayName: m.to.name });
    }
    if (!this.store.state('owner_account_id')) return refuse(404, 'not_found', 'no such calendar');
    try {
      return await timing.run({ server: 0, actor: m.from.accountId }, () => this.applyItip(m));
    } catch (err) {
      if (err instanceof ApiError) return refuse(err.statusCode, err.code, err.message);
      console.error(`[calendar] ${m.method}: ${(err as Error).message.slice(0, 200)}`);
      return refuse(500, 'server_error', 'internal server error');
    }
  }

  /** `receiveItip`'s work, on the native calendar holding the event (else the default native one), under its lock. */
  private async applyItip(m: ItipDelivery): Promise<ItipAnswer> {
    const incoming = summaryOf(m.ics);
    if (!incoming) throw badRequest('the message has no event');
    const uid = incoming.uid;
    const natives = this.store.calendars().filter((c) => c.href.startsWith(NATIVE_HREF));
    const target = natives.find((c) => this.store.objectByUid(c.id, uid)) ?? natives.find((c) => c.is_default) ?? natives[0];
    if (!target) throw notFound('no calendar here');
    const acct = this.account(target.account_id);
    const me = this.meOn(acct, target);
    const eventId = eventIdOf(target.id, uid);
    return this.locked(target.id, async (): Promise<ItipAnswer> => {
      const obj = this.store.objectByUid(target.id, uid);
      const d = decide(m.method, incoming, obj ? summaryOf(obj.raw, uid) : null, m.from, me);
      if (d.action === 'refuse') throw calendarError(d.code === 'bad_request' ? 400 : 403, d.code, d.message);
      if (d.action === 'ignore') return { ok: true, action: 'ignored', reason: d.reason, ...(obj ? { eventId } : {}) };
      const now = Date.now();
      if (d.action === 'reply') {
        const r = acceptReply(obj!.raw, m.ics, uid, m.from.email, now);
        await this.putAndStore(acct, target, obj!.href, r.raw, obj!.etag, { extra: { attendeeResponse: { email: m.from.email.toLowerCase(), response: r.response } } });
        return { ok: true, action: 'replied', eventId };
      }
      if (d.action === 'cancel') {
        const raw = acceptCancel(obj!.raw, m.ics, uid, now);
        if (raw === null) await this.removeAt(acct, target, obj!.href, obj!.etag);
        else await this.putAndStore(acct, target, obj!.href, raw, obj!.etag, { type: 'calendar.event.cancelled' });
        return { ok: true, action: 'cancelled', eventId };
      }
      const raw = acceptRequest(obj?.raw ?? null, m.ics, uid, me, { add: d.action === 'add' });
      await this.putAndStore(acct, target, obj?.href ?? this.hrefIn(target, uid), raw, obj?.etag ?? null);
      if (d.action === 'create') await this.publish('calendar.invited', target, uid, { audience: `account:${this.store.state('owner_account_id')}`, organizer: m.from });
      return { ok: true, action: d.action === 'create' ? 'created' : d.action === 'add' ? 'added' : 'updated', eventId };
    });
  }

  private get allowInsecure() { return this.env.CALENDAR_ALLOW_INSECURE === '1'; }

  // ---- accounts -------------------------------------------------------------------------------------------------

  private accountRows(): AccountRow[] {
    return this.sql.exec<AccountRow & Record<string, SqlStorageValue>>('SELECT * FROM accounts ORDER BY created_at').toArray();
  }
  private account(id: string): AccountRow {
    const row = this.sql.exec<AccountRow & Record<string, SqlStorageValue>>('SELECT * FROM accounts WHERE id = ?', id).toArray()[0];
    if (!row) throw notFound('no such calendar account');
    return row;
  }
  /** An account's server state; a native account has none. */
  private serverOf(r: AccountRow): ServerState {
    return r.kind === 'native' || !r.server ? { url: '', username: '', principal: '', home: '', addresses: [], outbox: null } : JSON.parse(r.server) as ServerState;
  }
  private toAccount(r: AccountRow): CalendarAccount {
    const s = this.serverOf(r);
    return { id: r.id, kind: r.kind as CalendarAccount['kind'], email: r.email, displayName: r.display_name, ...(r.kind === 'native' ? {} : { server: { url: s.url, username: s.username } }), status: r.status as CalendarAccount['status'], ...(r.status_message ? { statusMessage: r.status_message } : {}) };
  }
  private password(r: AccountRow): string { return decryptBlob(Buffer.from(r.secret), r.key_id).toString('utf8'); }
  private setStatus(id: string, status: CalendarAccount['status'], message: string | null): void {
    this.sql.exec('UPDATE accounts SET status = ?, status_message = ? WHERE id = ? AND (status != ? OR status_message IS NOT ?)', status, message, id, status, message);
  }
  private me(r: AccountRow): Set<string> { return new Set([r.email.toLowerCase(), ...this.serverOf(r).addresses]); }
  /** "Me" on one calendar: the account's addresses, and the calendar's owner when it is shared into the account. */
  private meOn(r: AccountRow, c: CalendarRow): Set<string> {
    const me = this.me(r);
    if (c.owner_address) me.add(c.owner_address.toLowerCase());
    return me;
  }

  private driver(url: string, credential: Credential): Driver {
    return new CalDav({ url, credential, allowInsecure: this.allowInsecure, onTime: (ms) => { const t = timing.getStore(); if (t) t.server += ms; } });
  }
  private googleClient(): GoogleClient {
    if (!this.env.GOOGLE_CLIENT_ID || !this.env.GOOGLE_CLIENT_SECRET) throw calendarError(503, 'google_disabled', 'Google Calendar is not configured on this server');
    return { clientId: this.env.GOOGLE_CLIENT_ID, clientSecret: this.env.GOOGLE_CLIENT_SECRET };
  }
  /** An account's credential: its password, or (Google) an access token from its sealed refresh token, kept for its hour. */
  private credentialOf(r: AccountRow): Credential {
    if (r.kind !== 'google') return { kind: 'basic', username: this.serverOf(r).username, password: this.password(r) };
    const refresh = async () => {
      try {
        const t = await refreshAccess(this.password(r), this.googleClient());
        this.access.set(r.id, { token: t.accessToken, exp: t.expiresAt });
        return t.accessToken;
      } catch (err) {
        this.access.delete(r.id);
        if (err instanceof ApiError && err.code === 'auth_failed') this.setStatus(r.id, 'auth_failed', err.message);
        throw err;
      }
    };
    return {
      kind: 'bearer',
      token: async () => { const a = this.access.get(r.id); return a && a.exp > Date.now() + 60_000 ? a.token : refresh(); },
      refresh,
    };
  }
  private driverOf(r: AccountRow): Driver {
    const s = this.serverOf(r);
    return this.driver(s.home || s.url, this.credentialOf(r));
  }

  /** The Directory's fixed window, per person here since the object is theirs. True when the attempt is allowed. */
  private rateAllow(key: string, limit: number, windowMs: number): boolean {
    const now = Date.now();
    const row = this.sql.exec<{ count: number }>(
      `INSERT INTO rate_limit_windows (key, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT (key) DO UPDATE SET count = CASE WHEN window_start <= ? THEN 1 ELSE count + 1 END,
         window_start = CASE WHEN window_start <= ? THEN ? ELSE window_start END RETURNING count`, key, now, now - windowMs, now - windowMs, now).toArray()[0];
    return !row || row.count <= limit;
  }

  /** Finds the calendars behind a login before anything is saved, so a saved account is one that worked. */
  private async verify(url: string, username: string, password: string): Promise<{ found: Discovery; calendars: RemoteCalendar[] }> {
    checkUrl(url, this.allowInsecure);
    if (!this.rateAllow('verify', VERIFY_LIMIT, VERIFY_WINDOW_MS)) throw calendarError(429, 'rate_limited', 'Too many sign-in attempts; try again in a few minutes');
    const d = this.driver(url, { kind: 'basic', username, password });
    const found = await d.discover();
    const calendars = await d.calendars(found.home, found.principal);
    return { found, calendars };
  }

  /** The account's calendars as the server lists them now (store.ts `applyCalendars`), then one default calendar again. */
  private applyCalendars(accountId: string, remote: RemoteCalendar[]): void {
    this.store.applyCalendars(accountId, remote, PALETTE);
    this.store.ensureDefault();
  }

  private toCalendar(c: CalendarRow): CalendarInfo {
    return { id: c.id, accountId: c.account_id, name: c.name, color: c.color ?? c.server_color ?? PALETTE[c.position % PALETTE.length], timezone: c.timezone, role: c.role as CalendarInfo['role'], hidden: !!c.hidden, isDefault: !!c.is_default, syncedAt: c.last_synced ? new Date(c.last_synced).toISOString() : null };
  }
  private calendar(id: string): CalendarRow {
    const c = this.store.calendar(id);
    if (!c) throw notFound('no such calendar');
    return c;
  }
  private writable(c: CalendarRow): CalendarRow {
    if (c.role === 'reader') throw badRequest('This calendar is read-only');
    return c;
  }

  // ---- sync -----------------------------------------------------------------------------------------------------

  private async locked<T>(calendarId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(calendarId) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(fn);
    const tail = run.catch(() => {});
    this.locks.set(calendarId, tail);
    try {
      return await run;
    } finally {
      if (this.locks.get(calendarId) === tail) this.locks.delete(calendarId);
    }
  }

  /**
   * Brings one calendar's cache up to the server: a sync-collection delta from the stored token where the server has it
   * (a token it no longer knows: the full listing), else the ctag and, when it changed, every VEVENT's etag against ours.
   * Changed objects are fetched by calendar-multiget; gone ones dropped. Each run is logged in `sync_runs`.
   */
  private async syncCalendar(calendarId: string): Promise<void> {
    await this.locked(calendarId, async () => {
      const c = this.store.calendar(calendarId);
      if (!c) return;
      const acct = this.account(c.account_id);
      // A native calendar is its own store: nothing to sync.
      if (acct.kind === 'native') return;
      const d = this.driverOf(acct);
      const started = Date.now();
      let mode = 'delta', changed = 0, deleted = 0, error: string | null = null;
      const opts = { me: this.meOn(acct, c), zone: c.timezone ?? 'UTC' };
      // Who "me" is on this calendar changed (or the parser learnt it): its stored objects read again first, no round trip.
      if (c.reparse) this.store.reparse(c.id, opts);
      const fetchAndStore = async (hrefs: string[]) => {
        for (const o of await d.get(c.href, hrefs)) { this.store.putObject(c.id, o.href, o.etag, o.data, opts); changed++; }
      };
      try {
        const delta = c.supports_sync && c.sync_token ? await d.changes(c.href, c.sync_token) : null;
        if (delta) {
          const have = this.store.etags(c.id);
          await fetchAndStore(delta.changed.filter((x) => have.get(x.href) !== x.etag).map((x) => x.href));
          for (const href of delta.deleted) if (have.has(href)) { this.store.deleteObject(c.id, href); deleted++; }
          this.sql.exec('UPDATE calendars SET sync_token = ?, last_synced = ? WHERE id = ?', delta.token ?? c.sync_token, Date.now(), c.id);
        } else {
          // The token and ctag first: a change made while the etags are listed shows up at the next sync, never lost.
          const state = await d.state(c.href);
          if (!c.supports_sync && c.last_synced && state.ctag && state.ctag === c.ctag) {
            mode = 'ctag';
          } else {
            mode = 'full';
            const remote = await d.etags(c.href);
            const have = this.store.etags(c.id);
            await fetchAndStore(remote.filter((x) => have.get(x.href) !== x.etag).map((x) => x.href));
            const there = new Set(remote.map((x) => x.href));
            for (const href of have.keys()) if (!there.has(href)) { this.store.deleteObject(c.id, href); deleted++; }
          }
          this.sql.exec('UPDATE calendars SET sync_token = ?, ctag = ?, last_synced = ? WHERE id = ?', state.token, state.ctag, Date.now(), c.id);
        }
        this.setStatus(acct.id, 'ok', null);
      } catch (err) {
        error = (err as Error).message.slice(0, 300);
        if (err instanceof ApiError && (err.code === 'auth_failed' || err.code === 'connect_failed')) this.setStatus(acct.id, err.code, err.message);
        if (err instanceof ApiError && err.code === 'not_found') { this.store.forgetCalendar(c.id); this.store.ensureDefault(); }
        else this.sql.exec('UPDATE calendars SET last_synced = ? WHERE id = ?', Date.now(), c.id);
        throw err;
      } finally {
        this.store.logSync({ calendarId: c.id, at: started, ms: Date.now() - started, mode, changed, deleted, error });
      }
    });
  }

  /** An account's first sync, as far as it gets in a few seconds; the rest goes on in the background. */
  private async firstSync(accountId: string): Promise<void> {
    const deadline = Date.now() + FIRST_SYNC_MS;
    const rest: string[] = [];
    for (const cal of this.store.calendarsOf(accountId)) {
      if (Date.now() > deadline) { rest.push(cal.id); continue; }
      await this.syncCalendar(cal.id).catch(() => {});
    }
    if (rest.length) this.ctx.waitUntil((async () => { for (const r of rest) await this.syncCalendar(r).catch(() => {}); })());
  }

  /**
   * A Google account from the OAuth callback (routes/calendar.ts, the person's own object by the state's user id): made,
   * or, for an address already connected, its refresh token replaced (a reconnect). The principal is Google's CalDAV one
   * for the address; discovery and the first sync run as for any account. Returns its id.
   */
  async connectGoogle(g: GoogleGrant, owner: { accountId: string; userId: string }): Promise<{ id: string }> {
    const wrong = ownerMismatch(this.store, { account: { id: owner.accountId, principalId: owner.userId } as CallerContext['account'], user: null }, 'the Calendar');
    if (wrong) throw calendarError(500, 'wrong_account', wrong);
    this.accountId = owner.accountId;
    const email = g.email.toLowerCase();
    const url = googlePrincipal(email);
    const existing = this.accountRows().find((a) => a.kind === 'google' && a.email.toLowerCase() === email);
    const id = existing?.id ?? crypto.randomUUID();
    this.access.set(id, { token: g.accessToken, exp: g.expiresAt });
    const sealed = encryptBlob(Buffer.from(g.refreshToken, 'utf8'));
    const pending: AccountRow = { id, kind: 'google', email, display_name: g.displayName || email.split('@')[0], server: JSON.stringify({ url, username: email, principal: url, home: '', addresses: [], outbox: null }), secret: new Uint8Array(sealed.blob).buffer, key_id: sealed.encKeyId, status: 'ok', status_message: null, created_at: Date.now(), calendars_at: 0 };
    const d = this.driver(url, this.credentialOf(pending));
    const found = await d.discover();
    const calendars = await d.calendars(found.home, found.principal);
    const server: ServerState = { url, username: email, principal: found.principal, home: found.home, addresses: [...new Set([email, ...found.addresses])], outbox: null };
    if (existing) {
      this.sql.exec("UPDATE accounts SET server = ?, secret = ?, key_id = ?, status = 'ok', status_message = NULL WHERE id = ?", JSON.stringify(server), pending.secret, pending.key_id, id);
    } else {
      this.sql.exec('INSERT INTO accounts (id, kind, email, display_name, server, secret, key_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id, 'google', email, pending.display_name, JSON.stringify(server), pending.secret, pending.key_id, 'ok', Date.now());
    }
    this.applyCalendars(id, calendars);
    this.touch();
    await this.firstSync(id);
    await this.armAlarm().catch(() => {});
    return { id };
  }

  /** Lists an account's calendars again (RELIST_MS, or now): a calendar added or removed elsewhere. */
  private async relist(r: AccountRow): Promise<void> {
    const s = this.serverOf(r);
    try {
      this.applyCalendars(r.id, await this.driverOf(r).calendars(s.home, s.principal));
    } catch (err) {
      if (err instanceof ApiError && (err.code === 'auth_failed' || err.code === 'connect_failed')) this.setStatus(r.id, err.code, err.message);
      this.sql.exec('UPDATE accounts SET calendars_at = ? WHERE id = ?', Date.now(), r.id);
    }
  }

  /**
   * One run of the alarm: the accounts' calendar lists that are due, then every calendar whose last sync is older than the
   * cadence (all of them, `force`), sync-collection servers first, until the budget is spent. An account whose server
   * refused the password is left alone until the person enters it again.
   */
  private async runSync(deadline: number, force = false): Promise<{ synced: number; errors: number }> {
    if (this.syncing && !force) return { synced: 0, errors: 0 };
    this.syncing = true;
    let synced = 0, errors = 0;
    const started = Date.now();
    try {
      const accounts = new Map(this.accountRows().map((a) => [a.id, a]));
      for (const a of accounts.values()) if (a.kind !== 'native' && a.status !== 'auth_failed' && (force || Date.now() - a.calendars_at > RELIST_MS)) await this.relist(a);
      const every = cadenceMs(this.lastActiveAt(), Date.now()) ?? RELIST_MS;
      for (const c of this.store.due(force ? Number.MAX_SAFE_INTEGER : Date.now() - every + 5_000)) {
        if (Date.now() > deadline) break;
        const a = accounts.get(c.account_id);
        if (!a || a.kind === 'native' || this.account(a.id).status === 'auth_failed') continue;
        try { await this.syncCalendar(c.id); synced++; } catch { errors++; }
      }
    } finally {
      this.syncing = false;
      if (synced || errors) console.log(`[calendar] sync: ${synced} calendars ${Date.now() - started}ms${errors ? ` (${errors} failed)` : ''}`);
    }
    return { synced, errors };
  }

  private lastActiveAt(): number { return Number(this.store.state('last_active_at') ?? 0); }
  private touch(): void {
    const now = Date.now();
    if (now - this.lastTouch < 10_000) return;
    this.lastTouch = now;
    this.store.setState('last_active_at', String(now));
  }
  private async armAlarm(now = Date.now()): Promise<void> {
    if (this.env.CALENDAR_ALARM === 'off') { if ((await this.ctx.storage.getAlarm()) !== null) await this.ctx.storage.deleteAlarm(); return; }
    const has = this.accountRows().some((a) => a.kind !== 'native');
    const at = nextAlarmAt(this.lastActiveAt(), now, has);
    const current = await this.ctx.storage.getAlarm();
    if (at === null) { if (current !== null) await this.ctx.storage.deleteAlarm(); return; }
    if (current === null || current > at || current < now) await this.ctx.storage.setAlarm(at);
  }
  async alarm(): Promise<void> {
    if (this.env.CALENDAR_ALARM === 'off') return;
    try {
      await this.runSync(Date.now() + SYNC_BUDGET_MS);
    } catch (err) {
      console.warn(`[calendar] alarm: ${(err as Error).message}`);
    }
    await this.armAlarm().catch((err) => console.warn(`[calendar] alarm: ${(err as Error).message}`));
  }
  /** After a write: that calendar synced in the background (the token moves on; another client's change comes along). */
  private syncSoon(calendarId: string): void {
    this.ctx.waitUntil(this.syncCalendar(calendarId).catch(() => {}));
  }

  // ---- invitations (invites.ts) -----------------------------------------------------------------------------------

  /** Whether a calendar's server sends and processes invitations itself: Google, or a CalDAV server with a scheduling outbox. */
  private schedules(c: CalendarRow): boolean {
    const a = this.account(c.account_id);
    return a.kind === 'google' || !!this.serverOf(a).outbox;
  }
  private hrefIn(c: CalendarRow, uid: string): string {
    if (c.href.startsWith(NATIVE_HREF)) return `${c.href}/${encodeURIComponent(uid)}.ics`;
    return new URL(`${encodeURIComponent(uid)}.ics`, c.href.endsWith('/') ? c.href : `${c.href}/`).href;
  }
  /** The account's Mail object, by the binding (never a route): an invitation's part, their mail accounts, and iMIP sent from one. */
  private mailPort(): InviteMail | null {
    const ns = this.env.MAIL, user = this.accountId;
    if (!ns || !user) return null;
    const stub = () => ns.get(ns.idFromName(user));
    type Answer = { ok: true } | { ok: false; status: number; code: string; message: string };
    const unwrap = <T extends Answer>(r: T): Extract<T, { ok: true }> => {
      if (!r.ok) throw calendarError(r.status, r.code, r.message);
      return r as Extract<T, { ok: true }>;
    };
    return {
      identities: async () => (await stub().calendarIdentities()).map((i) => ({ id: i.id, email: i.email, displayName: i.displayName })),
      part: async (account, folder, uid, index) => {
        const r = unwrap((await stub().calendarPart(account, folder, uid, index)) as Answer & { content?: Uint8Array; mimeType?: string; filename?: string });
        return { content: new Uint8Array(r.content!), mimeType: r.mimeType ?? '', filename: r.filename ?? '' };
      },
      send: async (account, mail: CalendarMail) => { unwrap((await stub().sendCalendarMail(account, mail)) as Answer); },
    };
  }
  private invites(): Invites {
    return new Invites({
      store: this.store,
      me: (calendarId) => {
        if (calendarId) { const c = this.calendar(calendarId); return this.meOn(this.account(c.account_id), c); }
        return new Set([...this.accountRows().flatMap((a) => [...this.me(a)]), ...this.store.calendars().flatMap((x) => (x.owner_address ? [x.owner_address.toLowerCase()] : []))]);
      },
      schedules: (calendarId) => this.schedules(this.calendar(calendarId)),
      calendars: () => this.store.calendars().map((x) => this.toCalendar(x)),
      put: async (calendarId, href, raw, etag) => {
        const c = this.writable(this.calendar(calendarId));
        const acct = this.account(c.account_id);
        await this.locked(c.id, () => this.putAndStore(acct, c, href, raw, etag)).catch((err) => this.conflicted(c, err));
        this.syncSoon(c.id);
      },
      remove: async (calendarId, href, etag) => {
        const c = this.writable(this.calendar(calendarId));
        const acct = this.account(c.account_id);
        await this.locked(c.id, () => this.removeAt(acct, c, href, etag)).catch((err) => this.conflicted(c, err));
        this.syncSoon(c.id);
      },
      hrefFor: (calendarId, uid) => this.hrefIn(this.calendar(calendarId), uid),
      now: () => Date.now(),
      applyReply: async (ics, replier) => {
        try {
          const r = await this.applyItip({ method: 'REPLY', ics, from: { accountId: '', email: replier } });
          return r.ok && r.action === 'replied';
        } catch {
          return false;
        }
      },
    }, this.mailPort());
  }
  /** The guests of an event the person changed told by email, where the server does not (invites.ts `notify`); never fails the write. */
  private async notify(calendarId: string, uid: string, before: string | null, after: string | null, opts: { cancelRid?: number } = {}): Promise<Notified | null> {
    // A native calendar's guests are scheduled between accounts, and only the ones outside the platform are emailed.
    const native = this.store.calendar(calendarId);
    if (native?.href.startsWith(NATIVE_HREF)) return this.schedule(native, uid, before, after, opts);
    try {
      return await this.invites().notify(calendarId, uid, before, after, opts);
    } catch (err) {
      return { invitationsSent: false, invitationsNote: `The guests could not be emailed: ${(err as Error).message.slice(0, 200)}` };
    }
  }

  // ---- scheduling between accounts (platform.md §3.5, phase 4.2; itip.ts) ---------------------------------------

  /**
   * Addresses resolved through the directory (`accountByAddress`): an account of this organization that is not removed
   * or suspended is a platform attendee (its id, its name); anything else (another organization, no account, no
   * directory here) is outside, null.
   */
  private async resolveAddresses(emails: string[]): Promise<Map<string, ResolvedAttendee | null>> {
    const out = new Map<string, ResolvedAttendee | null>(emails.map((e) => [e, null]));
    const dir = this.env.DIRECTORY, org = this.store.state('owner_organization_id');
    if (!dir || !org || !emails.length) return out;
    const stub = dir.get(dir.idFromName('directory'));
    type Found = { id: string; organizationId: string; displayName?: string; state?: string } | null;
    await Promise.all(emails.map(async (e) => {
      try {
        const answer = await (stub.call as never as (m: string, a: unknown[]) => Promise<{ ok: boolean; value?: Found }>)('accountByAddress', [e]);
        const acct = answer.ok ? answer.value : null;
        if (acct && acct.organizationId === org && acct.state !== 'removed' && acct.state !== 'suspended') out.set(e, { accountId: acct.id, name: acct.displayName || null });
      } catch (err) {
        console.warn(`[calendar] an attendee not resolved: ${(err as Error).message.slice(0, 200)}`);
      }
    }));
    return out;
  }

  /**
   * An event the account organizes on a native calendar, with its attendees marked before it is stored: the ones that are
   * accounts of the organization get `X-FLOW-ACCOUNT` (itip.ts `markAccounts`), so later changes reach their objects.
   */
  private async markAttendees(c: CalendarRow, raw: string, uid: string): Promise<string> {
    const self = this.store.state('owner_account_id');
    if (!self || !c.href.startsWith(NATIVE_HREF)) return raw;
    const me = this.account(c.account_id).email.toLowerCase();
    if (organizerOf(raw, uid) !== me) return raw;
    const emails = attendeeAddresses(raw, uid).filter((e) => e !== me);
    if (!emails.length) return raw;
    return markAccounts(raw, uid, await this.resolveAddresses(emails), { email: me, accountId: self });
  }

  /**
   * After the organizer changed an event on a native calendar (`before` and `after`: its text either side of the write,
   * null when it did not exist or is gone): every platform attendee's object gets the REQUEST (new or changed) or the
   * CANCEL (deleted, taken off the guest list, or one occurrence, `cancelRid`) by binding, in parallel, before the request
   * is answered; the attendees outside the platform are emailed (invites.ts `notify`, from the organizer's mailbox).
   */
  private async schedule(c: CalendarRow, uid: string, before: string | null, after: string | null, opts: { cancelRid?: number } = {}): Promise<Notified | null> {
    const self = this.store.state('owner_account_id'), org = this.store.state('owner_organization_id');
    const me = this.account(c.account_id).email.toLowerCase();
    const ref = after ?? before;
    if (!self || !org || !ref || organizerOf(ref, uid) !== me) return null;
    const was = platformAttendees(before, uid, self), is = platformAttendees(after, uid, self);
    const ctx = { now: Date.now(), zone: c.timezone ?? 'UTC' };
    const sends: { to: [string, { accountId: string; name: string | null }]; method: 'REQUEST' | 'CANCEL'; ics: string }[] = [];
    if (opts.cancelRid && before) {
      if (was.size) { const ics = itipRequest(before, uid, 'CANCEL', ctx, opts.cancelRid); for (const to of was) sends.push({ to, method: 'CANCEL', ics }); }
    } else if (after) {
      if (is.size) { const ics = itipRequest(after, uid, 'REQUEST', ctx); for (const to of is) sends.push({ to, method: 'REQUEST', ics }); }
      const gone = before ? [...was].filter(([e]) => !is.has(e)) : [];
      if (gone.length) { const ics = itipRequest(before!, uid, 'CANCEL', ctx); for (const to of gone) sends.push({ to, method: 'CANCEL', ics }); }
    } else if (was.size) {
      const ics = itipRequest(before!, uid, 'CANCEL', ctx);
      for (const to of was) sends.push({ to, method: 'CANCEL', ics });
    }
    await Promise.all(sends.map(({ to: [email, a], method, ics }) => this.deliver(a.accountId, {
      method, ics, from: { accountId: self, email: me }, to: { accountId: a.accountId, email, name: a.name ?? email.split('@')[0]!, organizationId: org },
    })));
    const platform = new Set([...was.keys(), ...is.keys()]);
    try {
      return await this.invites().notify(c.id, uid, before, after, { ...opts, only: (email) => !platform.has(email) });
    } catch (err) {
      return { invitationsSent: false, invitationsNote: `The guests could not be emailed: ${(err as Error).message.slice(0, 200)}` };
    }
  }

  /** One iTIP message to another account's Calendar object, tried twice; a failure is logged (never an address or an id) and answers null. */
  private async deliver(accountId: string, msg: ItipDelivery): Promise<ItipAnswer | null> {
    const ns = this.env.CALENDAR;
    if (!ns) return null;
    for (let i = 1; i <= DELIVERY_TRIES; i++) {
      try {
        const answer = (await ns.get(ns.idFromName(accountId)).receiveItip(msg)) as ItipAnswer;
        if (!answer.ok) console.warn(`[calendar] ${msg.method} refused by the other calendar: ${answer.code}`);
        return answer;
      } catch (err) {
        console.warn(`[calendar] ${msg.method} delivery ${i}/${DELIVERY_TRIES} failed: ${(err as Error).message.slice(0, 200)}`);
      }
    }
    return null;
  }

  // ---- events ---------------------------------------------------------------------------------------------------

  private writeContext(acct: AccountRow, c: CalendarRow, zone?: string | null): WriteContext {
    const s = this.serverOf(acct);
    const organizer = s.addresses.find((a) => a === acct.email.toLowerCase()) ?? acct.email.toLowerCase();
    return { me: [...this.meOn(acct, c)], organizer, displayName: acct.display_name, zone: zone || c.timezone || 'UTC', now: Date.now() };
  }

  /**
   * Writes an object to the server and then to the cache: the etag the PUT answered with, else the object as stored there.
   * A native calendar has no server: the store is written (If-Match against the stored etag) and the change is published.
   */
  private async putAndStore(acct: AccountRow, c: CalendarRow, href: string, raw: string, etag: string | null, publish: { type?: string; extra?: Record<string, unknown> } = {}): Promise<void> {
    const opts = { me: this.meOn(acct, c), zone: c.timezone ?? 'UTC' };
    if (acct.kind === 'native') {
      const { uid } = this.store.putNative(c.id, href, raw, etag, opts);
      if (uid) await this.publish(publish.type ?? (etag === null ? 'calendar.event.added' : 'calendar.event.updated'), c, uid, { extra: publish.extra });
      return;
    }
    const d = this.driverOf(acct);
    const put = await d.put(href, raw, etag);
    if (put.etag) { this.store.putObject(c.id, href, put.etag, raw, opts); return; }
    const [stored] = await d.get(c.href, [href]);
    if (stored) this.store.putObject(c.id, stored.href, stored.etag, stored.data, opts);
  }

  /** Deletes an object on the server and then from the cache; a native one from the store, and its cancellation published. */
  private async removeAt(acct: AccountRow, c: CalendarRow, href: string, etag: string | null): Promise<void> {
    if (acct.kind === 'native') {
      const gone = this.store.objectAt(c.id, href);
      const before = gone ? this.store.find(c.id, gone.uid, null)?.event ?? null : null;
      this.store.deleteNative(c.id, href, etag);
      if (gone) await this.publish('calendar.event.cancelled', c, gone.uid, { snapshot: before });
      return;
    }
    await this.driverOf(acct).delete(href, etag);
    this.store.deleteObject(c.id, href);
  }

  /**
   * A native calendar's change into the organization's event log (platform.md §5.2): `calendar.event.added`, `.updated` or
   * `.cancelled`, about the event, for whoever the calendar is shared with (`ref:` the calendar, from the share index) and
   * its owner (`data.ownerAccountId`), with `extra` data (a REPLY's `attendeeResponse`). `calendar.invited` (phase 4.2)
   * goes to the invited account alone (`audience`), with the organizer. A failure is logged, never the write's.
   */
  private async publish(type: string, c: CalendarRow, uid: string, o: { snapshot?: EventOccurrence | null; extra?: Record<string, unknown>; audience?: `account:${string}`; organizer?: { accountId: string; email: string } } = {}): Promise<void> {
    const ns = this.env.EVENTS, org = this.store.state('owner_organization_id'), owner = this.store.state('owner_account_id');
    if (!ns || !org || !owner) return;
    const ev = o.snapshot ?? this.store.find(c.id, uid, null)?.event;
    if (!ev) return;
    const eventId = eventIdOf(c.id, uid);
    const base = (this.env.WEB_URL_BASE ?? '').replace(/\/+$/, '');
    try {
      await ns.get(ns.idFromName(org)).publish({
        type, organizationId: org, actor: timing.getStore()?.actor ?? null,
        ...(timing.getStore()?.via ? { via: timing.getStore()!.via! } : {}), ...(timing.getStore()?.invokedBy ? { invokedBy: timing.getStore()!.invokedBy! } : {}),
        ref: { organizationId: org, app: 'calendar', kind: 'event', id: eventId },
        audience: o.audience ?? `ref:${formatReference({ organizationId: org, app: 'calendar', kind: 'calendar', id: c.id })}`,
        ts: new Date().toISOString(),
        data: {
          calendarId: c.id, eventId, uid, summary: ev.summary, start: ev.start, end: ev.end, allDay: ev.allDay, ownerAccountId: owner, url: `${base}/calendar/week/${ev.start.slice(0, 10)}?event=${encodeURIComponent(eventId)}`,
          ...(o.organizer ? { organizer: { email: ev.organizer?.email ?? o.organizer.email, name: ev.organizer?.name ?? null, accountId: o.organizer.accountId } } : {}),
          ...o.extra,
        },
      });
    } catch (err) {
      console.error(`[calendar] ${type}: ${(err as Error).message.slice(0, 200)}`);
    }
  }

  // ---- grants on native calendars (platform.md §4.3–§4.5) -----------------------------------------------------------

  /** The stored grants on one object. */
  private grantsOn(kind: string, id: string): Grant[] {
    const q = grantsForChainSql([{ objectKind: kind, objectId: id }]);
    return this.sql.exec<GrantRow & Record<string, SqlStorageValue>>(q.sql, ...q.params).toArray().map((r) => grantFromRow(r));
  }

  /**
   * A reader's role on a calendar (or an event in it): the owner is the native account's owner (a column, the object's
   * account); otherwise the grants on the event and the calendar it is in. Only native calendars are shared. With no
   * reader the request is the owner's own: `owner` on every calendar.
   */
  private roleFor(reader: GrantReader | undefined, c: CalendarRow, eventId?: string): Role | null {
    if (!reader) return 'owner';
    if (!c.href.startsWith(NATIVE_HREF)) return null;
    const chain = [...(eventId ? [{ objectKind: 'event', objectId: eventId, grants: this.grantsOn('event', eventId) }] : []), { objectKind: 'calendar', objectId: c.id, grants: this.grantsOn('calendar', c.id) }];
    return effectiveRole({ reader, ownerAccountId: this.store.state('owner_account_id'), chain });
  }

  /** The calendar, when the request's caller has at least `role` on it: no role is not_found (it does not leak), too low is forbidden. */
  private need(c: Context<{ Bindings: Bindings }>, calendarId: string, role: Role, eventId?: string): CalendarRow {
    const cal = this.store.calendar(calendarId);
    const has = cal ? this.roleFor(c.env.reader, cal, eventId) : null;
    if (!cal || !has) throw notFound('no such calendar');
    if (!atLeast(has, role)) throw calendarError(403, 'forbidden', `You need to be ${role === 'editor' ? 'an editor' : `a ${role}`} of this calendar`);
    return cal;
  }

  /** Whether an account is an active member of the owner's organization (the Org object knows its members' accounts): an
   * `account:` grant must name one. No Org binding, no member. */
  private async isMemberAccount(accountId: string): Promise<boolean> {
    const ns = this.env.ORG, org = this.store.state('owner_organization_id');
    return !!ns && !!org && (await ns.get(ns.idFromName(org)).isActiveAccount(accountId));
  }

  /** A grant given, changed or taken away, told to the organization's share index (Org.recordShare / revokeShare); logged on failure. */
  private async reportGrant(c: CalendarRow, principal: string, role: Role | null): Promise<void> {
    const ns = this.env.ORG, org = this.store.state('owner_organization_id');
    if (!ns || !org) return;
    const ref = formatReference({ organizationId: org, app: 'calendar', kind: 'calendar', id: c.id });
    const actor = timing.getStore()?.actor ?? this.store.state('owner_account_id') ?? '';
    try {
      const stub = ns.get(ns.idFromName(org));
      if (role) await stub.recordShare({ ref, principal, role, grantedBy: actor, title: c.name, kind: 'calendar' });
      else await stub.revokeShare({ ref, principal, revokedBy: actor });
    } catch (err) {
      console.error(`[calendar] share index: ${(err as Error).message.slice(0, 200)}`);
    }
  }

  /** A conflict: the calendar synced now, so the next look shows the server's copy; then the error. */
  private async conflicted(c: CalendarRow, err: unknown): Promise<never> {
    if (err instanceof ApiError && err.code === 'conflict') await this.syncCalendar(c.id).catch(() => {});
    throw err;
  }

  private target(id: string) {
    const { calendarId, uid, rid } = splitId(id);
    const ridMs = rid === null ? 0 : parseRid(rid);
    if (ridMs === null) throw badRequest('id: not an event id');
    const c = this.calendar(calendarId);
    const obj = this.store.objectByUid(c.id, uid);
    if (!obj) throw notFound('no such event');
    return { c, uid, rid: ridMs, obj, acct: this.account(c.account_id) };
  }

  private view(calendarId: string, uid: string, rid: number): EventOccurrence {
    const found = (rid && this.store.find(calendarId, uid, rid)) || this.store.find(calendarId, uid, null);
    if (!found) throw notFound('no such event');
    return found.event;
  }

  private window(c: Context): { from: number; to: number } {
    const q = c.req.query('q')?.trim();
    const fromText = c.req.query('from'), toText = c.req.query('to');
    if (!fromText && !toText && q) return { from: Date.now() - SEARCH_SPAN_MS, to: Date.now() + SEARCH_SPAN_MS };
    if (!fromText || !toText) throw badRequest('from and to: required (ISO times)');
    const from = parseInstant(fromText, null), to = parseInstant(toText, null);
    if (to <= from) throw badRequest('to: after from');
    if (to - from > MAX_WINDOW_MS) throw badRequest('the window is at most 3 months; ask per visible range');
    return { from, to };
  }

  /** The person's own busy time in a window, from the cache: every opaque event not declined or cancelled, merged. */
  private ownBusy(from: number, to: number): Interval[] {
    return this.busyIn(this.store.calendars().filter((c) => !c.hidden).map((c) => c.id), from, to);
  }
  private busyIn(calendarIds: string[], from: number, to: number): Interval[] {
    const busy = this.store.list(calendarIds, from, to).filter((o) => !o.transparent && o.status !== 'cancelled' && o.myResponse !== 'declined')
      .map((o) => [Math.max(from, Date.parse(o.start)), Math.min(to, Date.parse(o.end))] as [number, number]).filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];
    for (const [a, b] of busy) {
      const last = merged.at(-1);
      if (last && a <= last[1]) last[1] = Math.max(last[1], b);
      else merged.push([a, b]);
    }
    return merged.map(([a, b]) => [new Date(a).toISOString(), new Date(b).toISOString()]);
  }

  /**
   * Busy time of the addresses that are accounts of this organization (the directory's addresses), from each account's
   * Calendar object (`busy`), visible to any member (platform.md §3.5). Addresses that are not are left out of the answer.
   */
  private async memberBusy(emails: string[], from: number, to: number): Promise<Map<string, Interval[]>> {
    const out = new Map<string, Interval[]>();
    const { DIRECTORY: dir, CALENDAR: cals } = this.env;
    const org = this.store.state('owner_organization_id'), self = this.store.state('owner_account_id');
    if (!dir || !cals || !org || !emails.length) return out;
    const stub = dir.get(dir.idFromName('directory'));
    await Promise.all(emails.map(async (e) => {
      try {
        const answer = (await (stub.call as never as (m: string, a: unknown[]) => Promise<{ ok: boolean; value?: { id: string; organizationId: string } | null }>)('accountByAddress', [e]));
        const acct = answer.ok ? answer.value : null;
        if (!acct || acct.organizationId !== org || acct.id === self) return;
        out.set(e, (await cals.get(cals.idFromName(acct.id)).busy(from, to)) as unknown as Interval[]);
      } catch (err) {
        console.warn(`[calendar] free/busy of a member: ${(err as Error).message.slice(0, 200)}`);
      }
    }));
    return out;
  }

  // ---- routes -----------------------------------------------------------------------------------------------------

  private routes(): void {
    const app = this.app;
    app.onError((err, c) => {
      if (err instanceof ApiError) return c.json({ error: { code: err.code, message: err.message } }, err.statusCode as 400);
      console.error(`[calendar] ${(err as Error).name}: ${(err as Error).message.slice(0, 200)}`);
      return c.json({ error: { code: 'server_error', message: 'internal server error' } }, 500);
    });
    app.notFound((c) => c.json({ error: { code: 'not_found', message: 'not found' } }, 404));
    // A reader of a shared calendar (handleShared) reaches only the routes a shared calendar has.
    app.use('*', async (c, next) => {
      if (c.env.reader && !SHARED_ROUTES.some(([m, re]) => m === c.req.method && re.test(new URL(c.req.url).pathname))) throw notFound('not found');
      await next();
    });

    app.get('/v1/calendar/accounts', (c) => c.json({ accounts: this.accountRows().map((r) => this.toAccount(r)) }));

    app.post('/v1/calendar/accounts', async (c) => {
      const b = parse(NewAccount, await json(c));
      const preset = providerFor(b.email);
      if (preset && 'google' in preset && !b.server) throw badRequest(preset.note);
      const url = normalizeUrl(b.server?.url ?? (preset && 'url' in preset ? preset.url : ''));
      if (!b.server?.url && !(preset && 'url' in preset)) throw badRequest('server.url: required for this address (the CalDAV server, e.g. https://cloud.example.com/remote.php/dav)');
      const username = b.server?.username?.trim() || b.email;
      const { found, calendars } = await this.verify(url, username, b.password);
      const id = crypto.randomUUID();
      const sealed = encryptBlob(Buffer.from(b.password, 'utf8'));
      const server: ServerState = { url, username, principal: found.principal, home: found.home, addresses: found.addresses, outbox: found.outbox };
      this.sql.exec('INSERT INTO accounts (id, kind, email, display_name, server, secret, key_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id, 'caldav', b.email, b.displayName.trim() || b.email.split('@')[0], JSON.stringify(server), new Uint8Array(sealed.blob).buffer, sealed.encKeyId, 'ok', Date.now());
      this.applyCalendars(id, calendars);
      await this.firstSync(id);
      return c.json({ account: this.toAccount(this.account(id)), calendars: this.store.calendarsOf(id).map((x) => this.toCalendar(x)) }, 201);
    });

    app.patch('/v1/calendar/accounts/:id', async (c) => {
      const r = this.account(c.req.param('id'));
      const b = parse(AccountPatch, await json(c));
      if (r.kind === 'native' && (b.password !== undefined || b.server)) throw badRequest('Your FreeFlow calendar has no server or password');
      if (r.kind === 'google' && (b.password !== undefined || b.server)) throw badRequest('A Google account has no password here: reconnect it with Google');
      if (b.password !== undefined || b.server) {
        const s = this.serverOf(r);
        const url = normalizeUrl(b.server?.url ?? s.url);
        const username = b.server?.username?.trim() || s.username;
        const password = b.password ?? this.password(r);
        const { found, calendars } = await this.verify(url, username, password);
        const server: ServerState = { url, username, principal: found.principal, home: found.home, addresses: found.addresses, outbox: found.outbox };
        this.sql.exec("UPDATE accounts SET server = ?, status = 'ok', status_message = NULL WHERE id = ?", JSON.stringify(server), r.id);
        if (b.password !== undefined) {
          const sealed = encryptBlob(Buffer.from(b.password, 'utf8'));
          this.sql.exec('UPDATE accounts SET secret = ?, key_id = ? WHERE id = ?', new Uint8Array(sealed.blob).buffer, sealed.encKeyId, r.id);
        }
        this.applyCalendars(r.id, calendars);
        this.ctx.waitUntil((async () => { for (const cal of this.store.calendarsOf(r.id)) await this.syncCalendar(cal.id).catch(() => {}); })());
      }
      if (b.displayName !== undefined) this.sql.exec('UPDATE accounts SET display_name = ? WHERE id = ?', b.displayName.trim() || r.email.split('@')[0], r.id);
      return c.json({ account: this.toAccount(this.account(r.id)) });
    });

    // The account's calendars listed again now (one ticked or added elsewhere since; the alarm does it every RELIST_MS),
    // and the new ones synced, as far as a few seconds go.
    app.post('/v1/calendar/accounts/:id/refresh', async (c) => {
      const r = this.account(c.req.param('id'));
      if (r.kind === 'native') return c.json({ calendars: this.store.calendarsOf(r.id).map((x) => this.toCalendar(x)), added: 0, removed: 0 });
      const before = new Set(this.store.calendarsOf(r.id).map((x) => x.id));
      const s = this.serverOf(r);
      this.applyCalendars(r.id, await this.driverOf(r).calendars(s.home, s.principal));
      const fresh = this.store.calendarsOf(r.id).filter((x) => !before.has(x.id));
      const deadline = Date.now() + 8_000;
      for (const cal of fresh) { if (Date.now() > deadline) break; await this.syncCalendar(cal.id).catch(() => {}); }
      return c.json({ calendars: this.store.calendarsOf(r.id).map((x) => this.toCalendar(x)), added: fresh.length, removed: [...before].filter((id) => !this.store.calendar(id)).length });
    });

    app.delete('/v1/calendar/accounts/:id', (c) => {
      const r = this.account(c.req.param('id'));
      if (r.kind === 'native') throw badRequest('Your FreeFlow calendar cannot be removed');
      for (const cal of this.store.calendarsOf(r.id)) this.store.forgetCalendar(cal.id);
      this.sql.exec('DELETE FROM accounts WHERE id = ?', r.id);
      this.store.ensureDefault();
      return c.json({ ok: true });
    });

    app.get('/v1/calendar/calendars', (c) => c.json({ calendars: this.store.calendars().map((x) => this.toCalendar(x)) }));

    app.patch('/v1/calendar/calendars/:id', async (c) => {
      const cal = this.calendar(c.req.param('id'));
      const b = parse(CalendarPatch, await json(c));
      if (b.hidden !== undefined) this.sql.exec('UPDATE calendars SET hidden = ? WHERE id = ?', b.hidden ? 1 : 0, cal.id);
      if (b.color !== undefined) this.sql.exec('UPDATE calendars SET color = ? WHERE id = ?', b.color?.toLowerCase() ?? null, cal.id);
      if (b.isDefault) {
        this.writable(cal);
        this.store.ensureDefault(cal.id);
      }
      return c.json({ calendar: this.toCalendar(this.calendar(cal.id)) });
    });

    // Grants on a native calendar (platform.md §4.3): who it is shared with, and the caller's role; a manager (or the owner)
    // shares it with an account, a channel or the organization. Each change goes to the share index. Links are not offered.
    const grantsAnswer = (c: Context<{ Bindings: Bindings }>, cal: CalendarRow) => c.json({ grants: this.grantsOn('calendar', cal.id), role: this.roleFor(c.env.reader, cal) });
    const shareable = (cal: CalendarRow) => {
      if (!cal.href.startsWith(NATIVE_HREF)) throw calendarError(400, 'not_supported', 'Only a FreeFlow calendar can be shared here; share a connected one on its own server');
      return cal;
    };
    app.get('/v1/calendar/calendars/:id/grants', (c) => grantsAnswer(c, shareable(this.need(c, c.req.param('id'), 'viewer'))));
    app.put('/v1/calendar/calendars/:id/grants', async (c) => {
      const cal = shareable(this.need(c, c.req.param('id'), 'manager'));
      const b = parse(GrantBody, await json(c));
      let kind: string;
      try { kind = parsePrincipal(b.principal).kind; } catch { throw badRequest('principal: account:<id>, channel:<id> or org'); }
      if (kind === 'link') throw calendarError(400, 'not_supported', 'A calendar is not shared by link');
      if (b.principal === `account:${this.store.state('owner_account_id')}`) throw badRequest('principal: the owner has the calendar already');
      if (kind === 'account' && !(await this.isMemberAccount(b.principal.slice('account:'.length)))) throw calendarError(400, 'not_a_member', 'That account is not a member of this organization');
      const actor = timing.getStore()?.actor ?? '';
      const g = grantSql({ objectKind: 'calendar', objectId: cal.id, principal: b.principal as GrantPrincipal, role: b.role, grantedBy: actor, grantedAt: new Date().toISOString() });
      this.sql.exec(g.sql, ...g.params);
      await this.reportGrant(cal, b.principal, b.role);
      return grantsAnswer(c, cal);
    });
    app.delete('/v1/calendar/calendars/:id/grants/:principal', async (c) => {
      const cal = shareable(this.need(c, c.req.param('id'), 'manager'));
      const principal = c.req.param('principal');
      const q = revokeSql('calendar', cal.id, principal);
      const had = this.grantsOn('calendar', cal.id).some((g) => g.principal === principal);
      this.sql.exec(q.sql, ...q.params);
      if (had) await this.reportGrant(cal, principal, null);
      return grantsAnswer(c, cal);
    });

    app.get('/v1/calendar/events', (c) => {
      const { from, to } = this.window(c);
      const asked = c.req.query('calendars')?.split(',').map((s) => s.trim()).filter(Boolean);
      const cals = this.store.calendars();
      const reader = c.env.reader;
      // A reader names the shared calendars it reads, and sees those it is at least a viewer of.
      const ids = reader ? cals.filter((x) => asked?.includes(x.id) && this.roleFor(reader, x)).map((x) => x.id)
        : asked ? cals.filter((x) => asked.includes(x.id)).map((x) => x.id) : cals.filter((x) => !x.hidden).map((x) => x.id);
      if (reader && !ids.length) throw notFound('no such calendar');
      const limit = Math.min(2000, Math.max(1, Number(c.req.query('limit')) || 2000));
      return c.json({ events: this.store.list(ids, from, to, c.req.query('q'), limit) });
    });

    app.get('/v1/calendar/events/:id', (c) => {
      const { calendarId, uid, rid } = splitId(c.req.param('id'));
      const ridMs = rid === null ? null : parseRid(rid);
      if (rid !== null && ridMs === null) throw badRequest('id: not an event id');
      if (c.env.reader) this.need(c, calendarId, 'viewer', eventIdOf(calendarId, uid));
      const found = this.store.find(calendarId, uid, ridMs);
      const obj = this.store.objectByUid(calendarId, uid);
      if (!found || !obj) throw notFound('no such event');
      return c.json({ event: found.event, ...(found.master ? { master: found.master } : {}), raw: obj.raw });
    });

    app.post('/v1/calendar/events', async (c) => {
      const b = parse(EventInput, await json(c));
      if (c.env.reader && !b.calendarId) throw badRequest('calendarId: required');
      if (c.env.reader) this.need(c, b.calendarId!, 'editor');
      const cal = this.writable(b.calendarId ? this.calendar(b.calendarId) : this.store.calendars().find((x) => x.is_default) ?? (() => { throw badRequest('connect a calendar first'); })());
      const acct = this.account(cal.account_id);
      const uid = crypto.randomUUID();
      // On a native calendar the attendees that are accounts of the organization are marked, to be scheduled by object call.
      const raw = await this.markAttendees(cal, newEvent(uid, b as Fields & { summary: string; start: string; end: string }, this.writeContext(acct, cal, b.timezone)), uid);
      const href = this.hrefIn(cal, uid);
      await this.locked(cal.id, () => this.putAndStore(acct, cal, href, raw, null));
      this.syncSoon(cal.id);
      const sent = await this.notify(cal.id, uid, null, this.store.objectByUid(cal.id, uid)?.raw ?? raw);
      return c.json({ event: this.view(cal.id, uid, 0), ...sent }, 201);
    });

    app.patch('/v1/calendar/events/:id', async (c) => {
      if (c.env.reader) { const { calendarId, uid } = splitId(c.req.param('id')); this.need(c, calendarId, 'editor', eventIdOf(calendarId, uid)); }
      const t = this.target(c.req.param('id'));
      const b = parse(EventPatch, await json(c));
      const { scope: asked, etag, calendarId: moveTo, conference: _conference, ...fields } = b;
      const cal = this.writable(t.c);
      if (c.env.reader && moveTo && moveTo !== cal.id) this.need(c, moveTo, 'editor');
      if (etag && etag !== t.obj.etag) throw conflict();
      const scope: Scope = asked ?? (t.rid ? 'this' : 'all');
      const ctx = this.writeContext(t.acct, cal, fields.timezone);
      // A change the guests see (anything but the person's own reminders) is sent to them where the server does not schedule.
      const guestsCare = Object.keys(fields).some((k) => k !== 'reminders');
      // On a native calendar only the organizer changes an event; an attendee answers it (respond) or sets its own reminders.
      if (cal.href.startsWith(NATIVE_HREF) && (guestsCare || (moveTo && moveTo !== cal.id))) {
        const organizer = organizerOf(t.obj.raw, t.uid);
        if (organizer && !this.meOn(t.acct, cal).has(organizer)) throw calendarError(403, 'not_organizer', 'Only the organizer can change this event; answer the invitation instead');
      }
      const mark = (target: CalendarRow, raw: string, uid: string) => (fields.attendees !== undefined ? this.markAttendees(target, raw, uid) : Promise.resolve(raw));
      if (moveTo && moveTo !== cal.id) {
        // To another calendar: the whole event, written there first and then deleted here.
        if (t.rid && scope !== 'all') throw badRequest('calendarId: an occurrence moves with its whole series (scope all)');
        const dest = this.writable(this.calendar(moveTo));
        const destAcct = this.account(dest.account_id);
        const edited = await mark(dest, editEvent(t.obj.raw, t.uid, t.rid, 'all', fields as Fields, ctx, () => crypto.randomUUID()).raw, t.uid);
        const href = this.hrefIn(dest, t.uid);
        await this.locked(dest.id, () => this.putAndStore(destAcct, dest, href, edited, null));
        await this.locked(cal.id, () => this.removeAt(t.acct, cal, t.obj.href, t.obj.etag)).catch((err) => this.conflicted(cal, err));
        this.syncSoon(dest.id);
        this.syncSoon(cal.id);
        const sent = guestsCare ? await this.notify(dest.id, t.uid, t.obj.raw, this.store.objectByUid(dest.id, t.uid)?.raw ?? edited) : null;
        return c.json({ event: this.view(dest.id, t.uid, 0), ...sent });
      }
      const out = editEvent(t.obj.raw, t.uid, t.rid, scope, fields as Fields, ctx, () => crypto.randomUUID());
      out.raw = await mark(cal, out.raw, t.uid);
      if (out.created) out.created.raw = await mark(cal, out.created.raw, out.created.uid);
      await this.locked(cal.id, async () => {
        if (out.created) {
          const href = this.hrefIn(cal, out.created.uid);
          await this.putAndStore(t.acct, cal, href, out.created.raw, null);
          try {
            await this.putAndStore(t.acct, cal, t.obj.href, out.raw, t.obj.etag);
          } catch (err) {
            // The old series could not be ended: take the new one back, so nothing shows twice.
            await this.removeAt(t.acct, cal, href, null).catch(() => {});
            this.store.deleteObject(cal.id, href);
            throw err;
          }
        } else await this.putAndStore(t.acct, cal, t.obj.href, out.raw, t.obj.etag);
      }).catch((err) => this.conflicted(cal, err));
      this.syncSoon(cal.id);
      let sent: Notified | null = null;
      if (guestsCare) {
        sent = await this.notify(cal.id, t.uid, t.obj.raw, this.store.objectByUid(cal.id, t.uid)?.raw ?? out.raw);
        if (out.created) sent = Invites.combine(sent, await this.notify(cal.id, out.created.uid, null, this.store.objectByUid(cal.id, out.created.uid)?.raw ?? out.created.raw));
      }
      return c.json({ event: out.created ? this.view(cal.id, out.created.uid, 0) : this.view(cal.id, t.uid, scope === 'this' ? t.rid : 0), ...sent });
    });

    app.delete('/v1/calendar/events/:id', async (c) => {
      if (c.env.reader) { const { calendarId, uid } = splitId(c.req.param('id')); this.need(c, calendarId, 'editor', eventIdOf(calendarId, uid)); }
      const t = this.target(c.req.param('id'));
      const cal = this.writable(t.c);
      const asked = c.req.query('scope');
      if (asked && !['this', 'following', 'all'].includes(asked)) throw badRequest('scope: this, following or all');
      const scope = (asked as Scope | undefined) ?? (t.rid ? 'this' : 'all');
      const raw = deleteFromEvent(t.obj.raw, t.uid, t.rid, scope, this.writeContext(t.acct, cal));
      await this.locked(cal.id, async () => {
        if (raw === null) await this.removeAt(t.acct, cal, t.obj.href, t.obj.etag);
        else await this.putAndStore(t.acct, cal, t.obj.href, raw, t.obj.etag);
      }).catch((err) => this.conflicted(cal, err));
      this.syncSoon(cal.id);
      const sent = await this.notify(cal.id, t.uid, t.obj.raw, raw === null ? null : (this.store.objectByUid(cal.id, t.uid)?.raw ?? raw), raw !== null && scope === 'this' ? { cancelRid: t.rid } : {});
      return c.json({ ok: true, ...sent });
    });

    app.post('/v1/calendar/events/:id/respond', async (c) => {
      const t = this.target(c.req.param('id'));
      const b = parse(RespondBody, await json(c));
      const raw = respondTo(t.obj.raw, t.uid, t.rid, b.response, b.comment, this.writeContext(t.acct, t.c));
      await this.locked(t.c.id, () => this.putAndStore(t.acct, t.c, t.obj.href, raw, t.obj.etag)).catch((err) => this.conflicted(t.c, err));
      this.syncSoon(t.c.id);
      // An organizer of the platform hears it from this object by binding, before this answers; one outside, by email.
      const organizer = t.c.href.startsWith(NATIVE_HREF) ? summaryOf(raw, t.uid)?.organizer : null;
      const self = this.store.state('owner_account_id');
      let replied: Awaited<ReturnType<Invites['replied']>>;
      if (organizer?.accountId && self && organizer.accountId !== self) {
        const ics = itipReply(raw, t.uid, t.rid, { me: [...this.meOn(t.acct, t.c)], now: Date.now() });
        const answer = await this.deliver(organizer.accountId, { method: 'REPLY', ics, from: { accountId: self, email: t.acct.email.toLowerCase() } });
        replied = answer?.ok ? { replied: 'server' } : { replied: 'failed', replyError: answer && !answer.ok ? answer.message : 'The organizer\'s calendar could not be reached' };
      } else replied = await this.invites().replied(t.c.id, raw, t.uid, t.rid, b.response);
      return c.json({ event: this.view(t.c.id, t.uid, t.rid), ...replied });
    });

    // Invitations in Mail (invites.ts): what one is, the person's answer, a cancellation taken off the calendar.
    app.post('/v1/calendar/invites', async (c) => c.json(await this.invites().read(await json(c))));
    app.post('/v1/calendar/invites/respond', async (c) => c.json(await this.invites().respond(await json(c))));
    app.post('/v1/calendar/invites/cancel', async (c) => c.json(await this.invites().cancel(await json(c))));

    app.post('/v1/calendar/freebusy', async (c) => {
      const b = parse(FreeBusyBody, await json(c));
      const from = parseInstant(b.from, null), to = parseInstant(b.to, null);
      if (to <= from || to - from > MAX_WINDOW_MS) throw badRequest('from and to: a window of at most 3 months');
      const accounts = this.accountRows();
      const mine = new Set([...accounts.flatMap((a) => [...this.me(a)]), ...this.store.calendars().flatMap((x) => (x.owner_address ? [x.owner_address.toLowerCase()] : []))]);
      const emails = [...new Set(b.emails.map((e) => e.toLowerCase()))];
      const busy: { email: string; intervals: Interval[]; source: 'self' | 'member' | 'server' }[] = [];
      const unknown: string[] = [];
      const own = this.ownBusy(from, to);
      for (const e of emails) if (mine.has(e)) busy.push({ email: e, intervals: own, source: 'self' });
      let others = emails.filter((e) => !mine.has(e));
      if (!emails.length) busy.push({ email: accounts[0]?.email.toLowerCase() ?? 'me', intervals: own, source: 'self' });
      // Members of the organization answer from their own Calendar objects (their native calendars' busy time, no details).
      const members = await this.memberBusy(others, from, to);
      for (const [e, intervals] of members) busy.push({ email: e, intervals, source: 'member' });
      others = others.filter((e) => !members.has(e));
      let answered = new Map<string, Interval[]>();
      const withOutbox = accounts.find((a) => a.status === 'ok' && this.serverOf(a).outbox);
      if (others.length && withOutbox) {
        const s = this.serverOf(withOutbox);
        answered = (await this.driverOf(withOutbox).freebusy({ principal: s.principal, home: s.home, addresses: s.addresses, outbox: s.outbox }, withOutbox.email, others, from, to).catch(() => null)) ?? new Map();
      }
      for (const e of others) {
        const got = answered.get(e);
        if (got) busy.push({ email: e, intervals: got, source: 'server' });
        else unknown.push(e);
      }
      return c.json({ busy, unknown });
    });

    const debug = async () => ({
      calendars: this.store.calendars().map((x) => ({ id: x.id, accountId: x.account_id, name: x.name, supportsSync: !!x.supports_sync, hasToken: !!x.sync_token, lastSynced: x.last_synced ? new Date(x.last_synced).toISOString() : null, objects: this.store.objectCount(x.id) })),
      runs: this.store.syncRuns(), lastActiveAt: new Date(this.lastActiveAt()).toISOString(), nextAlarmAt: await this.ctx.storage.getAlarm(), databaseBytes: this.sql.databaseSize,
    });
    app.get('/v1/calendar/debug/sync', async (c) => c.json(await debug()));
    app.post('/v1/calendar/debug/sync', async (c) => {
      const result = await this.runSync(Date.now() + 25_000, true);
      return c.json({ ...result, ...(await debug()) });
    });
  }
}

