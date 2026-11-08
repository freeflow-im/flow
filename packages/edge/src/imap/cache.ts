// The prefetch cache of FreeFlow Mail (docs/specs/mail-api.md, "The prefetch cache"): the newest messages of each
// account's main folders, kept in the Mail object's SQLite so a folder's list is read from it rather than fetched from the
// server each time, and kept fresh by the object's alarm. This file is the cache's tables and the pure rules around them
// (what to fetch, when the alarm runs, which flags changed); object.ts does the IMAP and decides when. The SQL is written
// against the small `Sql` interface so cache.test.ts can run it on node:sqlite.
import type { FetchMessageObject } from 'imapflow';
import type { BodyPlan } from './body';
import { parseHeaders } from './categorize';
import type { MessageDetail, MessageSummary } from './convert';
import { assignThread, bareId, dedupeKey, idsIn, normalizeSubject, type Known, type ThreadStore } from './threads';

/** What this file needs of the object's SqlStorage (and node:sqlite in tests, through the adapter in cache.test.ts). */
export interface Sql {
  exec<T extends Record<string, SqlStorageValue>>(query: string, ...bindings: unknown[]): { toArray(): T[] };
}

/** Messages kept per folder: the newest this many. */
export const CACHE_ROWS = 1000;
/** New mail taken in per sync of a folder at most (above the high-water mark); more than that and the backfill fills in below. */
export const NEW_CAP = 200;
/** Older messages added per backfill step. */
export const BACKFILL_STEP = 100;
/** How long one alarm run may spend talking to the servers; what is left waits for the next. */
export const ALARM_BUDGET_MS = 20_000;
/** A person is "active" this long after their last request: the alarm then runs every ACTIVE_CADENCE_MS. */
export const ACTIVE_MS = 3 * 60_000;
export const ACTIVE_CADENCE_MS = 30_000;
/** Idle under an hour: every 5 minutes; under a day: every 30; then the alarm stops until the next request. */
export const IDLE_CADENCES: { under: number; every: number }[] = [
  { under: 60 * 60_000, every: 5 * 60_000 },
  { under: 24 * 60 * 60_000, every: 30 * 60_000 },
];
/** A folder opened in the list stays cached this long after it was last looked at (the main folders always are). */
export const RECENT_MS = 7 * 24 * 60 * 60_000;
/** A folder whose sync failed is left alone this long. */
export const ERROR_BACKOFF_MS = 10 * 60_000;
/** A folder the alarm synced this recently is served as it stands: no new-mail, tab-sort or flags round trip for a page. */
export const FRESH_MS = 45_000;
/** A body larger than this is not kept (a SQLite value holds 2 MB at most); the message opens from the server. */
export const BODY_MAX_HTML = 1024 * 1024;
export const BODY_MAX_TEXT = 256 * 1024;
/** Bodies fetched per alarm run at most: this many messages, or this many encoded bytes. */
export const BODY_BATCH = 25;
export const BODY_BATCH_BYTES = 4 * 1024 * 1024;
/** Bodies kept per folder at most; past it the oldest go (their rows stay, to be opened from the server). */
export const BODY_BUDGET_PER_FOLDER = 150 * 1024 * 1024;

/** How a cached row's body stands. */
export const BODY = { pending: 0, cached: 1, tooLarge: 2, notByParts: 3, evicted: 4 } as const;

/** Why a folder is cached: one of the main folders by its special use, or one the person opened lately. */
export type FolderKind = 'inbox' | 'sent' | 'drafts' | 'archive' | 'all' | 'recent';
export const MAIN_KINDS: readonly FolderKind[] = ['inbox', 'sent', 'drafts', 'archive', 'all'];

export interface Flags { seen: boolean; flagged: boolean; answered: boolean; draft: boolean }
export const flagsOf = (set: Set<string> | undefined): Flags => ({
  seen: !!set?.has('\\Seen'), flagged: !!set?.has('\\Flagged'), answered: !!set?.has('\\Answered'), draft: !!set?.has('\\Draft'),
});

/** The state of one cached folder: every UID of the folder in [low, high] has a row (less what the server no longer has). */
export interface CachedFolder {
  accountId: string; folder: string; validity: string; high: number; low: number;
  /** The server's HIGHESTMODSEQ at the last flag refresh (CONDSTORE), else null. */
  modseq: string | null;
  kind: FolderKind; syncedAt: number; openedAt: number; error: string | null; errorAt: number;
}

/** A cached message as a list shows it, its flags as last known. */
export interface CachedMessage { summary: MessageSummary; threadId: string | null; emailId: string | null; flagsAt: number }

/** One message to cache, from a FETCH with CACHE_QUERY (the summary made of it, and the raw header block kept for later). */
export interface NewRow { m: FetchMessageObject; summary: MessageSummary; headers: string | null; plan: BodyPlan | null }
/** Someone written to (`sent` times) or heard from (`received`), as the composer completes addresses. */
export interface Contact { name: string; address: string; sent: number; received: number; lastAt: number }
/** A cached message with its body, as `GET …/messages/:uid` answers, and the plan its attachments are fetched by. */
export interface CachedBody { detail: MessageDetail; plan: BodyPlan | null; state: number }
/** A cached message of a thread, as threads are listed and read: its folder and ids, and its summary with the flags as last known. */
export interface ThreadRow { uid: number; folder: string; validity: string; threadId: string; messageId: string; emailId: string | null; date: number; draft: boolean; bodyState: number; key: string; summary: MessageSummary }
/** A message whose body the alarm is to fetch, with what it was cached with. */
export interface QueuedBody { uid: number; summary: MessageSummary; plan: BodyPlan; headers: string | null }
type BodyRow = { uid: number; folder: string; email_id: string | null; thread_id: string | null; seen: number; flagged: number; answered: number; detail: string | null; plan: string | null; html: string | null; text: string | null; body_state: number };
const byteLength = (s: string | null) => (s ? new TextEncoder().encode(s).length : 0);

export const DDL = [
  // One row per cached message per folder, its summary as JSON (the flags overlaid from the columns when read), the raw
  // header block and the body plan kept for opening it later, and the bodies (never read by a list).
  `CREATE TABLE IF NOT EXISTS mail_messages (account_id TEXT NOT NULL, folder TEXT NOT NULL, uid_validity TEXT NOT NULL, uid INTEGER NOT NULL,
    message_id TEXT NOT NULL DEFAULT '', email_id TEXT, thread_id TEXT, date INTEGER NOT NULL DEFAULT 0,
    seen INTEGER NOT NULL DEFAULT 0, flagged INTEGER NOT NULL DEFAULT 0, answered INTEGER NOT NULL DEFAULT 0, draft INTEGER NOT NULL DEFAULT 0,
    flags TEXT NOT NULL DEFAULT '[]', modseq TEXT, flags_at INTEGER NOT NULL DEFAULT 0, sender TEXT NOT NULL DEFAULT '', subject_norm TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL, detail TEXT, plan TEXT, headers TEXT, body_state INTEGER NOT NULL DEFAULT 0, body_bytes INTEGER NOT NULL DEFAULT 0, html TEXT, text TEXT,
    PRIMARY KEY (account_id, folder, uid_validity, uid))`,
  `CREATE INDEX IF NOT EXISTS mail_messages_thread ON mail_messages (account_id, thread_id, date)`,
  `CREATE INDEX IF NOT EXISTS mail_messages_message_id ON mail_messages (account_id, message_id)`,
  `CREATE INDEX IF NOT EXISTS mail_messages_email_id ON mail_messages (account_id, email_id)`,
  `CREATE INDEX IF NOT EXISTS mail_messages_bodies ON mail_messages (account_id, folder, uid DESC) WHERE body_state = 0`,
  // How far each cached folder reaches (CachedFolder).
  `CREATE TABLE IF NOT EXISTS mail_cache_folders (account_id TEXT NOT NULL, folder TEXT NOT NULL, uid_validity TEXT NOT NULL DEFAULT '', high INTEGER NOT NULL DEFAULT 0, low INTEGER NOT NULL DEFAULT 0,
    modseq TEXT, kind TEXT NOT NULL DEFAULT 'recent', synced_at INTEGER NOT NULL DEFAULT 0, opened_at INTEGER NOT NULL DEFAULT 0, error TEXT, error_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (account_id, folder))`,
  `CREATE TABLE IF NOT EXISTS mail_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  // Conversations (threads.ts): every id a cached message answers or references, to find who references a message that
  // arrives later; and the threads of messages that have left the cache (the window of CACHE_ROWS), so a late reply
  // still finds its thread.
  `CREATE INDEX IF NOT EXISTS mail_messages_subject ON mail_messages (account_id, subject_norm, date)`,
  `CREATE TABLE IF NOT EXISTS mail_refs (account_id TEXT NOT NULL, ref TEXT NOT NULL, folder TEXT NOT NULL, uid_validity TEXT NOT NULL, uid INTEGER NOT NULL,
    PRIMARY KEY (account_id, folder, uid_validity, uid, ref))`,
  `CREATE INDEX IF NOT EXISTS mail_refs_ref ON mail_refs (account_id, ref)`,
  `CREATE TABLE IF NOT EXISTS mail_thread_index (account_id TEXT NOT NULL, message_id TEXT NOT NULL, thread_id TEXT NOT NULL, date INTEGER NOT NULL, PRIMARY KEY (account_id, message_id))`,
  // The people written to and heard from, from the cached messages (Contacts below): what the composer completes addresses from.
  `CREATE TABLE IF NOT EXISTS mail_contacts (account_id TEXT NOT NULL, address TEXT NOT NULL, name TEXT NOT NULL DEFAULT '', sent INTEGER NOT NULL DEFAULT 0, received INTEGER NOT NULL DEFAULT 0,
    last_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (account_id, address))`,
];
/** Message ids remembered per account after their rows left the cache, at most. */
export const THREAD_INDEX_CAP = 20_000;

/**
 * How long until the alarm should run again, from when the person last made a request: every 30 s while active, then
 * less often, and not at all after a day idle (the next request starts it again). Null: no alarm.
 */
export function cadenceMs(lastActiveAt: number, now: number): number | null {
  const idle = Math.max(0, now - lastActiveAt);
  if (idle < ACTIVE_MS) return ACTIVE_CADENCE_MS;
  for (const c of IDLE_CADENCES) if (idle < c.under) return c.every;
  return null;
}

/** When the alarm should next run, or null for not at all (no accounts, or idle too long). */
export function nextAlarmAt(lastActiveAt: number, now: number, hasAccounts: boolean): number | null {
  if (!hasAccounts) return null;
  const every = cadenceMs(lastActiveAt, now);
  return every === null ? null : now + every;
}

/**
 * The flags that changed, and the messages gone, between the cached rows and a FLAGS fetch. `presence`: the fetch named
 * every cached UID (a full FLAGS fetch), so one it did not return has left the folder; a `changedSince` fetch returns only
 * what changed, so absence then means nothing. Rows written through after `since` (a flag the person just set here) keep
 * what they have: the fetch may have been answered before that STORE.
 */
export function flagDiff(cached: Map<number, Flags & { flagsAt: number }>, fetched: Map<number, Flags>, presence: boolean, since: number): { changed: (Flags & { uid: number })[]; vanished: number[] } {
  const changed: (Flags & { uid: number })[] = [];
  const vanished: number[] = [];
  for (const [uid, have] of cached) {
    const now = fetched.get(uid);
    if (!now) {
      if (presence) vanished.push(uid);
      continue;
    }
    if (have.flagsAt > since) continue;
    if (have.seen !== now.seen || have.flagged !== now.flagged || have.answered !== now.answered || have.draft !== now.draft) changed.push({ uid, ...now });
  }
  return { changed, vanished };
}

/**
 * Walks `desc` (UIDs, newest first) picking the ones not cached yet, at most `budget`. `last` is how far down every UID is
 * then cached (0 when not even the first), `done` whether that was all of them.
 */
export function walkDown(desc: readonly number[], have: ReadonlySet<number>, budget: number): { todo: number[]; last: number; done: boolean } {
  const todo: number[] = [];
  let i = 0;
  for (; i < desc.length; i++) {
    if (have.has(desc[i])) continue;
    if (todo.length >= budget) break;
    todo.push(desc[i]);
  }
  return i >= desc.length ? { todo, last: desc[desc.length - 1] ?? 0, done: true } : { todo, last: desc[i - 1] ?? 0, done: false };
}

/** A message's sender, lower-cased, for the cached row. */
const senderOf = (s: MessageSummary) => (s.from?.address ?? '').toLowerCase();
const bare = bareId;
/** Everyone on a message but `me`, lower-cased: who it is from, to and cc. */
export const participantsOf = (s: MessageSummary, me = ''): string[] => [...new Set([s.from, ...s.to, ...s.cc].map((a) => (a?.address ?? '').toLowerCase()).filter((a) => a && a !== me.toLowerCase()))];
const headerText = (h: Uint8Array | string | undefined) => (h === undefined ? null : typeof h === 'string' ? h : Buffer.from(h).toString('latin1'));

/**
 * The SQL of a page of threads (`threadPage`): the threads with a cached message in the folder, each by its newest UID
 * there (`tops`, at most CACHE_ROWS rows). With a tab's filter, `tops` is materialized and scanned first, and each top's
 * row of `mail_categories` found by its key (CROSS JOIN fixes the order: left to itself SQLite scanned every cached
 * category row of the folder — tens of thousands on a long-used inbox — re-running the GROUP BY for each, 30 s of CPU).
 */
export function threadPageSql(tab?: string): string {
  const tops = 'SELECT thread_id, MAX(uid) AS top_uid FROM mail_messages WHERE account_id = ? AND folder = ? AND uid_validity = ? AND uid >= ? AND thread_id IS NOT NULL GROUP BY thread_id HAVING MAX(uid) < ?';
  if (!tab) return `SELECT thread_id, top_uid FROM (${tops}) ORDER BY top_uid DESC LIMIT ?`;
  return `WITH t AS MATERIALIZED (${tops}) SELECT t.thread_id, t.top_uid FROM t CROSS JOIN mail_categories c ON c.account_id = ? AND c.folder = ? AND c.uid_validity = ? AND c.uid = t.top_uid
    LEFT JOIN mail_category_overrides o ON o.account_id = c.account_id AND o.sender = c.sender WHERE ${tab} = ? ORDER BY t.top_uid DESC LIMIT ?`;
}

/** A folder's row as read. */
type FolderRow = { account_id: string; folder: string; uid_validity: string; high: number; low: number; modseq: string | null; kind: string; synced_at: number; opened_at: number; error: string | null; error_at: number };
const toFolder = (r: FolderRow): CachedFolder => ({
  accountId: r.account_id, folder: r.folder, validity: r.uid_validity, high: r.high, low: r.low, modseq: r.modseq,
  kind: r.kind as FolderKind, syncedAt: r.synced_at, openedAt: r.opened_at, error: r.error, errorAt: r.error_at,
});

const CHUNK = 5000;
function chunks<T>(list: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += CHUNK) out.push(list.slice(i, i + CHUNK));
  return out;
}

/** The cache's tables, as object.ts uses them. */
export class MailCache {
  constructor(private readonly sql: Sql) {}

  init(): void {
    for (const statement of DDL) this.sql.exec(statement);
  }

  // ---- state ----------------------------------------------------------------------------------------------------

  state(key: string): string | null {
    return this.sql.exec<{ value: string }>('SELECT value FROM mail_state WHERE key = ?', key).toArray()[0]?.value ?? null;
  }

  setState(key: string, value: string): void {
    this.sql.exec('INSERT OR REPLACE INTO mail_state (key, value) VALUES (?, ?)', key, value);
  }

  lastActiveAt(): number {
    return Number(this.state('last_active_at') ?? 0) || 0;
  }

  // ---- folders ----------------------------------------------------------------------------------------------------

  folder(accountId: string, folder: string): CachedFolder | null {
    const r = this.sql.exec<FolderRow>('SELECT * FROM mail_cache_folders WHERE account_id = ? AND folder = ?', accountId, folder).toArray()[0];
    return r ? toFolder(r) : null;
  }

  /** Every cached folder of an account, the main ones first (in MAIN_KINDS order), then the recent by when they were opened. */
  folders(accountId: string): CachedFolder[] {
    const rows = this.sql.exec<FolderRow>('SELECT * FROM mail_cache_folders WHERE account_id = ?', accountId).toArray().map(toFolder);
    const rank = (f: CachedFolder) => { const i = MAIN_KINDS.indexOf(f.kind); return i < 0 ? MAIN_KINDS.length : i; };
    return rows.sort((a, b) => rank(a) - rank(b) || b.openedAt - a.openedAt);
  }

  /** Makes sure a folder has a row (its kind kept up to date), and notes that it was looked at when `opened`. */
  touchFolder(accountId: string, folder: string, kind: FolderKind, now: number, opened: boolean): CachedFolder {
    this.sql.exec(
      `INSERT INTO mail_cache_folders (account_id, folder, kind, opened_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (account_id, folder) DO UPDATE SET kind = CASE WHEN excluded.kind != 'recent' THEN excluded.kind ELSE mail_cache_folders.kind END, opened_at = MAX(mail_cache_folders.opened_at, excluded.opened_at)`,
      accountId, folder, kind, opened ? now : 0);
    return this.folder(accountId, folder)!;
  }

  /** A folder whose UIDs mean something else now (a new UIDVALIDITY, or seen for the first time): its rows go, its marks reset. */
  resetFolder(accountId: string, folder: string, validity: string): CachedFolder {
    this.rememberThreads(accountId, 'account_id = ? AND folder = ? AND uid_validity != ?', accountId, folder, validity);
    this.sql.exec('DELETE FROM mail_messages WHERE account_id = ? AND folder = ? AND uid_validity != ?', accountId, folder, validity);
    this.sql.exec('UPDATE mail_cache_folders SET uid_validity = ?, high = 0, low = 0, modseq = NULL, synced_at = 0 WHERE account_id = ? AND folder = ?', validity, accountId, folder);
    return this.folder(accountId, folder)!;
  }

  setMarks(accountId: string, folder: string, marks: { high?: number; low?: number; modseq?: string | null; syncedAt?: number; error?: string | null; errorAt?: number }): void {
    const sets: string[] = [], params: unknown[] = [];
    for (const [col, key] of [['high', 'high'], ['low', 'low'], ['modseq', 'modseq'], ['synced_at', 'syncedAt'], ['error', 'error'], ['error_at', 'errorAt']] as const) {
      if (marks[key] !== undefined) { sets.push(`${col} = ?`); params.push(marks[key]); }
    }
    if (!sets.length) return;
    this.sql.exec(`UPDATE mail_cache_folders SET ${sets.join(', ')} WHERE account_id = ? AND folder = ?`, ...params, accountId, folder);
  }

  /** Lowers `low` only from the value that was read (as the tabs' sorter does): new mail cached past a gap meanwhile moved it up. */
  lowerLow(accountId: string, folder: string, validity: string, from: number, to: number): void {
    this.sql.exec('UPDATE mail_cache_folders SET low = ? WHERE account_id = ? AND folder = ? AND uid_validity = ? AND low = ?', to, accountId, folder, validity, from);
  }

  /** Folders the alarm no longer keeps: opened too long ago and not one of the main ones. Their rows go. */
  expireFolders(accountId: string, now: number): string[] {
    const gone = this.sql.exec<{ folder: string }>("SELECT folder FROM mail_cache_folders WHERE account_id = ? AND kind = 'recent' AND opened_at < ?", accountId, now - RECENT_MS).toArray().map((r) => r.folder);
    for (const folder of gone) {
      this.rememberThreads(accountId, 'account_id = ? AND folder = ?', accountId, folder);
      this.sql.exec('DELETE FROM mail_messages WHERE account_id = ? AND folder = ?', accountId, folder);
      this.sql.exec('DELETE FROM mail_cache_folders WHERE account_id = ? AND folder = ?', accountId, folder);
    }
    return gone;
  }

  // ---- rows -------------------------------------------------------------------------------------------------------

  /**
   * Caches fetched messages. A message new to the cache is given its thread (threads.ts `assignThread`, the cache as its
   * store) and its references kept; one already cached keeps its thread and gets the fresh summary and flags. Returns each
   * message's thread id.
   */
  insert(accountId: string, folder: string, validity: string, rows: readonly NewRow[], now: number, me = ''): Map<number, string> {
    const out = new Map<number, string>();
    const have = this.cachedUids(accountId, folder, validity, rows.map((r) => r.m.uid));
    const store = this.threadStore(accountId, me);
    // In the order they arrived (UID order), so a reply finds what it answers when both come in one batch.
    for (const { m, summary, headers, plan } of [...rows].sort((a, b) => a.m.uid - b.m.uid)) {
      const f = flagsOf(m.flags);
      const h = parseHeaders(headers ?? undefined);
      const messageId = bareId(summary.messageId);
      const references = idsIn(h.get('references'));
      const inReplyTo = bareId(h.get('in-reply-to')) || null;
      let threadId: string | null = null;
      if (have.has(m.uid)) {
        threadId = this.sql.exec<{ thread_id: string | null }>('SELECT thread_id FROM mail_messages WHERE account_id = ? AND folder = ? AND uid_validity = ? AND uid = ?', accountId, folder, validity, m.uid).toArray()[0]?.thread_id ?? null;
      }
      if (!threadId) {
        const assigned = assignThread({
          messageId, inReplyTo, references, subject: summary.subject, date: Date.parse(summary.date) || 0, serverThreadId: m.threadId ?? null,
          list: h.has('list-id'), draft: f.draft, participants: participantsOf(summary, me),
        }, store);
        threadId = assigned.threadId;
        if (assigned.merge.length) this.mergeThreads(accountId, threadId, assigned.merge);
      }
      this.sql.exec(
        `INSERT INTO mail_messages (account_id, folder, uid_validity, uid, message_id, email_id, thread_id, date, seen, flagged, answered, draft, flags, modseq, flags_at, sender, subject_norm, summary, plan, headers)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (account_id, folder, uid_validity, uid) DO UPDATE SET
           message_id = excluded.message_id, email_id = excluded.email_id, thread_id = excluded.thread_id, date = excluded.date,
           seen = excluded.seen, flagged = excluded.flagged, answered = excluded.answered, draft = excluded.draft, flags = excluded.flags, modseq = excluded.modseq, flags_at = excluded.flags_at,
           sender = excluded.sender, subject_norm = excluded.subject_norm, summary = excluded.summary, plan = COALESCE(excluded.plan, mail_messages.plan), headers = COALESCE(excluded.headers, mail_messages.headers)`,
        accountId, folder, validity, m.uid, messageId, m.emailId ?? null, threadId, Date.parse(summary.date) || 0,
        f.seen ? 1 : 0, f.flagged ? 1 : 0, f.answered ? 1 : 0, f.draft ? 1 : 0, JSON.stringify([...(m.flags ?? [])]), m.modseq !== undefined ? String(m.modseq) : null, now,
        senderOf(summary), normalizeSubject(summary.subject), JSON.stringify(summary), plan ? JSON.stringify(plan) : null, headerText(headers ?? undefined));
      if (!have.has(m.uid)) this.noteContacts(accountId, summary, me);
      const refs = [...new Set([inReplyTo ?? '', ...references].filter(Boolean))];
      this.sql.exec('DELETE FROM mail_refs WHERE account_id = ? AND folder = ? AND uid_validity = ? AND uid = ?', accountId, folder, validity, m.uid);
      for (const ref of refs) this.sql.exec('INSERT OR IGNORE INTO mail_refs (account_id, ref, folder, uid_validity, uid) VALUES (?, ?, ?, ?, ?)', accountId, ref, folder, validity, m.uid);
      out.set(m.uid, threadId);
    }
    return out;
  }

  // ---- threads ----------------------------------------------------------------------------------------------------

  /** The cache as threads.ts reads it. `me` (the account's address) is on every message, so it never counts as someone in common. */
  private threadStore(accountId: string, me: string): ThreadStore {
    return {
      threadsOf: (ids) => {
        const out = new Map<string, Known>();
        if (!ids.length) return out;
        const list = JSON.stringify([...ids]);
        for (const r of this.sql.exec<{ message_id: string; thread_id: string; date: number }>('SELECT message_id, thread_id, date FROM mail_thread_index WHERE account_id = ? AND message_id IN (SELECT value FROM json_each(?))', accountId, list).toArray()) out.set(r.message_id, { threadId: r.thread_id, date: r.date });
        for (const r of this.sql.exec<{ message_id: string; thread_id: string; date: number }>("SELECT message_id, thread_id, date FROM mail_messages WHERE account_id = ? AND thread_id IS NOT NULL AND message_id != '' AND message_id IN (SELECT value FROM json_each(?))", accountId, list).toArray()) out.set(r.message_id, { threadId: r.thread_id, date: r.date });
        return out;
      },
      referencing: (id) => this.sql.exec<{ thread_id: string }>(
        'SELECT DISTINCT m.thread_id FROM mail_refs r JOIN mail_messages m ON m.account_id = r.account_id AND m.folder = r.folder AND m.uid_validity = r.uid_validity AND m.uid = r.uid WHERE r.account_id = ? AND r.ref = ? AND m.thread_id IS NOT NULL',
        accountId, id).toArray().map((r) => r.thread_id),
      bySubject: (norm, since) => this.sql.exec<{ thread_id: string; date: number; summary: string }>(
        "SELECT thread_id, date, summary FROM mail_messages WHERE account_id = ? AND subject_norm = ? AND date >= ? AND thread_id IS NOT NULL AND draft = 0 ORDER BY date DESC LIMIT 50",
        accountId, norm, since).toArray().map((r) => ({ threadId: r.thread_id, date: r.date, participants: participantsOf(JSON.parse(r.summary) as MessageSummary, me) })),
      newId: () => `l:${crypto.randomUUID()}`,
    };
  }

  /** Threads found to be one (a message linking them arrived): the losers' messages move to the winner. */
  mergeThreads(accountId: string, winner: string, losers: readonly string[]): void {
    const list = JSON.stringify(losers);
    this.sql.exec('UPDATE mail_messages SET thread_id = ? WHERE account_id = ? AND thread_id IN (SELECT value FROM json_each(?))', winner, accountId, list);
    this.sql.exec('UPDATE mail_thread_index SET thread_id = ? WHERE account_id = ? AND thread_id IN (SELECT value FROM json_each(?))', winner, accountId, list);
  }

  /** Before rows leave the cache: their message ids keep pointing at their threads, so a later reply finds them. */
  private rememberThreads(accountId: string, where: string, ...params: unknown[]): void {
    this.sql.exec(`INSERT OR REPLACE INTO mail_thread_index (account_id, message_id, thread_id, date) SELECT account_id, message_id, thread_id, date FROM mail_messages WHERE message_id != '' AND thread_id IS NOT NULL AND ${where}`, ...params);
    this.sql.exec(`DELETE FROM mail_refs WHERE (account_id, folder, uid_validity, uid) IN (SELECT account_id, folder, uid_validity, uid FROM mail_messages WHERE ${where})`, ...params);
  }

  /** Keeps the thread index within THREAD_INDEX_CAP per account (the oldest go). */
  private trimThreadIndex(accountId: string): void {
    const n = this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM mail_thread_index WHERE account_id = ?', accountId).toArray()[0]?.n ?? 0;
    if (n > THREAD_INDEX_CAP) {
      this.sql.exec('DELETE FROM mail_thread_index WHERE account_id = ? AND message_id IN (SELECT message_id FROM mail_thread_index WHERE account_id = ? ORDER BY date ASC LIMIT ?)', accountId, accountId, n - THREAD_INDEX_CAP);
    }
  }

  /**
   * One page of a folder's threads, newest first: each thread with a cached message in the folder (from `low` up), ordered
   * by its newest UID there, those below `cursor`. `tab` (INBOX with tabs on) keeps the threads whose newest message is in
   * the tab: `mail_categories` joined on that UID, with the overrides (categorize.ts `effectiveSql`, as object.ts `tabRows` uses it).
   */
  threadPage(accountId: string, folder: string, validity: string, cursor: number, low: number, limit: number, tab?: { tab: string; params: string[]; category: string }): { threadId: string; uid: number }[] {
    const rows = tab
      ? this.sql.exec<{ thread_id: string; top_uid: number }>(threadPageSql(tab.tab), accountId, folder, validity, Math.max(1, low), cursor, accountId, folder, validity, ...tab.params, tab.category, limit).toArray()
      : this.sql.exec<{ thread_id: string; top_uid: number }>(threadPageSql(), accountId, folder, validity, Math.max(1, low), cursor, limit).toArray();
    return rows.map((r) => ({ threadId: r.thread_id, uid: r.top_uid }));
  }

  /** Every cached message of these threads, account-wide, with what a thread's row and reading need. */
  threadRows(accountId: string, threadIds: readonly string[]): ThreadRow[] {
    if (!threadIds.length) return [];
    return this.sql.exec<{ uid: number; folder: string; uid_validity: string; thread_id: string; message_id: string; email_id: string | null; seen: number; flagged: number; answered: number; draft: number; date: number; body_state: number; summary: string }>(
      'SELECT uid, folder, uid_validity, thread_id, message_id, email_id, seen, flagged, answered, draft, date, body_state, summary FROM mail_messages WHERE account_id = ? AND thread_id IN (SELECT value FROM json_each(?)) ORDER BY date ASC, uid ASC',
      accountId, JSON.stringify([...threadIds])).toArray().map((r) => ({
        uid: r.uid, folder: r.folder, validity: r.uid_validity, threadId: r.thread_id, messageId: r.message_id, emailId: r.email_id, date: r.date, draft: !!r.draft, bodyState: r.body_state,
        key: dedupeKey({ emailId: r.email_id, messageId: r.message_id, folder: r.folder, uid: r.uid }),
        summary: { ...(JSON.parse(r.summary) as MessageSummary), seen: !!r.seen, flagged: !!r.flagged, answered: !!r.answered, threadId: r.thread_id },
      }));
  }

  /**
   * The inbox tabs as the tab bar shows them (docs/specs/mail-api.md, Inbox tabs: the badges): for each tab, how many cached
   * messages of the folder are in it, how many unread, how many arrived after `after[tab]` (the newest the person has seen
   * there), and the newest message. `tab` is the tab of a row as categorize.ts `effectiveSql` writes it (a row not sorted yet
   * is Primary). Reads the cached rows once and counts in JS.
   */
  tabStatus(accountId: string, folder: string, validity: string, low: number, tab: { tab: string; params: string[] }, after: ReadonlyMap<string, number>): { category: string; total: number; unread: number; new: number; newest: MessageSummary | null }[] {
    const rows = this.sql.exec<{ uid: number; seen: number; tab: string }>(
      `SELECT m.uid, m.seen, ${tab.tab} AS tab FROM mail_messages m
       LEFT JOIN mail_categories c ON c.account_id = m.account_id AND c.folder = m.folder AND c.uid_validity = m.uid_validity AND c.uid = m.uid
       LEFT JOIN mail_category_overrides o ON o.account_id = c.account_id AND o.sender = c.sender
       WHERE m.account_id = ? AND m.folder = ? AND m.uid_validity = ? AND m.uid >= ?`,
      ...tab.params, accountId, folder, validity, Math.max(1, low)).toArray();
    const by = new Map<string, { total: number; unread: number; new: number; newest: number }>();
    for (const r of rows) {
      const t = by.get(r.tab) ?? { total: 0, unread: 0, new: 0, newest: 0 };
      t.total++;
      if (!r.seen) t.unread++;
      const seen = after.get(r.tab);
      if (seen !== undefined && r.uid > seen) t.new++;
      if (r.uid > t.newest) t.newest = r.uid;
      by.set(r.tab, t);
    }
    const newest = this.byUids(accountId, folder, validity, [...by.values()].map((t) => t.newest));
    return [...by].map(([category, t]) => ({ category, total: t.total, unread: t.unread, new: t.new, newest: newest.get(t.newest)?.summary ?? null }));
  }

  /** The thread of a cached message. */
  threadOf(accountId: string, folder: string, uid: number): string | null {
    return this.sql.exec<{ thread_id: string | null }>('SELECT thread_id FROM mail_messages WHERE account_id = ? AND folder = ? AND uid = ?', accountId, folder, uid).toArray()[0]?.thread_id ?? null;
  }

  /** A message as a thread's reading shows it when its body is not cached: the detail from the row, without bodies. */
  pendingDetail(accountId: string, folder: string, uid: number): Omit<MessageDetail, 'html' | 'text'> | null {
    const r = this.sql.exec<{ summary: string; headers: string | null; plan: string | null; seen: number; flagged: number; answered: number }>(
      'SELECT summary, headers, plan, seen, flagged, answered FROM mail_messages WHERE account_id = ? AND folder = ? AND uid = ?', accountId, folder, uid).toArray()[0];
    if (!r) return null;
    const summary = JSON.parse(r.summary) as MessageSummary;
    const h = parseHeaders(r.headers ?? undefined);
    const plan = r.plan ? (JSON.parse(r.plan) as BodyPlan) : null;
    const { attachments: _listed, ...rest } = summary;
    return {
      ...rest, seen: !!r.seen, flagged: !!r.flagged, answered: !!r.answered,
      replyTo: [], bcc: [], inReplyTo: bareId(h.get('in-reply-to')) || null, references: idsIn(h.get('references')),
      attachments: plan ? plan.attachments.map((a) => ({ index: a.index, filename: a.filename, mimeType: a.mimeType, size: a.leaf.size, contentId: a.contentId, inline: a.inline })) : [],
    };
  }

  /** Which of these UIDs have a row. */
  cachedUids(accountId: string, folder: string, validity: string, uids: readonly number[]): Set<number> {
    const out = new Set<number>();
    for (const part of chunks(uids)) {
      for (const r of this.sql.exec<{ uid: number }>('SELECT uid FROM mail_messages WHERE account_id = ? AND folder = ? AND uid_validity = ? AND uid IN (SELECT value FROM json_each(?))',
        accountId, folder, validity, JSON.stringify(part)).toArray()) out.add(r.uid);
    }
    return out;
  }

  /** Every cached UID of a folder, newest first. */
  uids(accountId: string, folder: string, validity: string): number[] {
    return this.sql.exec<{ uid: number }>('SELECT uid FROM mail_messages WHERE account_id = ? AND folder = ? AND uid_validity = ? ORDER BY uid DESC', accountId, folder, validity).toArray().map((r) => r.uid);
  }

  count(accountId: string, folder: string, validity: string): number {
    return this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM mail_messages WHERE account_id = ? AND folder = ? AND uid_validity = ?', accountId, folder, validity).toArray()[0]?.n ?? 0;
  }

  /** One page, newest first: the cached rows below `cursor` and from `low` up, `limit` of them. */
  page(accountId: string, folder: string, validity: string, cursor: number, low: number, limit: number): CachedMessage[] {
    return this.sql.exec<{ summary: string; thread_id: string | null; email_id: string | null; seen: number; flagged: number; answered: number; flags_at: number }>(
      'SELECT summary, thread_id, email_id, seen, flagged, answered, flags_at FROM mail_messages WHERE account_id = ? AND folder = ? AND uid_validity = ? AND uid < ? AND uid >= ? ORDER BY uid DESC LIMIT ?',
      accountId, folder, validity, cursor, Math.max(1, low), limit).toArray().map((r) => ({
        summary: { ...(JSON.parse(r.summary) as MessageSummary), seen: !!r.seen, flagged: !!r.flagged, answered: !!r.answered, ...(r.thread_id ? { threadId: r.thread_id } : {}) },
        threadId: r.thread_id, emailId: r.email_id, flagsAt: r.flags_at,
      }));
  }

  /** The flags of these cached messages, with when each was last written. */
  flags(accountId: string, folder: string, validity: string, uids: readonly number[]): Map<number, Flags & { flagsAt: number }> {
    const out = new Map<number, Flags & { flagsAt: number }>();
    for (const part of chunks(uids)) {
      for (const r of this.sql.exec<{ uid: number; seen: number; flagged: number; answered: number; draft: number; flags_at: number }>(
        'SELECT uid, seen, flagged, answered, draft, flags_at FROM mail_messages WHERE account_id = ? AND folder = ? AND uid_validity = ? AND uid IN (SELECT value FROM json_each(?))',
        accountId, folder, validity, JSON.stringify(part)).toArray()) {
        out.set(r.uid, { seen: !!r.seen, flagged: !!r.flagged, answered: !!r.answered, draft: !!r.draft, flagsAt: r.flags_at });
      }
    }
    return out;
  }

  /** Flags as the server has them now (from a FLAGS fetch), or as set through us (`seen`/`flagged` alone). */
  setFlags(accountId: string, folder: string, uids: readonly number[], flags: Partial<Flags>, at: number): void {
    const sets: string[] = [], params: unknown[] = [];
    for (const key of ['seen', 'flagged', 'answered', 'draft'] as const) if (flags[key] !== undefined) { sets.push(`${key} = ?`); params.push(flags[key] ? 1 : 0); }
    if (!sets.length) return;
    for (const part of chunks(uids)) {
      this.sql.exec(`UPDATE mail_messages SET ${sets.join(', ')}, flags_at = ? WHERE account_id = ? AND folder = ? AND uid IN (SELECT value FROM json_each(?))`, ...params, at, accountId, folder, JSON.stringify(part));
    }
  }

  /** Rows of messages that left the folder. */
  remove(accountId: string, folder: string, uids: readonly number[]): void {
    for (const part of chunks(uids)) {
      this.rememberThreads(accountId, 'account_id = ? AND folder = ? AND uid IN (SELECT value FROM json_each(?))', accountId, folder, JSON.stringify(part));
      this.sql.exec('DELETE FROM mail_messages WHERE account_id = ? AND folder = ? AND uid IN (SELECT value FROM json_each(?))', accountId, folder, JSON.stringify(part));
    }
  }

  /** Keeps only the newest `keep` rows of a folder; `low` then is the lowest kept. Returns how many went. */
  trim(accountId: string, folder: string, validity: string, keep: number): number {
    const n = this.count(accountId, folder, validity);
    if (n <= keep) return 0;
    const past = 'account_id = ? AND folder = ? AND uid_validity = ? AND uid NOT IN (SELECT uid FROM mail_messages WHERE account_id = ? AND folder = ? AND uid_validity = ? ORDER BY uid DESC LIMIT ?)';
    this.rememberThreads(accountId, past, accountId, folder, validity, accountId, folder, validity, keep);
    this.sql.exec(`DELETE FROM mail_messages WHERE ${past}`, accountId, folder, validity, accountId, folder, validity, keep);
    this.trimThreadIndex(accountId);
    const low = this.sql.exec<{ uid: number }>('SELECT MIN(uid) AS uid FROM mail_messages WHERE account_id = ? AND folder = ? AND uid_validity = ?', accountId, folder, validity).toArray()[0]?.uid ?? 0;
    this.sql.exec('UPDATE mail_cache_folders SET low = ? WHERE account_id = ? AND folder = ? AND uid_validity = ?', low, accountId, folder, validity);
    return n - keep;
  }

  /** The cached rows of some UIDs of a folder (those it has), as a list shows them. */
  byUids(accountId: string, folder: string, validity: string, uids: readonly number[]): Map<number, CachedMessage> {
    const out = new Map<number, CachedMessage>();
    for (const part of chunks(uids)) {
      for (const r of this.sql.exec<{ uid: number; summary: string; thread_id: string | null; email_id: string | null; seen: number; flagged: number; answered: number; flags_at: number }>(
        'SELECT uid, summary, thread_id, email_id, seen, flagged, answered, flags_at FROM mail_messages WHERE account_id = ? AND folder = ? AND uid_validity = ? AND uid IN (SELECT value FROM json_each(?))',
        accountId, folder, validity, JSON.stringify(part)).toArray()) {
        out.set(r.uid, { summary: { ...(JSON.parse(r.summary) as MessageSummary), seen: !!r.seen, flagged: !!r.flagged, answered: !!r.answered, ...(r.thread_id ? { threadId: r.thread_id } : {}) }, threadId: r.thread_id, emailId: r.email_id, flagsAt: r.flags_at });
      }
    }
    return out;
  }

  // ---- bodies -----------------------------------------------------------------------------------------------------

  /**
   * A cached message as opened, when its body is here: the detail with the flags as last known, and the plan to fetch
   * one of its attachments by. On a server with message ids (Gmail, OBJECTID), a copy in another folder with the body
   * stands in (the bodies are kept once per message). Null when the body is not cached.
   */
  body(accountId: string, folder: string, validity: string, uid: number): CachedBody | null {
    const own = this.sql.exec<BodyRow>('SELECT * FROM mail_messages WHERE account_id = ? AND folder = ? AND uid_validity = ? AND uid = ?', accountId, folder, validity, uid).toArray()[0];
    if (!own) return null;
    const r = own.body_state === BODY.cached ? own
      : own.email_id ? this.sql.exec<BodyRow>('SELECT * FROM mail_messages WHERE account_id = ? AND email_id = ? AND body_state = ? LIMIT 1', accountId, own.email_id, BODY.cached).toArray()[0]
        : undefined;
    if (!r || !r.detail) return null;
    const detail = { ...(JSON.parse(r.detail) as Omit<MessageDetail, 'html' | 'text'>), uid: own.uid, folder: own.folder, seen: !!own.seen, flagged: !!own.flagged, answered: !!own.answered, html: r.html, text: r.text, ...(own.thread_id ? { threadId: own.thread_id } : {}) };
    return { detail, plan: own.plan ? (JSON.parse(own.plan) as BodyPlan) : null, state: own.body_state };
  }

  /** The body of a message as opened: kept when it fits, else marked (`state`) so it is opened from the server. */
  setBody(accountId: string, folder: string, uid: number, body: { detail: Omit<MessageDetail, 'html' | 'text'>; html: string | null; text: string | null; plan: BodyPlan | null } | null, state: number): void {
    const bytes = body ? byteLength(body.html) + byteLength(body.text) : 0;
    this.sql.exec('UPDATE mail_messages SET body_state = ?, body_bytes = ?, detail = ?, html = ?, text = ?, plan = COALESCE(?, plan) WHERE account_id = ? AND folder = ? AND uid = ?',
      state, bytes, body ? JSON.stringify(body.detail) : null, body?.html ?? null, body?.text ?? null, body?.plan ? JSON.stringify(body.plan) : null, accountId, folder, uid);
  }

  /** The body plan a message was cached with (to fetch one attachment by, without BODYSTRUCTURE), if any. */
  plan(accountId: string, folder: string, uid: number): BodyPlan | null {
    const r = this.sql.exec<{ plan: string | null }>('SELECT plan FROM mail_messages WHERE account_id = ? AND folder = ? AND uid = ?', accountId, folder, uid).toArray()[0];
    return r?.plan ? (JSON.parse(r.plan) as BodyPlan) : null;
  }

  /** The state of the bodies of some UIDs (for the queue: which still want fetching). */
  bodyStates(accountId: string, folder: string, validity: string, uids: readonly number[]): Map<number, number> {
    const out = new Map<number, number>();
    for (const part of chunks(uids)) {
      for (const r of this.sql.exec<{ uid: number; body_state: number }>('SELECT uid, body_state FROM mail_messages WHERE account_id = ? AND folder = ? AND uid_validity = ? AND uid IN (SELECT value FROM json_each(?))',
        accountId, folder, validity, JSON.stringify(part)).toArray()) out.set(r.uid, r.body_state);
    }
    return out;
  }

  /**
   * Messages of a folder whose body is still to fetch, unread first and then newest first, with the plan and the raw
   * headers each was cached with (a row without a plan is skipped: it cannot be opened by its parts). On a server with
   * message ids, a message whose body another folder already holds is marked as cached from there and left out.
   */
  bodyQueue(accountId: string, folder: string, validity: string, limit: number): QueuedBody[] {
    const rows = this.sql.exec<{ uid: number; email_id: string | null; summary: string; plan: string | null; headers: string | null }>(
      `SELECT uid, email_id, summary, plan, headers FROM mail_messages WHERE account_id = ? AND folder = ? AND uid_validity = ? AND body_state = ? AND plan IS NOT NULL
       ORDER BY seen ASC, uid DESC LIMIT ?`, accountId, folder, validity, BODY.pending, limit * 2).toArray();
    const out: QueuedBody[] = [];
    for (const r of rows) {
      if (r.email_id && this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM mail_messages WHERE account_id = ? AND email_id = ? AND body_state = ?', accountId, r.email_id, BODY.cached).toArray()[0]?.n) {
        this.sql.exec('UPDATE mail_messages SET body_state = ? WHERE account_id = ? AND folder = ? AND uid = ?', BODY.cached, accountId, folder, r.uid);
        continue;
      }
      out.push({ uid: r.uid, summary: JSON.parse(r.summary) as MessageSummary, plan: JSON.parse(r.plan!) as BodyPlan, headers: r.headers });
      if (out.length >= limit) break;
    }
    return out;
  }

  /** What a folder's cached bodies come to, in bytes. */
  bodyBytes(accountId: string, folder: string): number {
    return this.sql.exec<{ n: number | null }>('SELECT SUM(body_bytes) AS n FROM mail_messages WHERE account_id = ? AND folder = ?', accountId, folder).toArray()[0]?.n ?? 0;
  }

  /** Drops a folder's oldest bodies until they fit `budget` bytes. Returns how many went. */
  evictBodies(accountId: string, folder: string, budget: number): number {
    let total = this.bodyBytes(accountId, folder), gone = 0;
    if (total <= budget) return 0;
    for (const r of this.sql.exec<{ uid: number; body_bytes: number }>('SELECT uid, body_bytes FROM mail_messages WHERE account_id = ? AND folder = ? AND body_state = ? ORDER BY uid ASC', accountId, folder, BODY.cached).toArray()) {
      if (total <= budget) break;
      this.sql.exec('UPDATE mail_messages SET body_state = ?, body_bytes = 0, html = NULL, text = NULL WHERE account_id = ? AND folder = ? AND uid = ?', BODY.evicted, accountId, folder, r.uid);
      total -= r.body_bytes;
      gone++;
    }
    return gone;
  }

  /** The message with this Message-ID was answered (a reply sent through us), wherever it is cached. */
  setAnswered(accountId: string, messageId: string, at: number): void {
    const id = bare(messageId);
    if (id) this.sql.exec('UPDATE mail_messages SET answered = 1, flags_at = ? WHERE account_id = ? AND message_id = ?', at, accountId, id);
  }

  // ---- contacts ---------------------------------------------------------------------------------------------------

  /**
   * The people on a message, counted: a message from the account's own address counts its To and Cc as written to
   * (`sent`), any other its sender as heard from (`received`); the most recent name is kept. A copy in another folder counts
   * again, which only weighs it a little more.
   */
  private noteContacts(accountId: string, s: MessageSummary, me: string): void {
    const at = Date.parse(s.date) || 0;
    const mine = me.toLowerCase();
    const from = (s.from?.address ?? '').toLowerCase();
    const note = (a: { name: string; address: string } | null, sent: number, received: number) => {
      const address = (a?.address ?? '').toLowerCase();
      if (!address || !address.includes('@') || address === mine) return;
      this.sql.exec(
        `INSERT INTO mail_contacts (account_id, address, name, sent, received, last_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (account_id, address) DO UPDATE SET sent = sent + excluded.sent, received = received + excluded.received,
           name = CASE WHEN excluded.name != '' AND excluded.last_at >= mail_contacts.last_at THEN excluded.name ELSE mail_contacts.name END, last_at = MAX(mail_contacts.last_at, excluded.last_at)`,
        accountId, address, (a?.name ?? '').trim(), sent, received, at);
    };
    if (from && from === mine) for (const a of [...s.to, ...s.cc]) note(a, 1, 0);
    else note(s.from, 0, 1);
  }

  /**
   * Builds the contacts from every cached message, once per account (`mail_state` remembers), for an account cached
   * before the table existed: what new mail counted meanwhile is counted again, which only weighs it a little more.
   */
  rebuildContacts(accountId: string, me: string): number {
    const key = `contacts_built:${accountId}`;
    if (this.state(key)) return 0;
    let n = 0;
    for (const r of this.sql.exec<{ summary: string }>('SELECT summary FROM mail_messages WHERE account_id = ?', accountId).toArray()) {
      this.noteContacts(accountId, JSON.parse(r.summary) as MessageSummary, me);
      n++;
    }
    this.setState(key, String(Date.now()));
    return n;
  }

  /**
   * The contacts matching `q` (the start of the address, or of a word of the name), the ones written to most first, then
   * the most heard from, then the latest; with no `q`, the same order over everyone.
   */
  contacts(accountId: string, q: string, limit: number): Contact[] {
    const needle = q.trim().toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`);
    const rows = needle
      ? this.sql.exec<{ address: string; name: string; sent: number; received: number; last_at: number }>(
        `SELECT address, name, sent, received, last_at FROM mail_contacts WHERE account_id = ? AND (address LIKE ? ESCAPE '\\' OR (' ' || lower(name)) LIKE ? ESCAPE '\\')
         ORDER BY sent DESC, received DESC, last_at DESC LIMIT ?`, accountId, `${needle}%`, `% ${needle}%`, limit).toArray()
      : this.sql.exec<{ address: string; name: string; sent: number; received: number; last_at: number }>(
        'SELECT address, name, sent, received, last_at FROM mail_contacts WHERE account_id = ? ORDER BY sent DESC, received DESC, last_at DESC LIMIT ?', accountId, limit).toArray();
    return rows.map((r) => ({ name: r.name, address: r.address, sent: r.sent, received: r.received, lastAt: r.last_at }));
  }

  forgetAccount(accountId: string): void {
    this.sql.exec('DELETE FROM mail_contacts WHERE account_id = ?', accountId);
    this.sql.exec('DELETE FROM mail_state WHERE key = ?', `contacts_built:${accountId}`);
    this.sql.exec('DELETE FROM mail_messages WHERE account_id = ?', accountId);
    this.sql.exec('DELETE FROM mail_cache_folders WHERE account_id = ?', accountId);
    this.sql.exec('DELETE FROM mail_refs WHERE account_id = ?', accountId);
    this.sql.exec('DELETE FROM mail_thread_index WHERE account_id = ?', accountId);
  }

  /** For the debug route: each cached folder with how many rows it holds, how many of them with their body, and the bodies' bytes. */
  report(accountId: string): (CachedFolder & { rows: number; bodies: number; bodyBytes: number })[] {
    return this.folders(accountId).map((f) => ({
      ...f, rows: this.count(accountId, f.folder, f.validity),
      bodies: this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM mail_messages WHERE account_id = ? AND folder = ? AND body_state = ?', accountId, f.folder, BODY.cached).toArray()[0]?.n ?? 0,
      bodyBytes: this.bodyBytes(accountId, f.folder),
    }));
  }
}
