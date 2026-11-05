// FreeFlow Calendar: one object per person (`idFromName(userId)`), holding the calendar accounts they connected and a
// complete copy of their calendars, kept fresh by the alarm. The contract is docs/specs/calendar.md (§3, §4).
//
// Every read is from SQLite (store.ts); a recurring event is expanded here for the window asked for (ical.ts). Writes go to
// the server first (PUT with If-Match, so a change made elsewhere meanwhile is a `conflict`, never lost), then into the
// cache, and the calendar is synced right after. Passwords are sealed with FLOW_DATA_KEY (org/crypto, as Mail's are) and
// never returned or logged; no address, summary or id goes in a log line.
import { AsyncLocalStorage } from 'node:async_hooks';
import { DurableObject } from 'cloudflare:workers';
import { Hono, type Context } from 'hono';
import { ApiError } from '../errors';
import { decryptBlob, encryptBlob } from '../org/crypto/index';
import { CalDav, type Credential, type Discovery, type Driver, type Interval, type RemoteCalendar } from './drivers/caldav';
import { googlePrincipal, refreshAccess, type GoogleClient } from './google';
import { DAY_MS, deleteFromEvent, editEvent, newEvent, parseInstant, parseRid, respondTo, type Fields, type Scope, type WriteContext } from './ical';
import { CalendarStore, type CalendarRow, type EventOccurrence } from './store';
import {
  AccountPatch, CalendarPatch, EventInput, EventPatch, FreeBusyBody, NewAccount, RELIST_MS, RespondBody, SYNC_BUDGET_MS, TIMING_HEADER, badRequest, calendarError,
  cadenceMs, checkUrl, conflict, nextAlarmAt, normalizeUrl, notFound, parse, providerFor, splitId,
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
}

/** A Google account as the callback hands it over (routes/calendar.ts): who, and the tokens the consent gave. */
export interface GoogleGrant { email: string; displayName: string; refreshToken: string; accessToken: string; expiresAt: number }

interface AccountRow {
  id: string; kind: string; email: string; display_name: string; server: string; secret: ArrayBuffer; key_id: string;
  status: string; status_message: string | null; created_at: number; calendars_at: number;
}
interface ServerState { url: string; username: string; principal: string; home: string; addresses: string[]; outbox: string | null }
export interface CalendarAccount { id: string; kind: 'caldav' | 'google'; email: string; displayName: string; server?: { url: string; username: string }; status: 'ok' | 'auth_failed' | 'connect_failed'; statusMessage?: string }
export interface CalendarInfo { id: string; accountId: string; name: string; color: string; timezone: string | null; role: 'owner' | 'writer' | 'reader'; hidden: boolean; isDefault: boolean; syncedAt: string | null }

/** Where a request's time went, for its log line: talking to calendar servers. */
interface Timing { server: number }
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
  private readonly app = new Hono();
  /** One sync or write at a time per calendar, so a sync never writes back what a PUT just replaced. */
  private readonly locks = new Map<string, Promise<unknown>>();
  private syncing = false;
  private lastTouch = 0;
  /** Google accounts' access tokens, in memory only (an hour each; a woken object refreshes). Never logged or returned. */
  private readonly access = new Map<string, { token: string; exp: number }>();

  constructor(ctx: DurableObjectState, env: CalendarEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.store = new CalendarStore(this.sql);
    this.store.init();
    this.routes();
  }

  /** A request from routes/calendar.ts. Its server time goes back in `x-calendar-timing`, which the route logs (as Mail's). */
  async handle(request: Request): Promise<Response> {
    const t: Timing = { server: 0 };
    const res = await timing.run(t, () => this.app.fetch(request));
    this.touch();
    await this.armAlarm().catch((err) => console.warn(`[calendar] alarm: ${(err as Error).message}`));
    const out = new Response(res.body, res);
    out.headers.set(TIMING_HEADER, `server=${Math.round(t.server)}`);
    return out;
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
  private serverOf(r: AccountRow): ServerState { return JSON.parse(r.server) as ServerState; }
  private toAccount(r: AccountRow): CalendarAccount {
    const s = this.serverOf(r);
    return { id: r.id, kind: r.kind as CalendarAccount['kind'], email: r.email, displayName: r.display_name, server: { url: s.url, username: s.username }, status: r.status as CalendarAccount['status'], ...(r.status_message ? { statusMessage: r.status_message } : {}) };
  }
  private password(r: AccountRow): string { return decryptBlob(Buffer.from(r.secret), r.key_id).toString('utf8'); }
  private setStatus(id: string, status: CalendarAccount['status'], message: string | null): void {
    this.sql.exec('UPDATE accounts SET status = ?, status_message = ? WHERE id = ? AND (status != ? OR status_message IS NOT ?)', status, message, id, status, message);
  }
  private me(r: AccountRow): Set<string> { return new Set([r.email.toLowerCase(), ...this.serverOf(r).addresses]); }

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
    const calendars = await d.calendars(found.home);
    return { found, calendars };
  }

  /** The account's calendars as the server lists them now: new ones added, gone ones forgotten, names and roles updated. */
  private applyCalendars(accountId: string, remote: RemoteCalendar[]): void {
    const now = Date.now();
    const local = this.store.calendarsOf(accountId);
    const byHref = new Map(local.map((c) => [c.href, c]));
    let position = Math.max(0, ...this.store.calendars().map((c) => c.position + 1));
    for (const r of remote) {
      const have = byHref.get(r.href);
      if (have) {
        this.sql.exec('UPDATE calendars SET name = ?, server_color = ?, timezone = ?, role = ? WHERE id = ?', r.name, r.color, r.timezone, r.role, have.id);
        this.sql.exec('UPDATE calendars SET supports_sync = ? WHERE id = ? AND supports_sync != ?', r.supportsSync ? 1 : 0, have.id, r.supportsSync ? 1 : 0);
        byHref.delete(r.href);
      } else {
        this.sql.exec('INSERT INTO calendars (id, account_id, href, name, server_color, color, timezone, role, supports_sync, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
          crypto.randomUUID(), accountId, r.href, r.name, r.color, r.color ? null : PALETTE[position % PALETTE.length], r.timezone, r.role, r.supportsSync ? 1 : 0, position++, now);
      }
    }
    for (const gone of byHref.values()) this.store.forgetCalendar(gone.id);
    this.sql.exec('UPDATE accounts SET calendars_at = ? WHERE id = ?', now, accountId);
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
      const d = this.driverOf(acct);
      const started = Date.now();
      let mode = 'delta', changed = 0, deleted = 0, error: string | null = null;
      const opts = { me: this.me(acct), zone: c.timezone ?? 'UTC' };
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
  async connectGoogle(g: GoogleGrant): Promise<{ id: string }> {
    const email = g.email.toLowerCase();
    const url = googlePrincipal(email);
    const existing = this.accountRows().find((a) => a.kind === 'google' && a.email.toLowerCase() === email);
    const id = existing?.id ?? crypto.randomUUID();
    this.access.set(id, { token: g.accessToken, exp: g.expiresAt });
    const sealed = encryptBlob(Buffer.from(g.refreshToken, 'utf8'));
    const pending: AccountRow = { id, kind: 'google', email, display_name: g.displayName || email.split('@')[0], server: JSON.stringify({ url, username: email, principal: url, home: '', addresses: [], outbox: null }), secret: new Uint8Array(sealed.blob).buffer, key_id: sealed.encKeyId, status: 'ok', status_message: null, created_at: Date.now(), calendars_at: 0 };
    const d = this.driver(url, this.credentialOf(pending));
    const found = await d.discover();
    const calendars = await d.calendars(found.home);
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
      this.applyCalendars(r.id, await this.driverOf(r).calendars(s.home));
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
      for (const a of accounts.values()) if (a.status !== 'auth_failed' && (force || Date.now() - a.calendars_at > RELIST_MS)) await this.relist(a);
      const every = cadenceMs(this.lastActiveAt(), Date.now()) ?? RELIST_MS;
      for (const c of this.store.due(force ? Number.MAX_SAFE_INTEGER : Date.now() - every + 5_000)) {
        if (Date.now() > deadline) break;
        const a = accounts.get(c.account_id);
        if (!a || this.account(a.id).status === 'auth_failed') continue;
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
    const has = this.accountRows().length > 0;
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

  // ---- events ---------------------------------------------------------------------------------------------------

  private writeContext(acct: AccountRow, c: CalendarRow, zone?: string | null): WriteContext {
    const s = this.serverOf(acct);
    const organizer = s.addresses.find((a) => a === acct.email.toLowerCase()) ?? acct.email.toLowerCase();
    return { me: [...this.me(acct)], organizer, displayName: acct.display_name, zone: zone || c.timezone || 'UTC', now: Date.now() };
  }

  /** Writes an object to the server and then to the cache: the etag the PUT answered with, else the object as stored there. */
  private async putAndStore(d: Driver, acct: AccountRow, c: CalendarRow, href: string, raw: string, etag: string | null): Promise<void> {
    const put = await d.put(href, raw, etag);
    const opts = { me: this.me(acct), zone: c.timezone ?? 'UTC' };
    if (put.etag) { this.store.putObject(c.id, href, put.etag, raw, opts); return; }
    const [stored] = await d.get(c.href, [href]);
    if (stored) this.store.putObject(c.id, stored.href, stored.etag, stored.data, opts);
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
    const shown = this.store.calendars().filter((c) => !c.hidden).map((c) => c.id);
    const busy = this.store.list(shown, from, to).filter((o) => !o.transparent && o.status !== 'cancelled' && o.myResponse !== 'declined')
      .map((o) => [Math.max(from, Date.parse(o.start)), Math.min(to, Date.parse(o.end))] as [number, number]).filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];
    for (const [a, b] of busy) {
      const last = merged.at(-1);
      if (last && a <= last[1]) last[1] = Math.max(last[1], b);
      else merged.push([a, b]);
    }
    return merged.map(([a, b]) => [new Date(a).toISOString(), new Date(b).toISOString()]);
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

    app.delete('/v1/calendar/accounts/:id', (c) => {
      const r = this.account(c.req.param('id'));
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

    app.get('/v1/calendar/events', (c) => {
      const { from, to } = this.window(c);
      const asked = c.req.query('calendars')?.split(',').map((s) => s.trim()).filter(Boolean);
      const cals = this.store.calendars();
      const ids = asked ? cals.filter((x) => asked.includes(x.id)).map((x) => x.id) : cals.filter((x) => !x.hidden).map((x) => x.id);
      const limit = Math.min(2000, Math.max(1, Number(c.req.query('limit')) || 2000));
      return c.json({ events: this.store.list(ids, from, to, c.req.query('q'), limit) });
    });

    app.get('/v1/calendar/events/:id', (c) => {
      const { calendarId, uid, rid } = splitId(c.req.param('id'));
      const ridMs = rid === null ? null : parseRid(rid);
      if (rid !== null && ridMs === null) throw badRequest('id: not an event id');
      const found = this.store.find(calendarId, uid, ridMs);
      const obj = this.store.objectByUid(calendarId, uid);
      if (!found || !obj) throw notFound('no such event');
      return c.json({ event: found.event, ...(found.master ? { master: found.master } : {}), raw: obj.raw });
    });

    app.post('/v1/calendar/events', async (c) => {
      const b = parse(EventInput, await json(c));
      const cal = this.writable(b.calendarId ? this.calendar(b.calendarId) : this.store.calendars().find((x) => x.is_default) ?? (() => { throw badRequest('connect a calendar first'); })());
      const acct = this.account(cal.account_id);
      const uid = crypto.randomUUID();
      const raw = newEvent(uid, b as Fields & { summary: string; start: string; end: string }, this.writeContext(acct, cal, b.timezone));
      const href = new URL(`${encodeURIComponent(uid)}.ics`, cal.href.endsWith('/') ? cal.href : `${cal.href}/`).href;
      const d = this.driverOf(acct);
      await this.locked(cal.id, () => this.putAndStore(d, acct, cal, href, raw, null));
      this.syncSoon(cal.id);
      return c.json({ event: this.view(cal.id, uid, 0) }, 201);
    });

    app.patch('/v1/calendar/events/:id', async (c) => {
      const t = this.target(c.req.param('id'));
      const b = parse(EventPatch, await json(c));
      const { scope: asked, etag, calendarId: moveTo, conference: _conference, ...fields } = b;
      const cal = this.writable(t.c);
      if (etag && etag !== t.obj.etag) throw conflict();
      const scope: Scope = asked ?? (t.rid ? 'this' : 'all');
      const ctx = this.writeContext(t.acct, cal, fields.timezone);
      const d = this.driverOf(t.acct);
      if (moveTo && moveTo !== cal.id) {
        // To another calendar: the whole event, written there first and then deleted here.
        if (t.rid && scope !== 'all') throw badRequest('calendarId: an occurrence moves with its whole series (scope all)');
        const dest = this.writable(this.calendar(moveTo));
        const destAcct = this.account(dest.account_id);
        const edited = editEvent(t.obj.raw, t.uid, t.rid, 'all', fields as Fields, ctx, () => crypto.randomUUID()).raw;
        const href = new URL(`${encodeURIComponent(t.uid)}.ics`, dest.href.endsWith('/') ? dest.href : `${dest.href}/`).href;
        const destDriver = dest.account_id === t.acct.id ? d : this.driverOf(destAcct);
        await this.locked(dest.id, () => this.putAndStore(destDriver, destAcct, dest, href, edited, null));
        await this.locked(cal.id, async () => { await d.delete(t.obj.href, t.obj.etag); this.store.deleteObject(cal.id, t.obj.href); }).catch((err) => this.conflicted(cal, err));
        this.syncSoon(dest.id);
        this.syncSoon(cal.id);
        return c.json({ event: this.view(dest.id, t.uid, 0) });
      }
      const out = editEvent(t.obj.raw, t.uid, t.rid, scope, fields as Fields, ctx, () => crypto.randomUUID());
      await this.locked(cal.id, async () => {
        if (out.created) {
          const href = new URL(`${encodeURIComponent(out.created.uid)}.ics`, cal.href.endsWith('/') ? cal.href : `${cal.href}/`).href;
          await this.putAndStore(d, t.acct, cal, href, out.created.raw, null);
          try {
            await this.putAndStore(d, t.acct, cal, t.obj.href, out.raw, t.obj.etag);
          } catch (err) {
            // The old series could not be ended: take the new one back, so nothing shows twice.
            await d.delete(href, null).catch(() => {});
            this.store.deleteObject(cal.id, href);
            throw err;
          }
        } else await this.putAndStore(d, t.acct, cal, t.obj.href, out.raw, t.obj.etag);
      }).catch((err) => this.conflicted(cal, err));
      this.syncSoon(cal.id);
      return c.json({ event: out.created ? this.view(cal.id, out.created.uid, 0) : this.view(cal.id, t.uid, scope === 'this' ? t.rid : 0) });
    });

    app.delete('/v1/calendar/events/:id', async (c) => {
      const t = this.target(c.req.param('id'));
      const cal = this.writable(t.c);
      const asked = c.req.query('scope');
      if (asked && !['this', 'following', 'all'].includes(asked)) throw badRequest('scope: this, following or all');
      const scope = (asked as Scope | undefined) ?? (t.rid ? 'this' : 'all');
      const raw = deleteFromEvent(t.obj.raw, t.uid, t.rid, scope, this.writeContext(t.acct, cal));
      const d = this.driverOf(t.acct);
      await this.locked(cal.id, async () => {
        if (raw === null) { await d.delete(t.obj.href, t.obj.etag); this.store.deleteObject(cal.id, t.obj.href); }
        else await this.putAndStore(d, t.acct, cal, t.obj.href, raw, t.obj.etag);
      }).catch((err) => this.conflicted(cal, err));
      this.syncSoon(cal.id);
      return c.json({ ok: true });
    });

    app.post('/v1/calendar/events/:id/respond', async (c) => {
      const t = this.target(c.req.param('id'));
      const b = parse(RespondBody, await json(c));
      const raw = respondTo(t.obj.raw, t.uid, t.rid, b.response, b.comment, this.writeContext(t.acct, t.c));
      const d = this.driverOf(t.acct);
      await this.locked(t.c.id, () => this.putAndStore(d, t.acct, t.c, t.obj.href, raw, t.obj.etag)).catch((err) => this.conflicted(t.c, err));
      this.syncSoon(t.c.id);
      return c.json({ event: this.view(t.c.id, t.uid, t.rid) });
    });

    app.post('/v1/calendar/freebusy', async (c) => {
      const b = parse(FreeBusyBody, await json(c));
      const from = parseInstant(b.from, null), to = parseInstant(b.to, null);
      if (to <= from || to - from > MAX_WINDOW_MS) throw badRequest('from and to: a window of at most 3 months');
      const accounts = this.accountRows();
      const mine = new Set(accounts.flatMap((a) => [...this.me(a)]));
      const emails = [...new Set(b.emails.map((e) => e.toLowerCase()))];
      const busy: { email: string; intervals: Interval[] }[] = [];
      const unknown: string[] = [];
      const own = this.ownBusy(from, to);
      for (const e of emails) if (mine.has(e)) busy.push({ email: e, intervals: own });
      const others = emails.filter((e) => !mine.has(e));
      if (!emails.length) busy.push({ email: accounts[0]?.email.toLowerCase() ?? 'me', intervals: own });
      let answered = new Map<string, Interval[]>();
      const withOutbox = accounts.find((a) => a.status === 'ok' && this.serverOf(a).outbox);
      if (others.length && withOutbox) {
        const s = this.serverOf(withOutbox);
        answered = (await this.driverOf(withOutbox).freebusy({ principal: s.principal, home: s.home, addresses: s.addresses, outbox: s.outbox }, withOutbox.email, others, from, to).catch(() => null)) ?? new Map();
      }
      for (const e of others) {
        const got = answered.get(e);
        if (got) busy.push({ email: e, intervals: got });
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

