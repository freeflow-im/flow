// The Calendar object's SQLite (docs/specs/calendar.md §3): the accounts, their calendars, every calendar object resource
// as the server stores it (`objects`: href, etag, iCalendar), and one row per VEVENT of each (`events`: the master or
// plain event and each exception) with the columns a window is listed by. The cache is complete, not a window: a list is
// read from here and a recurring master expanded here (ical.ts), never fetched. Every list and sync query is written so
// `EXPLAIN QUERY PLAN` shows it on an index (store.test.ts, on a production-sized table): the 2026-11-04 Mail outage was a
// GROUP BY over an unindexed join. Written against the small `Sql` interface so the tests run it on node:sqlite.
import type { Sql } from '../imap/cache';
import { LONG_MS, expand, isoOf, parseObject, ridText, type EventData, type ParsedEvent, type Rules } from './ical';
import type { RemoteCalendar } from './drivers/caldav';
import { eventIdOf, occurrenceIdOf } from './rules';

export type { Sql };

export const DDL = [
  `CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, kind TEXT NOT NULL DEFAULT 'caldav', email TEXT NOT NULL, display_name TEXT NOT NULL, server TEXT NOT NULL,
    secret BLOB NOT NULL, key_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ok', status_message TEXT, created_at INTEGER NOT NULL, calendars_at INTEGER NOT NULL DEFAULT 0)`,
  // A calendar of an account: `color` is the person's own choice (never written to the server), `server_color` the server's.
  `CREATE TABLE IF NOT EXISTS calendars (id TEXT PRIMARY KEY, account_id TEXT NOT NULL, href TEXT NOT NULL, name TEXT NOT NULL, server_color TEXT, color TEXT, timezone TEXT,
    role TEXT NOT NULL DEFAULT 'owner', hidden INTEGER NOT NULL DEFAULT 0, is_default INTEGER NOT NULL DEFAULT 0, sync_token TEXT, ctag TEXT,
    supports_sync INTEGER NOT NULL DEFAULT 0, last_synced INTEGER NOT NULL DEFAULT 0, position INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL)`,
  `CREATE INDEX IF NOT EXISTS calendars_account ON calendars (account_id)`,
  `CREATE TABLE IF NOT EXISTS objects (calendar_id TEXT NOT NULL, href TEXT NOT NULL, uid TEXT NOT NULL, etag TEXT NOT NULL, raw TEXT NOT NULL, PRIMARY KEY (calendar_id, href))`,
  `CREATE INDEX IF NOT EXISTS objects_uid ON objects (calendar_id, uid)`,
  `CREATE INDEX IF NOT EXISTS objects_etag ON objects (calendar_id, href, etag)`,
  // One row per VEVENT. kind: 0 a single event (or exception) up to LONG_MS, 2 a longer one, 1 a recurring master.
  // rid: an exception's RECURRENCE-ID instant, else 0. recur_until: when a master's last occurrence ends (ical.ts FOREVER
  // for none), a single event's end. data: what the API shows (EventData, JSON); rules: a master's (Rules, JSON).
  `CREATE TABLE IF NOT EXISTS events (id TEXT PRIMARY KEY, calendar_id TEXT NOT NULL, uid TEXT NOT NULL, href TEXT NOT NULL, etag TEXT NOT NULL, rid INTEGER NOT NULL DEFAULT 0,
    kind INTEGER NOT NULL, start_utc INTEGER NOT NULL, end_utc INTEGER NOT NULL, recur_until INTEGER NOT NULL, status TEXT NOT NULL, search TEXT NOT NULL, data TEXT NOT NULL, rules TEXT)`,
  `CREATE INDEX IF NOT EXISTS events_window ON events (calendar_id, kind, start_utc)`,
  `CREATE INDEX IF NOT EXISTS events_series ON events (calendar_id, kind, recur_until)`,
  `CREATE INDEX IF NOT EXISTS events_rid ON events (calendar_id, rid) WHERE rid > 0`,
  `CREATE INDEX IF NOT EXISTS events_uid ON events (calendar_id, uid)`,
  `CREATE INDEX IF NOT EXISTS events_href ON events (calendar_id, href)`,
  // What each sync did (the e2e and GET …/debug/sync read it); the newest SYNC_RUNS_KEEP are kept.
  `CREATE TABLE IF NOT EXISTS sync_runs (id INTEGER PRIMARY KEY AUTOINCREMENT, calendar_id TEXT NOT NULL, at INTEGER NOT NULL, ms INTEGER NOT NULL, mode TEXT NOT NULL,
    changed INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0, error TEXT)`,
  `CREATE TABLE IF NOT EXISTS rate_limit_windows (key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL DEFAULT 1)`,
  `CREATE TABLE IF NOT EXISTS calendar_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
];
const SYNC_RUNS_KEEP = 200;
/**
 * Columns added after the first release, each added once (ALTER fails when it is already there), with what runs once after.
 * owner_address (2026-11-04): a shared calendar's owner, who is "me" on it; `reparse` marks a calendar whose stored objects
 * must be read again (the rows' `self` and `myResponse` depend on who "me" is), done before its next sync, and the accounts'
 * calendar lists are read again at the next alarm run, which fills owner_address in.
 */
const ADDED_COLUMNS: { add: string; then?: string }[] = [
  { add: 'ALTER TABLE calendars ADD COLUMN owner_address TEXT' },
  { add: 'ALTER TABLE calendars ADD COLUMN reparse INTEGER NOT NULL DEFAULT 1', then: 'UPDATE accounts SET calendars_at = 0' },
];

export interface CalendarRow {
  id: string; account_id: string; href: string; name: string; server_color: string | null; color: string | null; timezone: string | null;
  role: string; hidden: number; is_default: number; sync_token: string | null; ctag: string | null; supports_sync: number; last_synced: number; position: number; created_at: number;
  owner_address: string | null; reparse: number;
}
export interface ObjectRow { calendar_id: string; href: string; uid: string; etag: string; raw: string }
interface EventRow { id: string; calendar_id: string; uid: string; rid: number; etag: string; start_utc: number; end_utc: number; status: string; data: string; rules: string | null }
export interface SyncRun { calendarId: string; at: string; ms: number; mode: string; changed: number; deleted: number; error: string | null }

/** What the views show: one per occurrence (docs/specs/calendar.md §4). */
export interface EventOccurrence extends Omit<EventData, 'reminders' | 'sequence' | 'recurrence' | 'transparent'> {
  id: string; eventId: string; calendarId: string; start: string; end: string; recurring: boolean; recurrenceId?: string; etag: string;
  reminders: number[]; recurrence?: string[]; transparent?: true;
}

/**
 * The window queries, as SQL (the query-plan test runs these very strings). `like` adds the search filter. Each names its
 * index (INDEXED BY): with statistics (ANALYZE, or a calendar that is half the table) the planner would otherwise take a
 * scan of every event for the long events' or the series' part, which is the kind of plan behind the 2026-11-04 outage.
 */
const COLS = 'id, calendar_id, uid, rid, etag, start_utc, end_utc, status, data, rules';
const IN_CALENDARS = 'calendar_id IN (SELECT value FROM json_each(?))';
export const singlesSql = (like: boolean) =>
  `SELECT ${COLS} FROM events INDEXED BY events_window WHERE ${IN_CALENDARS} AND kind = 0 AND start_utc >= ? AND start_utc < ? AND end_utc > ?${like ? ' AND search LIKE ?' : ''}
   UNION ALL SELECT ${COLS} FROM events INDEXED BY events_window WHERE ${IN_CALENDARS} AND kind = 2 AND start_utc < ? AND end_utc > ?${like ? ' AND search LIKE ?' : ''}`;
export const seriesSql = (like: boolean) => `SELECT ${COLS} FROM events INDEXED BY events_series WHERE ${IN_CALENDARS} AND kind = 1 AND recur_until > ? AND start_utc < ?${like ? ' AND search LIKE ?' : ''}`;
/** The exceptions whose original occurrence falls in a window: they replace those occurrences of their masters. */
export const exceptionsSql = `SELECT calendar_id, uid, rid FROM events INDEXED BY events_rid WHERE ${IN_CALENDARS} AND rid > 0 AND rid >= ? AND rid < ?`;
export const objectsSql = 'SELECT href, etag, raw FROM objects INDEXED BY sqlite_autoindex_objects_1 WHERE calendar_id = ?';
export const etagsSql = 'SELECT href, etag FROM objects INDEXED BY objects_etag WHERE calendar_id = ?';
export const objectByUidSql = 'SELECT calendar_id, href, uid, etag, raw FROM objects INDEXED BY objects_uid WHERE calendar_id = ? AND uid = ?';
export const eventsOfUidSql = `SELECT ${COLS} FROM events INDEXED BY events_uid WHERE calendar_id = ? AND uid = ?`;
export const deleteEventsSql = 'DELETE FROM events INDEXED BY events_href WHERE calendar_id = ? AND href = ?';
export const dueSql = 'SELECT * FROM calendars WHERE last_synced < ? ORDER BY supports_sync DESC, last_synced';

const likeOf = (q: string) => `%${q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
const escapeLike = (sql: string) => sql.replaceAll('search LIKE ?', "search LIKE ? ESCAPE '\\'");

function toOccurrence(r: EventRow, start: number, end: number, rid: number | null): EventOccurrence {
  const d = JSON.parse(r.data) as EventData;
  const eventId = eventIdOf(r.calendar_id, r.uid);
  const recurring = !!r.rules || r.rid > 0;
  const recurrenceId = rid !== null ? ridText(rid, d.allDay) : undefined;
  const { reminders, recurrence, sequence: _sequence, transparent, ...shown } = d;
  return {
    ...shown, id: recurrenceId ? occurrenceIdOf(r.calendar_id, r.uid, recurrenceId) : eventId, eventId, calendarId: r.calendar_id,
    start: isoOf(start, d.allDay), end: isoOf(end, d.allDay), recurring, ...(recurrenceId ? { recurrenceId } : {}), etag: r.etag,
    reminders: reminders ?? [], ...(recurrence?.length ? { recurrence } : {}), ...(transparent ? { transparent } : {}),
  };
}

export class CalendarStore {
  constructor(private readonly sql: Sql) {}

  init(): void {
    for (const s of DDL) this.sql.exec(s);
    for (const { add, then } of ADDED_COLUMNS) {
      try { this.sql.exec(add); } catch { continue; /* already added */ }
      if (then) this.sql.exec(then);
    }
  }

  // ---- calendars ----------------------------------------------------------------------------------------------

  calendars(): CalendarRow[] {
    return this.sql.exec<CalendarRow & Record<string, SqlStorageValue>>('SELECT * FROM calendars ORDER BY position, created_at').toArray();
  }
  calendar(id: string): CalendarRow | null {
    return this.sql.exec<CalendarRow & Record<string, SqlStorageValue>>('SELECT * FROM calendars WHERE id = ?', id).toArray()[0] ?? null;
  }
  calendarsOf(accountId: string): CalendarRow[] {
    return this.sql.exec<CalendarRow & Record<string, SqlStorageValue>>('SELECT * FROM calendars WHERE account_id = ? ORDER BY position', accountId).toArray();
  }
  /** Calendars whose last sync is older than `before`, servers with sync-collection first (cheap deltas), longest waiting first. */
  due(before: number): CalendarRow[] {
    return this.sql.exec<CalendarRow & Record<string, SqlStorageValue>>(dueSql, before).toArray();
  }

  /** Drops a calendar and everything cached of it. */
  forgetCalendar(id: string): void {
    this.sql.exec('DELETE FROM events WHERE calendar_id = ?', id);
    this.sql.exec('DELETE FROM objects WHERE calendar_id = ?', id);
    this.sql.exec('DELETE FROM sync_runs WHERE calendar_id = ?', id);
    this.sql.exec('DELETE FROM calendars WHERE id = ?', id);
  }

  /**
   * An account's calendars as the server lists them now: new ones added (a palette colour where the server gives none), gone
   * ones forgotten with their events, names, colours, zones, roles and owner addresses updated (a changed owner address marks
   * the calendar for reparsing), and when the list was read. The caller picks the default calendar again.
   */
  applyCalendars(accountId: string, remote: RemoteCalendar[], palette: string[]): void {
    const now = Date.now();
    const local = this.calendarsOf(accountId);
    const byHref = new Map(local.map((c) => [c.href, c]));
    let position = Math.max(0, ...this.calendars().map((c) => c.position + 1));
    for (const r of remote) {
      const have = byHref.get(r.href);
      if (have) {
        this.sql.exec('UPDATE calendars SET name = ?, server_color = ?, timezone = ?, role = ? WHERE id = ?', r.name, r.color, r.timezone, r.role, have.id);
        // A new owner address changes who "me" is on the calendar: its events are read again before the next sync.
        this.sql.exec('UPDATE calendars SET owner_address = ?, reparse = 1 WHERE id = ? AND owner_address IS NOT ?', r.ownerAddress, have.id, r.ownerAddress);
        this.sql.exec('UPDATE calendars SET supports_sync = ? WHERE id = ? AND supports_sync != ?', r.supportsSync ? 1 : 0, have.id, r.supportsSync ? 1 : 0);
        byHref.delete(r.href);
      } else {
        this.sql.exec('INSERT INTO calendars (id, account_id, href, name, server_color, color, timezone, role, supports_sync, position, created_at, owner_address, reparse) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)',
          crypto.randomUUID(), accountId, r.href, r.name, r.color, r.color ? null : palette[position % palette.length], r.timezone, r.role, r.supportsSync ? 1 : 0, position++, now, r.ownerAddress);
      }
    }
    for (const gone of byHref.values()) this.forgetCalendar(gone.id);
    this.sql.exec('UPDATE accounts SET calendars_at = ? WHERE id = ?', now, accountId);
  }

  /** Keeps exactly one default calendar: the one asked for, else the one there is, else the person's own first, else any writable one. */
  ensureDefault(preferred?: string): void {
    const cals = this.calendars();
    // One's own before one shared with one (a writer), shown before hidden.
    const pick = (preferred && cals.find((c) => c.id === preferred && c.role !== 'reader')) || cals.find((c) => c.is_default && c.role !== 'reader') || cals.find((c) => c.role === 'owner' && !c.hidden) || cals.find((c) => c.role !== 'reader' && !c.hidden) || cals.find((c) => c.role !== 'reader');
    for (const c of cals) {
      const want = pick && c.id === pick.id ? 1 : 0;
      if (c.is_default !== want) this.sql.exec('UPDATE calendars SET is_default = ? WHERE id = ?', want, c.id);
    }
  }

  // ---- objects ------------------------------------------------------------------------------------------------

  etags(calendarId: string): Map<string, string> {
    return new Map(this.sql.exec<{ href: string; etag: string }>(etagsSql, calendarId).toArray().map((r) => [r.href, r.etag]));
  }
  objectByUid(calendarId: string, uid: string): ObjectRow | null {
    return this.sql.exec<ObjectRow & Record<string, SqlStorageValue>>(objectByUidSql, calendarId, uid).toArray()[0] ?? null;
  }
  objectCount(calendarId: string): number {
    return this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM objects WHERE calendar_id = ?', calendarId).toArray()[0]?.n ?? 0;
  }

  /** Stores an object as the server has it, and its VEVENTs as rows (read with the account's addresses and the calendar's zone). */
  putObject(calendarId: string, href: string, etag: string, raw: string, opts: { me: Set<string>; zone: string }): ParsedEvent[] {
    const parsed = parseObject(raw, opts);
    this.sql.exec(deleteEventsSql, calendarId, href);
    if (!parsed.length) { this.sql.exec('DELETE FROM objects WHERE calendar_id = ? AND href = ?', calendarId, href); return parsed; }
    // A UID once stored under another href (a server that renamed it) is the same event: the older copy goes.
    const uid = parsed[0].uid;
    const other = this.objectByUid(calendarId, uid);
    if (other && other.href !== href) this.deleteObject(calendarId, other.href);
    this.sql.exec('INSERT OR REPLACE INTO objects (calendar_id, href, uid, etag, raw) VALUES (?, ?, ?, ?, ?)', calendarId, href, uid, etag, raw);
    for (const e of parsed) {
      const id = e.rid ? occurrenceIdOf(calendarId, e.uid, ridText(e.rid, e.data.allDay)) : eventIdOf(calendarId, e.uid);
      this.sql.exec(`INSERT OR REPLACE INTO events (id, calendar_id, uid, href, etag, rid, kind, start_utc, end_utc, recur_until, status, search, data, rules)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, calendarId, e.uid, href, etag, e.rid, e.kind, e.startUtc, e.endUtc, e.recurUntil, e.data.status, e.search,
        JSON.stringify(e.data), e.rules ? JSON.stringify(e.rules) : null);
    }
    return parsed;
  }
  /** Reads every stored object of a calendar again (who "me" is changed), with no round trip; clears its `reparse` mark. */
  reparse(calendarId: string, opts: { me: Set<string>; zone: string }): number {
    const rows = this.sql.exec<{ href: string; etag: string; raw: string }>(objectsSql, calendarId).toArray();
    for (const o of rows) this.putObject(calendarId, o.href, o.etag, o.raw, opts);
    this.sql.exec('UPDATE calendars SET reparse = 0 WHERE id = ?', calendarId);
    return rows.length;
  }
  deleteObject(calendarId: string, href: string): void {
    this.sql.exec(deleteEventsSql, calendarId, href);
    this.sql.exec('DELETE FROM objects WHERE calendar_id = ? AND href = ?', calendarId, href);
  }

  // ---- reading ------------------------------------------------------------------------------------------------

  /**
   * Every occurrence in [from, to) of the calendars named, oldest first: single events and exceptions by their own times,
   * and each recurring master that is still going expanded over the window, less the occurrences its exceptions replace.
   * A cancelled exception hides its occurrence and shows nothing. `q` keeps those whose text matches (summary, location,
   * description, attendees). At most `limit`.
   */
  list(calendarIds: string[], from: number, to: number, q?: string, limit = 2000): EventOccurrence[] {
    if (!calendarIds.length || to <= from) return [];
    const ids = JSON.stringify(calendarIds);
    const like = q?.trim() ? likeOf(q.trim()) : null;
    const extra = like ? [like] : [];
    const out: EventOccurrence[] = [];
    const singles = this.sql.exec<EventRow & Record<string, SqlStorageValue>>(escapeLike(singlesSql(!!like)), ids, from - LONG_MS, to, from, ...extra, ids, to, from, ...extra).toArray();
    for (const r of singles) {
      if (r.rid > 0 && r.status === 'cancelled') continue;
      out.push(toOccurrence(r, r.start_utc, r.end_utc, r.rid > 0 ? r.rid : null));
    }
    const masters = this.sql.exec<EventRow & Record<string, SqlStorageValue>>(escapeLike(seriesSql(!!like)), ids, from, to, ...extra).toArray();
    if (masters.length) {
      const longest = Math.max(...masters.map((m) => (JSON.parse(m.rules!) as Rules).durationMs));
      const replaced = new Set(this.sql.exec<{ calendar_id: string; uid: string; rid: number }>(exceptionsSql, ids, from - longest - 1, to).toArray().map((e) => `${e.calendar_id}\u0000${e.uid}\u0000${e.rid}`));
      for (const m of masters) {
        const rules = JSON.parse(m.rules!) as Rules;
        for (const s of expand(rules, from, to)) {
          if (replaced.has(`${m.calendar_id}\u0000${m.uid}\u0000${s}`)) continue;
          out.push(toOccurrence(m, s, s + rules.durationMs, s));
        }
      }
    }
    out.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.end < b.end ? -1 : 1));
    return out.slice(0, limit);
  }

  /** An event or one occurrence by its id's parts: the row (exception or master), and the master's view of the series. */
  find(calendarId: string, uid: string, rid: number | null): { event: EventOccurrence; master: EventOccurrence | null } | null {
    const rows = this.sql.exec<EventRow & Record<string, SqlStorageValue>>(eventsOfUidSql, calendarId, uid).toArray();
    if (!rows.length) return null;
    const master = rows.find((r) => r.rid === 0) ?? null;
    const masterView = master ? toOccurrence(master, master.start_utc, master.end_utc, null) : null;
    if (rid === null) return masterView ? { event: masterView, master: null } : { event: toOccurrence(rows[0], rows[0].start_utc, rows[0].end_utc, rows[0].rid || null), master: null };
    const ex = rows.find((r) => r.rid === rid);
    if (ex) return { event: toOccurrence(ex, ex.start_utc, ex.end_utc, rid), master: masterView };
    if (!master?.rules) return null;
    const rules = JSON.parse(master.rules) as Rules;
    if (!expand(rules, rid, rid + 1).includes(rid)) return null;
    return { event: toOccurrence(master, rid, rid + rules.durationMs, rid), master: masterView };
  }

  // ---- sync runs ----------------------------------------------------------------------------------------------

  logSync(run: Omit<SyncRun, 'at'> & { at: number }): void {
    this.sql.exec('INSERT INTO sync_runs (calendar_id, at, ms, mode, changed, deleted, error) VALUES (?, ?, ?, ?, ?, ?, ?)', run.calendarId, run.at, run.ms, run.mode, run.changed, run.deleted, run.error);
    this.sql.exec('DELETE FROM sync_runs WHERE id <= (SELECT id FROM sync_runs ORDER BY id DESC LIMIT 1 OFFSET ?)', SYNC_RUNS_KEEP);
  }
  syncRuns(limit = 50): SyncRun[] {
    return this.sql.exec<{ calendar_id: string; at: number; ms: number; mode: string; changed: number; deleted: number; error: string | null }>(
      'SELECT calendar_id, at, ms, mode, changed, deleted, error FROM sync_runs ORDER BY id DESC LIMIT ?', limit).toArray()
      .map((r) => ({ calendarId: r.calendar_id, at: new Date(r.at).toISOString(), ms: r.ms, mode: r.mode, changed: r.changed, deleted: r.deleted, error: r.error }));
  }

  state(key: string): string | null {
    return this.sql.exec<{ value: string }>('SELECT value FROM calendar_state WHERE key = ?', key).toArray()[0]?.value ?? null;
  }
  setState(key: string, value: string): void {
    this.sql.exec('INSERT OR REPLACE INTO calendar_state (key, value) VALUES (?, ?)', key, value);
  }
}
