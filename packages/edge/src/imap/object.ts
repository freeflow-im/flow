// FreeFlow Mail: one object per account (`idFromName(accountId)`, platform.md §3.6), holding the mail accounts its holder
// connected and talking to
// those accounts' own servers over IMAP and SMTP. The contract is docs/specs/mail-api.md.
//
// The accounts are in the object's SQLite, each password sealed with FLOW_DATA_KEY (org/crypto, the same scheme as Chat's
// files) and never returned or logged. While the object is awake it keeps up to four IMAP connections per account: an
// "interactive" one for what the user is waiting on (opening a message and its attachments, moves, deletes, the
// IMAP side of sending), a "background" one for lists, folders and flags (read, starred: the app shows them at once), a "sorter" for sorting older mail into tabs and the
// re-check, which take long on a large mailbox, so neither a slow list holds up opening a message nor sorting a list page,
// and a "cache" one for the alarm that keeps the prefetch cache (cache.ts) up to date, so it never waits on the sorter.
// Each is opened when first needed, reused, and logged out after a minute with nothing to do; a request finding it dropped
// opens another. Every operation on a folder holds that connection's lock on it (imapflow's getMailboxLock, which is per
// connection).
//
// The prefetch cache: the newest messages of each account's main folders (INBOX, Sent, Drafts, Archive or All Mail, and any
// folder opened lately) are kept in SQLite, so a folder's list is read from it (after one small `UID SEARCH` for new mail)
// and older pages come from it outright; the object's alarm refreshes flags, forgets mail that left, and fills in older
// mail, every 30 s while the person is using Mail and less often after.
import { AsyncLocalStorage } from 'node:async_hooks';
import { DurableObject } from 'cloudflare:workers';
import { connect } from 'cloudflare:sockets';
import { Hono, type Context } from 'hono';
import { ImapFlow, createSocketsTransport, type FetchMessageObject, type FetchQueryObject, type ListResponse, type SearchObject } from 'imapflow';
import nodemailer from 'nodemailer';
import PostalMime, { type Email } from 'postal-mime';
import { ApiError } from '../errors';
import { decryptBlob, encryptBlob } from '../org/crypto/index';
import { decodeTransfer, decodedSize, minimalMessage, planBody, prefetch, type BodyPlan } from './body';
import { ALARM_BUDGET_MS, BACKFILL_STEP, BODY, FRESH_MS, BODY_BATCH, BODY_BATCH_BYTES, BODY_BUDGET_PER_FOLDER, BODY_MAX_HTML, BODY_MAX_TEXT, CACHE_ROWS, ERROR_BACKOFF_MS, MAIN_KINDS, MailCache, NEW_CAP, flagDiff, flagsOf, nextAlarmAt, walkDown, type CachedFolder, type Flags, type FolderKind, type NewRow, type QueuedBody, type ThreadRow } from './cache';
import { contentDisposition, specialUseOf, snippetOf, textPartOf, toDetail, toFolders, toSummary, type AttachmentInfo, type MessageDetail, type MessageSummary, type SpecialUse, type TextPart, type ThreadPage, type ThreadSummary } from './convert';
import { participants } from './threads';
import { CATEGORIES, CATEGORY_HEADERS, classifyHeaders, effective, effectiveSql, isGmailHost, normalizeTabs, parseHeaders, tabPage, uidSet, type Category, type TabCategory } from './categorize';
import { GMAIL_NONE, GMAIL_REASON, GmailSearchError, recheckRows, sortBatch, type GmailSearcher, type RecheckResult } from './gmailTabs';
import { compileMime, outgoingMessage, type OutgoingFile } from './drafts';
import { calendarMessage, checkCalendarMail, type CalendarMail } from '../calendar/imip';
import type { AccountDTO } from '@flow/shared';
import type { CallerContext, ObjectBindings } from '../org/routes/compat';
import type { ImportRow } from '../importing';
import { exportTables, importTable, ownerMismatch, ownerRefusal } from '../perAccount';
import { AccountPatch, CategoryBody, DeleteBody, DraftBody, FlagsBody, MAX_SEND_BYTES, MoveBody, NewAccount, SendBody, SendersCategoryBody, TIMING_HEADER, checkServer, mailError, notFound, parse, savesSentCopy, sendSize, badRequest, type ServerSettings } from './rules';

export interface MailEnv {
  FLOW_DATA_KEY?: string;
  /** `off` stops the prefetch cache's alarm (a kill switch): pages then check the server themselves, as before it. */
  MAIL_ALARM?: string;
  /** `1` lets an account use `security: 'none'`, any port and a local host: local dev against GreenMail only. */
  MAIL_ALLOW_INSECURE?: string;
  /** The organizations' event logs (events/object.ts): new INBOX mail is published there as `mail.received`. */
  EVENTS?: DurableObjectNamespace<import('../events/object').Events>;
}

interface AccountRow {
  id: string; email: string; display_name: string; imap: string; smtp: string;
  secret: ArrayBuffer; key_id: string; status: string; status_message: string | null; created_at: number; tabs: string | null; kind: string;
}
/** `connected`: one the person added, with their password; `hosted`: the organization's mailbox at the hosted provider,
 * made by provisioning (platform.md §3.4) with a password the platform set, which the person neither sees nor changes. */
export type MailAccountKind = 'connected' | 'hosted';
/** The hosted mailbox as provisioning writes it (provisioning/consumer.ts). */
export interface HostedMailbox { email: string; displayName: string; imap: ServerSettings; smtp: ServerSettings; password: string }
/** What a person may not do to the hosted mailbox: remove it, or change its password or servers. */
const hostedRefusal = () => mailError(403, 'hosted_account', 'this mailbox is your organization\'s; it cannot be removed or have its password changed');
interface Account {
  id: string; kind: MailAccountKind; email: string; displayName: string; imap: ServerSettings; smtp: ServerSettings;
  status: 'ok' | 'auth_failed' | 'connect_failed'; statusMessage?: string;
  tabs: TabCategory[];
}
/** One INBOX message's tab (Gmail's own, or as its headers decide it), with its sender, subject and date. */
interface CategoryRow { uid: number; sender: string; from_name: string; subject: string; date: number; category: string; reason: string }
/** How far the cache of a folder's tabs reaches: every UID of the folder from `low` to `high` has its row. */
interface SyncState { validity: string; high: number; low: number; checkedAt: number; repairBelow: number }
/**
 * One sorting or re-check run's result, kept in memory (the last TAB_LOG_KEEP of each kind per account) for
 * `GET /v1/mail/accounts/:id/debug/tabs`. `sort`: new mail sorted (`categorized` into a tab, `primary`, `skipped` after a
 * failed search, `confirmed` batches asked about again by UID). `recheck` and `repair`: see RecheckResult.
 */
interface TabLogEntry {
  at: string; kind: 'sort' | 'recheck' | 'repair'; checked: number; errors: string[];
  categorized?: number; primary?: number; skipped?: number; confirmed?: number;
  promoted?: number; moved?: number; demoted?: number; gone?: number;
}
const TAB_LOG_KEEP = 10;
/** One page of a list. `sorting`: a tab's page came back short while older mail is still being sorted (ask again soon). */
interface MessagePage { messages: MessageSummary[]; next: number | null; sorting?: true }
/** What a background sorting run is after: `want` of a tab's messages cached below `below`, for the pages to come. */
interface SortTarget { tabs: TabCategory[]; category: Category; below: number; want: number }
/** A message as opened: what GET returns, and the parts already here (so its inline pictures do not each fetch again). */
interface Opened { detail: MessageDetail; plan: BodyPlan | null; parts: Map<number, { content: Buffer; mimeType: string; filename: string }> }

type Kind = 'interactive' | 'background' | 'sorter' | 'cache';
const KINDS: readonly Kind[] = ['interactive', 'background', 'sorter', 'cache'];
/**
 * Where one request's time went, for its log line: waiting for a connection and a folder's lock, and talking IMAP; and for
 * a list, whether its rows came from the cache (`hit`), partly (`fill`) or from the server (`live`).
 */
interface Timing { wait: number; imap: number; cache?: 'hit' | 'fill' | 'live'; test: TestHooks }
/**
 * Local dev only (MAIL_ALLOW_INSECURE=1), from x-mail-test-* headers, for test/e2e-mail.mjs, and carried into the
 * background work a request starts: a pause in each of the sorter's steps (holding its lock), a smaller sorting budget
 * (and a smaller cache budget: new mail per sync, backfill step), the re-check started now, and one alarm run before the
 * request is answered.
 */
interface TestHooks { slowMs: number; cap: number | null; recheck: boolean; alarm: boolean }
const NO_TEST: TestHooks = { slowMs: 0, cap: null, recheck: false, alarm: false };
/** One alarm run's result, kept in memory for `GET /v1/mail/accounts/:id/debug/cache`. */
interface CacheLogEntry { at: string; ms: number; folders: string[]; errors: string[] }
const CACHE_LOG_KEEP = 20;
const timing = new AsyncLocalStorage<Timing | undefined>();

const IDLE_MS = 60_000;
const LOGIN_LIMIT = 10;
const LOGIN_WINDOW_MS = 15 * 60_000;
const MAX_MESSAGE_BYTES = 50 * 1024 * 1024;
/** A body (text/plain or text/html part) larger than this is not opened here. */
const MAX_TEXT_BYTES = 10 * 1024 * 1024;
/** Fetched with the bodies: inline pictures up to 2 MB, any other part up to 64 KB, 8 MB in all. */
const PREFETCH = { inlineMax: 2 * 1024 * 1024, smallMax: 64 * 1024, total: 8 * 1024 * 1024 };
const FOLDER_TTL_MS = 5 * 60_000;
/** How often the newest cached INBOX messages are checked again against the server (Gmail re-sorting, mail moved elsewhere). */
const RECHECK_MS = 10 * 60_000;
/** How many of the newest cached messages the re-check looks at. */
const RECHECK_SPAN = 2000;
/** Older rows cached as "Gmail: no category" asked about again per re-check, while the repair runs (`repair_below`). */
const REPAIR_BATCH = 1000;
const DDL = [
  `CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, email TEXT NOT NULL, display_name TEXT NOT NULL, imap TEXT NOT NULL, smtp TEXT NOT NULL,
    secret BLOB NOT NULL, key_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ok', status_message TEXT, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS rate_limit_windows (key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL DEFAULT 1)`,
  // Inbox tabs: each INBOX message's tab (Gmail's category, or by its headers elsewhere), kept per UIDVALIDITY so no
  // list page asks the server twice; and the tab the user chose for a sender ("Move to tab").
  `CREATE TABLE IF NOT EXISTS mail_categories (account_id TEXT NOT NULL, folder TEXT NOT NULL, uid_validity TEXT NOT NULL, uid INTEGER NOT NULL,
    sender TEXT NOT NULL, from_name TEXT NOT NULL, subject TEXT NOT NULL, date INTEGER NOT NULL, category TEXT NOT NULL, reason TEXT NOT NULL,
    PRIMARY KEY (account_id, folder, uid_validity, uid))`,
  `CREATE TABLE IF NOT EXISTS mail_category_overrides (account_id TEXT NOT NULL, sender TEXT NOT NULL, category TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (account_id, sender))`,
  // How far mail_categories reaches per folder (SyncState): `high` is the newest UID sorted, the high-water mark.
  `CREATE TABLE IF NOT EXISTS mail_sync (account_id TEXT NOT NULL, folder TEXT NOT NULL, uid_validity TEXT NOT NULL, high INTEGER NOT NULL, low INTEGER NOT NULL,
    checked_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (account_id, folder))`,
];
/**
 * Columns added after the first release, each added once (ALTER fails when the column is already there), with what runs
 * once after it is added.
 */
const ADDED_COLUMNS: { add: string; then?: string }[] = [
  { add: `ALTER TABLE accounts ADD COLUMN tabs TEXT NOT NULL DEFAULT '[]'` },
  // The hosted mailbox (phase 5.3) beside the accounts the person connected.
  { add: `ALTER TABLE accounts ADD COLUMN kind TEXT NOT NULL DEFAULT 'connected'` },
  // The repair of Gmail rows wrongly cached as Primary (a re-check that read an incomplete or refused category search as
  // "no category"): every folder with such rows is re-checked on its next list, and its older such rows are asked about
  // again, a batch per re-check, from the top down (`repair_below`, 0 when there is nothing to repair).
  {
    add: `ALTER TABLE mail_sync ADD COLUMN repair_below INTEGER NOT NULL DEFAULT 0`,
    then: `UPDATE mail_sync SET checked_at = 0, repair_below = high + 1 WHERE EXISTS (SELECT 1 FROM mail_categories c WHERE c.account_id = mail_sync.account_id
      AND c.folder = mail_sync.folder AND c.uid_validity = mail_sync.uid_validity AND c.reason = '${GMAIL_NONE}')`,
  },
];
/** Every table of the object (DDL above, cache.ts's), for the move between objects (`exportRows`, `importRows`). */
export const MAIL_TABLES = ['accounts', 'rate_limit_windows', 'mail_categories', 'mail_category_overrides', 'mail_sync', 'mail_messages', 'mail_cache_folders', 'mail_state', 'mail_refs', 'mail_thread_index', 'mail_contacts'] as const;
/** New mail sorted into tabs by a list request at most (above the high-water mark); the rest is the sorter's. */
const SYNC_CAP = 100;
/** Older mail sorted per step of the background sorter, each step under the sorter's lock by itself. */
const SORT_BATCH = 300;
/** Messages sorted per background run at most; the next list page that needs more starts another. */
const SORT_RUN_CAP = 3000;
/** How many pages past the one asked for the sorter has cached, so scrolling on does not wait for it. */
const SORT_AHEAD_PAGES = 2;
const INBOX = 'INBOX';

type Failure = { code: 'auth_failed' | 'connect_failed'; message: string };
const SUMMARY_QUERY: FetchQueryObject = { uid: true, envelope: true, flags: true, bodyStructure: true, size: true, internalDate: true };
/** The headers kept for postal-mime when a message is opened by its parts: what MessageDetail needs beyond the envelope. */
const DETAIL_HEADERS = ['from', 'reply-to', 'bcc', 'in-reply-to', 'references'];
/** The headers a cached row keeps: DETAIL_HEADERS (to open the message by its parts later) and what threading reads. */
const CACHE_HEADERS = [...DETAIL_HEADERS, 'list-id'];
/**
 * What a list fetches, and the cache keeps: the summary's fields, the few headers above, and the server's own message and
 * thread ids where it has them (Gmail's X-GM-MSGID/X-GM-THRID, OBJECTID's; imapflow asks only servers that announce them).
 */
const CACHE_QUERY: FetchQueryObject = { ...SUMMARY_QUERY, threadId: true, headers: CACHE_HEADERS };

/** What an IMAP login or connection failure means to the client: 422, so it is never mistaken for the session expiring. */
function imapFailure(err: unknown): Failure {
  const e = err as { authenticationFailed?: boolean; responseText?: string; message?: string; code?: string };
  if (e.authenticationFailed) return { code: 'auth_failed', message: `The mail server refused the login${e.responseText ? `: ${e.responseText}` : ''}` };
  return { code: 'connect_failed', message: `Could not connect to the mail server: ${e.responseText || e.message || e.code || 'unknown error'}` };
}
function smtpFailure(err: unknown): Failure {
  const e = err as { code?: string; responseCode?: number; response?: string; message?: string };
  if (e.code === 'EAUTH' || e.responseCode === 535 || e.responseCode === 534) return { code: 'auth_failed', message: `The outgoing mail server refused the login${e.response ? `: ${e.response}` : ''}` };
  return { code: 'connect_failed', message: `Could not connect to the outgoing mail server: ${e.response || e.message || e.code || 'unknown error'}` };
}
const failed = (f: Failure) => mailError(422, f.code, f.message);
/** What a method the Calendar object calls answers: its result, or the error's status, code and message. */
export type CalendarAnswer<T> = ({ ok: true } & T) | { ok: false; status: number; code: string; message: string };
function answerOf(err: unknown): { ok: false; status: number; code: string; message: string } {
  if (err instanceof ApiError) return { ok: false, status: err.statusCode, code: err.code, message: err.message };
  return { ok: false, status: 502, code: 'server_error', message: (err as Error)?.message?.slice(0, 300) || 'the mail server failed' };
}
/** The largest invitation part read for the Calendar object. */
const MAX_INVITE_BYTES = 1024 * 1024;

/** An IMAP command's refusal, once connected: a missing folder is `not_found`, anything else the server said no to `bad_request`. */
function commandError(err: unknown): unknown {
  if (err instanceof ApiError) return err;
  const e = err as { mailboxMissing?: boolean; serverResponseCode?: string; responseStatus?: string; responseText?: string; code?: string };
  if (e.mailboxMissing || e.serverResponseCode === 'NONEXISTENT' || e.serverResponseCode === 'TRYCREATE' || e.code === 'NotFound') return notFound(e.responseText || 'no such folder');
  if (e.responseStatus === 'NO' || e.responseStatus === 'BAD') return badRequest(e.responseText || 'the mail server refused the request');
  return err;
}
const dropped = (err: unknown) => ['NoConnection', 'EConnectionClosed', 'StateLogout'].includes((err as { code?: string }).code ?? '');

function imapOptions(s: ServerSettings, user: string, pass: string) {
  return {
    host: s.host, port: s.port, secure: s.security === 'tls', doSTARTTLS: s.security === 'starttls' ? true : s.security === 'none' ? false : undefined,
    auth: { user, pass }, logger: false as const, transport: createSocketsTransport(connect as never), disableAutoIdle: true,
    connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 5 * 60_000, clientInfo: { name: 'FreeFlow Mail' },
  };
}
function smtpTransport(s: ServerSettings, user: string, pass: string) {
  return nodemailer.createTransport({
    host: s.host, port: s.port, secure: s.security === 'tls', requireTLS: s.security === 'starttls', ignoreTLS: s.security === 'none',
    auth: { user, pass }, connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 60_000, logger: false,
  });
}

async function streamBytes(stream: AsyncIterable<Uint8Array>, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > max) throw mailError(413, 'bad_request', 'the message is too large to open here');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/** A BODY[...] section of a FETCH answer (imapflow keys them in lower case). */
const section = (m: FetchMessageObject | false | undefined, key: string) => (m ? m.bodyParts?.get(key.toLowerCase()) ?? m.bodyParts?.get(key) : undefined);
/**
 * Why a cached message is in its tab, for `MessageSummary.categoryReason`: the user's choice for its sender
 * (`sender moved to <category>`), else the stored reason ("Gmail category:updates", "Gmail: no category", or the header
 * rule's, such as "newsletter (List-Id, List-Unsubscribe)").
 */
const reasonOf = (stored: string, chosen: string | null | undefined): string => (chosen ? `sender moved to ${chosen}` : stored);
/** The connection as the Gmail category searches (gmailTabs.ts) use it. */
const searcher = (c: ImapFlow): GmailSearcher => ({ search: (query, options) => c.search(query, options) });
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type MailContext = Context<{ Variables: { account: AccountRow } }>;

export class Mail extends DurableObject<MailEnv> {
  private readonly sql: SqlStorage;
  private readonly app = new Hono<{ Bindings: ObjectBindings; Variables: { account: AccountRow } }>();
  /** The open connections, `<account>/<kind>`, as the promise of each, so two requests at once share one login. */
  private readonly conns = new Map<string, Promise<ImapFlow>>();
  private readonly users = new Map<string, number>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly folderLists = new Map<string, { at: number; list: ListResponse[] }>();
  /** The last few messages opened, so a message's inline images do not each fetch it again. */
  private readonly opened = new Map<string, Opened>();
  /** Accounts whose INBOX is being re-checked in the background. */
  private readonly rechecking = new Set<string>();
  /** The background sorting runs going, `<account>/<folder>`, each with the latest target asked of it. */
  private readonly sorting = new Map<string, { target: SortTarget }>();
  /** The last sorting and re-check results per account, for the debug route (memory only: gone when the object sleeps). */
  private readonly tabLog = new Map<string, TabLogEntry[]>();
  /** The prefetch cache (cache.ts): its tables and the rules around them. */
  private readonly cache: MailCache;
  /** Whether an alarm run is going (one at a time; a request's test hook or an alarm that fires meanwhile waits for none). */
  private caching = false;
  /** The last alarm runs, for the debug route (memory only). */
  private readonly cacheLog: CacheLogEntry[] = [];
  /** When `last_active_at` was last written (written at most every 10 s). */
  private lastTouch = 0;
  /** Accounts whose conversation bodies are being read in the background (`fetchBodiesSoon`). */
  private readonly fetchingBodies = new Set<string>();

  constructor(ctx: DurableObjectState, env: MailEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    for (const statement of DDL) this.sql.exec(statement);
    for (const { add, then } of ADDED_COLUMNS) {
      try { this.sql.exec(add); } catch { continue; /* already added */ }
      if (then) this.sql.exec(then);
    }
    this.cache = new MailCache(this.sql);
    this.cache.init();
    this.routes();
  }

  /**
   * A request from routes/mail.ts (or Docs' tools, a preview), for the account this object belongs to, with the caller
   * context (`c.env.caller` to the routes); a caller of another account is refused. Where its time went (waiting for a
   * connection and a folder's lock, and talking IMAP) goes back in an `x-mail-timing` header, which routes/mail.ts logs
   * and takes off: a line logged here would reach `wrangler tail` late or not at all, as the object's open IMAP sockets
   * keep each request's tail event open (until the next request comes, or the socket closes).
   */
  async handle(request: Request, caller: CallerContext): Promise<Response> {
    const wrong = ownerMismatch(this.cache, caller, 'the Mail');
    if (wrong) { console.error(`[mail] ${wrong}`); return ownerRefusal(wrong); }
    const t: Timing = { wait: 0, imap: 0, test: NO_TEST };
    // Local dev only: a pause where sorting runs (holding the background lock), a smaller sorting budget, and the re-check now.
    if (this.allowInsecure) {
      const h = request.headers;
      t.test = { slowMs: Math.min(10_000, Number(h.get('x-mail-test-slow-ms')) || 0), cap: Number(h.get('x-mail-test-classify-cap')) || null, recheck: h.get('x-mail-test-recheck') === '1', alarm: h.get('x-mail-test-alarm') === '1' };
    }
    const res = await timing.run(t, async () => {
      // The test hook: one alarm run first, so the request that follows sees the cache as the alarm leaves it.
      if (t.test.alarm) await this.runCache(Date.now() + ALARM_BUDGET_MS).catch((err) => console.warn(`[mail] test alarm: ${(err as Error).message}`));
      return this.app.fetch(request, { caller } satisfies ObjectBindings);
    });
    this.touch();
    await this.armAlarm().catch((err) => console.warn(`[mail] alarm: ${(err as Error).message}`));
    const out = new Response(res.body, res);
    out.headers.set(TIMING_HEADER, `wait=${Math.round(t.wait)};imap=${Math.round(t.imap)}${t.cache ? `;cache=${t.cache}` : ''}`);
    return out;
  }

  /** A page of every table's rows (or the one named), for the move to the per-account objects (routes/admin.ts). */
  exportRows(opts: { table?: string; offset?: number; limit?: number } = {}): { table: string; rows: ImportRow[] }[] {
    return exportTables(this.sql, MAIL_TABLES, opts);
  }

  /** Rows from another Mail object, keeping any already here; never the owner keys (perAccount.ts). */
  importRows(table: string, rows: ImportRow[]): { added: number } {
    return importTable(this.sql, MAIL_TABLES, 'mail_state', table, rows);
  }

  // ---- accounts -------------------------------------------------------------------------------------------------

  private get allowInsecure() { return this.env.MAIL_ALLOW_INSECURE === '1'; }

  private row(id: string): AccountRow {
    const row = this.sql.exec<AccountRow & Record<string, SqlStorageValue>>('SELECT * FROM accounts WHERE id = ?', id).toArray()[0];
    if (!row) throw notFound('no such mail account');
    return row;
  }

  private toAccount(r: AccountRow): Account {
    return { id: r.id, kind: r.kind === 'hosted' ? 'hosted' : 'connected', email: r.email, displayName: r.display_name, imap: JSON.parse(r.imap), smtp: JSON.parse(r.smtp), status: r.status as Account['status'], ...(r.status_message ? { statusMessage: r.status_message } : {}), tabs: this.tabsOf(r) };
  }

  private tabsOf(r: AccountRow): TabCategory[] {
    try { return normalizeTabs(JSON.parse(r.tabs || '[]') as string[]); } catch { return []; }
  }

  private password(r: AccountRow): string {
    return decryptBlob(Buffer.from(r.secret), r.key_id).toString('utf8');
  }

  private setStatus(id: string, status: Account['status'], message: string | null): void {
    this.sql.exec('UPDATE accounts SET status = ?, status_message = ? WHERE id = ? AND (status != ? OR status_message IS NOT ?)', status, message, id, status, message);
  }

  /** The Directory's fixed window, per person here since the object is theirs. True when the attempt is allowed. */
  private rateAllow(key: string, limit: number, windowMs: number): boolean {
    const now = Date.now();
    const row = this.sql.exec<{ count: number }>(
      `INSERT INTO rate_limit_windows (key, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT (key) DO UPDATE SET
         count = CASE WHEN window_start <= ? THEN 1 ELSE count + 1 END,
         window_start = CASE WHEN window_start <= ? THEN ? ELSE window_start END
       RETURNING count`, key, now, now - windowMs, now - windowMs, now).toArray()[0];
    return !row || row.count <= limit;
  }

  /** Logs in to both servers before anything is saved, so a saved account is one that worked. */
  private async verify(email: string, imap: ServerSettings, smtp: ServerSettings, password: string): Promise<void> {
    checkServer('imap', imap, this.allowInsecure);
    checkServer('smtp', smtp, this.allowInsecure);
    if (!this.rateAllow('login', LOGIN_LIMIT, LOGIN_WINDOW_MS)) throw mailError(429, 'rate_limited', 'Too many sign-in attempts; try again in a few minutes');
    const imapCheck = (async () => {
      const client = new ImapFlow(imapOptions(imap, imap.username || email, password));
      client.on('error', () => {});
      try { await client.connect(); } catch (err) { throw failed(imapFailure(err)); }
      await client.logout().catch(() => {});
    })();
    const smtpCheck = (async () => {
      const transport = smtpTransport(smtp, smtp.username || email, password);
      try { await transport.verify(); } catch (err) { throw failed(smtpFailure(err)); } finally { transport.close(); }
    })();
    const [a, b] = await Promise.allSettled([imapCheck, smtpCheck]);
    if (a.status === 'rejected') throw a.reason;
    if (b.status === 'rejected') throw b.reason;
  }

  private forget(id: string): void {
    for (const kind of KINDS) this.closeNow(`${id}/${kind}`);
    this.folderLists.delete(id);
    for (const key of [...this.opened.keys()]) if (key.startsWith(`${id}/`)) this.opened.delete(key);
  }

  // ---- the IMAP connections ----------------------------------------------------------------------------------------

  private open(r: AccountRow, key: string): Promise<ImapFlow> {
    const imap = JSON.parse(r.imap) as ServerSettings;
    const client = new ImapFlow(imapOptions(imap, imap.username || r.email, this.password(r)));
    client.on('error', (err: Error) => console.warn(`[mail] imap ${key}: ${err.message}`));
    client.on('close', () => { if (this.conns.get(key) === pending) this.conns.delete(key); });
    const pending = client.connect().then(() => {
      this.setStatus(r.id, 'ok', null);
      return client;
    }, (err) => {
      if (this.conns.get(key) === pending) this.conns.delete(key);
      const f = imapFailure(err);
      this.setStatus(r.id, f.code, f.message);
      throw failed(f);
    });
    this.conns.set(key, pending);
    return pending;
  }

  private async client(r: AccountRow, key: string): Promise<ImapFlow> {
    const have = this.conns.get(key);
    if (have) {
      const c = await have.catch(() => null);
      if (c?.usable) return c;
      if (this.conns.get(key) === have) this.conns.delete(key);
    }
    return this.conns.get(key) ?? this.open(r, key);
  }

  /** Runs `fn` on one of the account's connections, once more on a fresh one if that connection had dropped. */
  private async withImap<T>(r: AccountRow, kind: Kind, fn: (c: ImapFlow) => Promise<T>): Promise<T> {
    const key = `${r.id}/${kind}`;
    const t = timing.getStore();
    clearTimeout(this.timers.get(key));
    this.users.set(key, (this.users.get(key) ?? 0) + 1);
    try {
      for (let attempt = 0; ; attempt++) {
        const waited = Date.now();
        const c = await this.client(r, key);
        if (t) t.wait += Date.now() - waited;
        const started = Date.now(), waitBefore = t?.wait ?? 0;
        try {
          return await fn(c);
        } catch (err) {
          if (attempt === 0 && (dropped(err) || !c.usable)) { this.conns.delete(key); continue; }
          throw commandError(err);
        } finally {
          // The time in `fn`, less what it spent waiting for a folder's lock (counted as waiting).
          if (t) t.imap += Date.now() - started - (t.wait - waitBefore);
        }
      }
    } finally {
      const left = (this.users.get(key) ?? 1) - 1;
      this.users.set(key, left);
      if (left === 0) this.timers.set(key, setTimeout(() => this.closeIdle(key), IDLE_MS));
    }
  }

  private closeIdle(key: string): void {
    if (this.users.get(key)) return;
    this.closeNow(key);
  }

  /** Logs a connection out now (the account is forgotten, or the alarm is done and the person is away). */
  private closeNow(key: string): void {
    const conn = this.conns.get(key);
    this.conns.delete(key);
    clearTimeout(this.timers.get(key));
    this.timers.delete(key);
    void conn?.then((c) => c.logout()).catch(() => {});
  }

  /** Holds `folder`'s lock on that connection while `fn` runs. */
  private async locked<T>(c: ImapFlow, folder: string, fn: () => Promise<T>): Promise<T> {
    const t = timing.getStore();
    const waited = Date.now();
    const lock = await c.getMailboxLock(folder);
    if (t) t.wait += Date.now() - waited;
    try { return await fn(); } finally { lock.release(); }
  }

  private withFolder<T>(r: AccountRow, folder: string, kind: Kind, fn: (c: ImapFlow) => Promise<T>): Promise<T> {
    return this.withImap(r, kind, (c) => this.locked(c, folder, () => fn(c)));
  }

  private async folderList(r: AccountRow, c: ImapFlow, fresh = false): Promise<ListResponse[]> {
    const cached = this.folderLists.get(r.id);
    if (!fresh && cached && Date.now() - cached.at < FOLDER_TTL_MS) return cached.list;
    const list = await c.list();
    this.folderLists.set(r.id, { at: Date.now(), list });
    return list;
  }

  private async special(r: AccountRow, c: ImapFlow, use: SpecialUse): Promise<string | null> {
    return (await this.folderList(r, c)).find((f) => specialUseOf(f) === use && !f.flags.has('\\Noselect'))?.path ?? null;
  }

  /** The test hook (MAIL_ALLOW_INSECURE only): a pause in a step of the sorter's, holding its lock. */
  private async testSlow(): Promise<void> {
    const ms = timing.getStore()?.test.slowMs ?? 0;
    if (ms > 0) await sleep(ms);
  }

  /** A sorting budget (SYNC_CAP, SORT_BATCH), unless the test hook lowers it. */
  private budget(n: number): number {
    return timing.getStore()?.test.cap ?? n;
  }

  /**
   * Runs `fn` after the request, not as part of it (`ctx.waitUntil`, never awaited): its time is not the request's, it
   * keeps the request's test hooks, and it logs one line when done (what it did, no ids or content).
   */
  private background(name: string, fn: () => Promise<string>): void {
    const t: Timing = { wait: 0, imap: 0, test: timing.getStore()?.test ?? NO_TEST };
    const start = Date.now();
    const job = timing.run(t, fn).then(
      (what) => console.log(`[mail] ${name}: ${what} ${Date.now() - start}ms (lock wait ${Math.round(t.wait)}ms, imap ${Math.round(t.imap)}ms)`),
      (err) => console.warn(`[mail] ${name} failed after ${Date.now() - start}ms: ${(err as Error).message}`),
    );
    this.ctx.waitUntil(job);
  }

  // ---- messages ---------------------------------------------------------------------------------------------------

  /** The first characters of each message's text, from one partial FETCH per distinct text part number. */
  private async snippets(c: ImapFlow, messages: FetchMessageObject[]): Promise<Map<number, string>> {
    const out = new Map<number, string>();
    const groups = new Map<string, { uids: number[]; parts: Map<number, TextPart> }>();
    for (const m of messages) {
      const part = textPartOf(m.bodyStructure);
      if (!part) continue;
      const g = groups.get(part.part) ?? { uids: [] as number[], parts: new Map<number, TextPart>() };
      g.uids.push(m.uid);
      g.parts.set(m.uid, part);
      groups.set(part.part, g);
    }
    for (const [key, g] of groups) {
      const html = [...g.parts.values()].some((p) => p?.type === 'text/html');
      for await (const m of c.fetch(g.uids.join(','), { uid: true, bodyParts: [{ key, start: 0, maxLength: html ? 2048 : 600 }] }, { uid: true })) {
        const bytes = m.bodyParts?.values().next().value;
        const part = g.parts.get(m.uid);
        if (bytes && part) out.set(m.uid, snippetOf(bytes, part));
      }
    }
    return out;
  }

  /**
   * One page of a folder, newest first. `q` searches the whole folder (TEXT, FROM or SUBJECT); with `opts.raw` on a Gmail
   * account it is Gmail's own search syntax (X-GM-RAW). `opts.unread` keeps only unread messages.
   */
  private async list(r: AccountRow, folder: string, limit: number, before: number | null, q: string, category: Category | null = null, opts: { raw?: boolean; unread?: boolean } = {}): Promise<MessagePage> {
    const tabs = folder.toUpperCase() === INBOX ? this.tabsOf(r) : [];
    const unread = !!opts.unread;
    // A search covers the whole folder, as Gmail's does; and with tabs off there is only the one list.
    if (category && !q && !unread && tabs.length) return this.tabList(r, folder, tabs, category, limit, before);
    // A plain page of the folder: from the prefetch cache.
    if (!q && !unread) return this.cachedList(r, folder, tabs, limit, before);
    return this.withFolder(r, folder, 'background', async (c) => {
      const box = c.mailbox;
      const exists = box ? box.exists : 0;
      if (!exists || (before !== null && before <= 1)) return { messages: [], next: null };
      const fetched: FetchMessageObject[] = [];
      const gmail = tabs.length > 0 && this.isGmail(r, c);
      const range: SearchObject = { ...(before !== null ? { uid: `1:${before - 1}` } : {}), ...(unread ? { seen: false } : {}) };
      const gmailRaw = !!q && !!opts.raw && c.capabilities.has('X-GM-EXT-1');
      // TEXT already covers the headers; some servers (GreenMail) refuse FROM with a space in it, and then TEXT alone does.
      let found = gmailRaw
        ? await c.search({ ...range, gmraw: q }, { uid: true })
        : q
          ? await c.search({ ...range, or: [{ text: q }, { from: q }, { subject: q }] }, { uid: true })
          : await c.search(Object.keys(range).length ? range : { all: true }, { uid: true });
      if (found === false && gmailRaw) throw badRequest('Gmail refused the search: check its syntax');
      if (found === false && q) found = await c.search({ ...range, text: q }, { uid: true });
      if (found === false) throw badRequest('the mail server refused the search');
      found = (found ?? []).sort((a, b) => a - b);
      const more = found.length > limit;
      const page = found.slice(-limit);
      if (page.length) for await (const m of c.fetch(page.join(','), this.listQuery(tabs, gmail), { uid: true })) fetched.push(m);
      fetched.sort((a, b) => b.uid - a.uid);
      const { messages } = await this.summarize(r, c, folder, tabs, gmail, fetched);
      return { messages, next: more && messages.length ? messages[messages.length - 1].uid : null };
    });
  }

  /** What a list fetches: with tabs on, on a server that is not Gmail, the headers the tab rules read as well. */
  private listQuery(tabs: TabCategory[], gmail: boolean): FetchQueryObject {
    return tabs.length && !gmail ? { ...CACHE_QUERY, headers: [...CACHE_HEADERS, ...CATEGORY_HEADERS] } : CACHE_QUERY;
  }

  /** Fetched messages as a list shows them (with their snippets, and their tabs when the folder has them), newest first. */
  private async summarize(r: AccountRow, c: ImapFlow, folder: string, tabs: TabCategory[], gmail: boolean, fetched: FetchMessageObject[]): Promise<{ messages: MessageSummary[]; snippets: Map<number, string> }> {
    const snippets = await this.snippets(c, fetched).catch((err) => { console.warn(`[mail] snippets: ${(err as Error).message}`); return new Map<number, string>(); });
    const summaries = fetched.map((m) => toSummary(m, folder, snippets.get(m.uid) ?? ''));
    const messages = tabs.length ? await this.withTabs(r, c, folder, tabs, gmail, summaries, new Map(fetched.map((m) => [m.uid, m]))) : summaries;
    return { messages, snippets };
  }

  /** Summaries with each one's tab and why (`categoriesOf`). */
  private async withTabs(r: AccountRow, c: ImapFlow, folder: string, tabs: TabCategory[], gmail: boolean, summaries: MessageSummary[], fetched: Map<number, FetchMessageObject>): Promise<MessageSummary[]> {
    const categories = await this.categoriesOf(r, c, folder, tabs, summaries.map((s) => s.uid), gmail, fetched);
    return summaries.map((s) => {
      const tab = categories.get(s.uid);
      return { ...s, category: tab?.category ?? 'primary', ...(tab?.reason ? { categoryReason: tab.reason } : {}) };
    });
  }

  // ---- the prefetch cache: lists ----------------------------------------------------------------------------------

  /**
   * One plain page of a folder, newest first, from the prefetch cache. The first page first asks the server for new mail
   * (`cacheNew`: one `UID SEARCH` above the high-water mark, and a FETCH of what is new), so it is never stale; then the
   * page is read from SQLite. Where the cache ends before the page is full (an older page, or a folder seen for the first
   * time), the rest comes from the server as it always did, and is cached on the way, so scrolling never waits for the
   * alarm. The page's flags are checked against the server in one small FETCH (mail read or starred elsewhere shows at
   * once), which also drops what has left the folder.
   */
  private async cachedList(r: AccountRow, folder: string, tabs: TabCategory[], limit: number, before: number | null): Promise<MessagePage> {
    const t = timing.getStore();
    return this.withImap(r, 'background', async (c) => {
      const wasOpen = c.mailbox && c.mailbox.path === folder;
      return this.locked(c, folder, async () => {
        if (!c.mailbox) return { messages: [], next: null };
        const gmail = tabs.length > 0 && this.isGmail(r, c);
        const validity = this.validity(c);
        const now = Date.now();
        let state = this.cache.touchFolder(r.id, folder, await this.kindOf(r, c, folder), now, true);
        if (state.validity !== validity) state = this.cache.resetFolder(r.id, folder, validity);
        // Synced by the alarm lately: the page as the cache stands, with no round trip (new mail and flags are the alarm's).
        const fresh = now - state.syncedAt < FRESH_MS;
        if (before === null && !fresh) {
          // A folder this connection already had open has not heard of new mail since (no IDLE): ask.
          if (wasOpen) await c.noop();
          await this.cacheNew(r, c, folder, state, this.budget(NEW_CAP));
          state = this.cache.folder(r.id, folder)!;
        }
        if (state.high === 0 || (before !== null && before <= 1)) { if (t) t.cache = 'hit'; return { messages: [], next: null }; }
        const cursor = before ?? Number.MAX_SAFE_INTEGER;
        const rows = cursor > state.low ? this.cache.page(r.id, folder, validity, cursor, state.low, limit + 1) : [];
        // More below: another cached row, or the folder reaching further down than the cache does.
        let more = rows.length > limit || state.low > 1;
        let messages = rows.slice(0, limit).map((row) => row.summary);
        const liveFetched = new Map<number, FetchMessageObject>();
        let kind: Timing['cache'] = 'hit';
        if (messages.length && !fresh) {
          // The page's flags as the server has them now; a message it no longer has (moved by another mail app) is dropped.
          const { changed, vanished } = await this.refreshFlags(r, c, folder, validity, messages.map((m) => m.uid), now, null);
          if (vanished.size) { messages = messages.filter((m) => !vanished.has(m.uid)); this.left(r.id, folder, [...vanished]); }
          if (changed.size) messages = messages.map((m) => { const f = changed.get(m.uid); return f ? { ...m, seen: f.seen, flagged: f.flagged, answered: f.answered } : m; });
        }
        if (messages.length < limit && state.low > 1) {
          // The cache ends before the page is full: the rest from the server, and cached on the way.
          const under = messages.length ? messages[messages.length - 1].uid : before;
          const live = await this.livePage(c, limit - messages.length, under, this.listQuery(tabs, gmail));
          for (const m of live.fetched) liveFetched.set(m.uid, m);
          const { summaries } = await this.cacheRows(r, c, folder, validity, live.fetched, now);
          // The page read from the cache ended at `low`, so what follows is adjacent to it: the cache now reaches that far.
          // (A page asked for from further down than the cache reaches is cached too, but leaves a gap for the backfill.)
          if (under === null || under >= state.low) this.cache.lowerLow(r.id, folder, validity, state.low, live.more ? (live.fetched[live.fetched.length - 1]?.uid ?? 1) : 1);
          kind = messages.length ? 'fill' : 'live';
          messages.push(...summaries);
          more = live.more;
        }
        if (t) t.cache = kind;
        if (tabs.length) messages = await this.withTabs(r, c, folder, tabs, gmail, messages, liveFetched);
        return { messages, next: more && messages.length ? messages[messages.length - 1].uid : null };
      });
    });
  }

  /**
   * The summaries of these UIDs of the open folder, for a page whose UIDs are already known (a tab's page): from the
   * cache where it has them, with their flags checked against the server in one FLAGS fetch; the rest fetched and cached
   * on the way. A UID the server no longer has is left out (and its rows dropped by the caller).
   */
  private async pageSummaries(r: AccountRow, c: ImapFlow, folder: string, validity: string, uids: number[], checkFlags = true): Promise<Map<number, MessageSummary>> {
    const t = timing.getStore();
    const out = new Map<number, MessageSummary>();
    if (!uids.length) return out;
    const now = Date.now();
    const cached = this.cache.byUids(r.id, folder, validity, uids);
    if (cached.size) {
      const { changed, vanished } = checkFlags ? await this.refreshFlags(r, c, folder, validity, [...cached.keys()], now, null) : { changed: new Map<number, Flags>(), vanished: new Set<number>() };
      for (const [uid, row] of cached) {
        if (vanished.has(uid)) continue;
        const f = changed.get(uid);
        out.set(uid, f ? { ...row.summary, seen: f.seen, flagged: f.flagged, answered: f.answered } : row.summary);
      }
    }
    const missing = uids.filter((u) => !cached.has(u));
    if (missing.length) {
      const { summaries } = await this.cacheFetch(r, c, folder, validity, missing, now);
      for (const s of summaries) out.set(s.uid, s);
    }
    if (t) t.cache = missing.length ? (cached.size ? 'fill' : 'live') : 'hit';
    return out;
  }

  /** One page straight from the server, newest first: the newest `limit` of the open folder, or those below `before`. */
  private async livePage(c: ImapFlow, limit: number, before: number | null, query: FetchQueryObject): Promise<{ fetched: FetchMessageObject[]; more: boolean }> {
    const exists = c.mailbox ? c.mailbox.exists : 0;
    const fetched: FetchMessageObject[] = [];
    if (!exists || (before !== null && before <= 1)) return { fetched, more: false };
    let more: boolean;
    if (before === null) {
      const start = Math.max(1, exists - limit + 1);
      more = start > 1;
      for await (const m of c.fetch(`${start}:${exists}`, query)) fetched.push(m);
    } else {
      const found = await c.search({ uid: `1:${before - 1}` }, { uid: true });
      if (found === false) throw badRequest('the mail server refused the search');
      const sorted = (found ?? []).filter((u) => u < before).sort((a, b) => a - b);
      more = sorted.length > limit;
      const page = sorted.slice(-limit);
      if (page.length) for await (const m of c.fetch(uidSet(page), query, { uid: true })) fetched.push(m);
    }
    fetched.sort((a, b) => b.uid - a.uid);
    return { fetched, more };
  }

  // ---- inbox tabs: the cache ------------------------------------------------------------------------------------------

  private isGmail(r: AccountRow, c: ImapFlow): boolean {
    return isGmailHost((JSON.parse(r.imap) as ServerSettings).host) || c.capabilities.has('X-GM-EXT-1');
  }

  private overrides(accountId: string): Map<string, Category> {
    return new Map(this.sql.exec<{ sender: string; category: string }>('SELECT sender, category FROM mail_category_overrides WHERE account_id = ?', accountId).toArray().map((o) => [o.sender, o.category as Category]));
  }

  /** The tab a cached message shows in: the sender's chosen tab, else its own, and Primary for a tab that is off. */
  private tabOf(row: CategoryRow, overrides: Map<string, Category>, tabs: TabCategory[]): Category {
    return effective(overrides.get(row.sender) ?? (row.category as Category), tabs);
  }

  private validity(c: ImapFlow): string {
    return String(c.mailbox ? c.mailbox.uidValidity : 0);
  }

  /** The cached rows for some UIDs of the open folder. */
  private cachedRows(r: AccountRow, folder: string, validity: string, uids: number[]): Map<number, CategoryRow> {
    const out = new Map<number, CategoryRow>();
    for (let i = 0; i < uids.length; i += 5000) {
      const rows = this.sql.exec<CategoryRow & Record<string, SqlStorageValue>>(
        'SELECT uid, sender, from_name, subject, date, category, reason FROM mail_categories WHERE account_id = ? AND folder = ? AND uid_validity = ? AND uid IN (SELECT value FROM json_each(?))',
        r.id, folder, validity, JSON.stringify(uids.slice(i, i + 5000))).toArray();
      for (const row of rows) out.set(row.uid, { ...row });
    }
    return out;
  }

  /** Which of these UIDs have a row. */
  private cachedUids(r: AccountRow, folder: string, validity: string, uids: number[]): Set<number> {
    const out = new Set<number>();
    for (let i = 0; i < uids.length; i += 5000) {
      for (const row of this.sql.exec<{ uid: number }>('SELECT uid FROM mail_categories WHERE account_id = ? AND folder = ? AND uid_validity = ? AND uid IN (SELECT value FROM json_each(?))',
        r.id, folder, validity, JSON.stringify(uids.slice(i, i + 5000))).toArray()) out.add(row.uid);
    }
    return out;
  }

  private store(r: AccountRow, folder: string, validity: string, row: CategoryRow): CategoryRow {
    this.sql.exec('INSERT OR REPLACE INTO mail_categories (account_id, folder, uid_validity, uid, sender, from_name, subject, date, category, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      r.id, folder, validity, row.uid, row.sender, row.from_name, row.subject, row.date, row.category, row.reason);
    return row;
  }

  /** The row of a fetched message (envelope and internalDate), with its tab. */
  private rowOf(m: FetchMessageObject, category: Category, reason: string): CategoryRow {
    const from = m.envelope?.from?.[0] ?? m.envelope?.sender?.[0];
    return {
      uid: m.uid, sender: (from?.address ?? '').toLowerCase(), from_name: from?.name ?? '', subject: m.envelope?.subject ?? '',
      date: new Date(m.internalDate ?? m.envelope?.date ?? 0).getTime() || 0, category, reason,
    };
  }

  /** Classifies a fetched message by its headers (it must have been fetched with envelope and CATEGORY_HEADERS) and caches it. */
  private remember(r: AccountRow, folder: string, validity: string, m: FetchMessageObject): CategoryRow {
    const { category, reason } = classifyHeaders(parseHeaders(m.headers));
    return this.store(r, folder, validity, this.rowOf(m, category, reason));
  }

  /**
   * Sorts these UIDs of the open folder into tabs and caches them, newest first. Gmail: its own categories, the four
   * X-GM-RAW searches over the batch's range (`sortBatch`, which asks again UID by UID when a large batch gets nothing back),
   * then one envelope FETCH for the sender, subject and date. Elsewhere: one FETCH of the envelope and the few headers the
   * rules read. In batches, so each command stays short. A Gmail search that fails or is refused stores nothing of its batch
   * and stops there (`failedAt`, the newest UID not sorted), so that mail is sorted again later rather than put in Primary.
   */
  private async classify(r: AccountRow, c: ImapFlow, folder: string, validity: string, uids: number[], gmail: boolean, into?: Map<number, CategoryRow>): Promise<{ stored: number; failedAt: number | null }> {
    if (!uids.length) return { stored: 0, failedAt: null };
    const size = gmail ? 250 : 100;
    const sorted = [...uids].sort((a, b) => b - a);
    const log: TabLogEntry = { at: new Date().toISOString(), kind: 'sort', checked: 0, categorized: 0, primary: 0, skipped: 0, confirmed: 0, errors: [] };
    let stored = 0, failedAt: number | null = null;
    for (let i = 0; i < sorted.length; i += size) {
      const batch = sorted.slice(i, i + size);
      if (gmail) {
        log.checked += batch.length;
        let natural: Map<number, TabCategory>;
        try {
          const got = await sortBatch(searcher(c), batch);
          natural = got.tabs;
          if (got.confirmed) log.confirmed!++;
        } catch (err) {
          if (!(err instanceof GmailSearchError)) throw err;
          console.warn(`[mail] sort: ${err.message}; ${sorted.length - i} left unsorted`);
          log.errors.push(err.message);
          log.skipped = sorted.length - i;
          failedAt = batch[0];
          break;
        }
        for await (const m of c.fetch(uidSet(batch), { uid: true, envelope: true, internalDate: true }, { uid: true })) {
          const tab = natural.get(m.uid);
          const row = this.store(r, folder, validity, this.rowOf(m, tab ?? 'primary', tab ? GMAIL_REASON(tab) : GMAIL_NONE));
          into?.set(m.uid, row);
          stored++;
          if (tab) log.categorized!++;
          else log.primary!++;
        }
      } else {
        for await (const m of c.fetch(uidSet(batch), { uid: true, envelope: true, internalDate: true, headers: CATEGORY_HEADERS }, { uid: true })) {
          const row = this.remember(r, folder, validity, m);
          into?.set(m.uid, row);
          stored++;
        }
      }
    }
    if (gmail) this.logTabs(r.id, log);
    return { stored, failedAt };
  }

  /** Keeps a sorting or re-check result for the debug route: the last TAB_LOG_KEEP of each kind per account. */
  private logTabs(accountId: string, entry: TabLogEntry): void {
    const list = this.tabLog.get(accountId) ?? [];
    list.push(entry);
    const ofKind = list.filter((e) => e.kind === entry.kind);
    if (ofKind.length > TAB_LOG_KEEP) list.splice(list.indexOf(ofKind[0]), 1);
    this.tabLog.set(accountId, list);
  }

  private syncState(r: AccountRow, folder: string): SyncState | null {
    const row = this.sql.exec<{ uid_validity: string; high: number; low: number; checked_at: number; repair_below: number }>(
      'SELECT uid_validity, high, low, checked_at, repair_below FROM mail_sync WHERE account_id = ? AND folder = ?', r.id, folder).toArray()[0];
    return row ? { validity: row.uid_validity, high: row.high, low: row.low, checkedAt: row.checked_at, repairBelow: row.repair_below } : null;
  }

  private saveSync(r: AccountRow, folder: string, s: Omit<SyncState, 'repairBelow'>): void {
    this.sql.exec('INSERT OR REPLACE INTO mail_sync (account_id, folder, uid_validity, high, low, checked_at) VALUES (?, ?, ?, ?, ?, ?)', r.id, folder, s.validity, s.high, s.low, s.checkedAt);
  }

  /**
   * Walks `desc` (UIDs, newest first) sorting the ones not cached yet, at most `budget` of them. Returns how far it got:
   * the last UID looked at (every UID of `desc` down to it is cached; 0 when not even the first), and whether that was all
   * of them. `failed`: a Gmail search failed, and the walk stopped before the batch it was for.
   */
  private async sortDown(r: AccountRow, c: ImapFlow, folder: string, validity: string, desc: number[], budget: number, gmail: boolean): Promise<{ last: number; done: boolean; sorted: number; failed: boolean }> {
    if (!desc.length) return { last: 0, done: true, sorted: 0, failed: false };
    const have = this.cachedUids(r, folder, validity, desc);
    const todo: number[] = [];
    let i = 0;
    for (; i < desc.length; i++) {
      if (have.has(desc[i])) continue;
      if (todo.length >= budget) break;
      todo.push(desc[i]);
    }
    const got = await this.classify(r, c, folder, validity, todo, gmail);
    if (got.failedAt !== null) {
      const j = desc.indexOf(got.failedAt);
      return { last: j > 0 ? desc[j - 1] : 0, done: false, sorted: got.stored, failed: true };
    }
    return i >= desc.length ? { last: desc[desc.length - 1], done: true, sorted: todo.length, failed: false } : { last: desc[i - 1], done: false, sorted: todo.length, failed: false };
  }

  /**
   * The UIDs of the open folder below `top`, newest first: at least `want` of them when the folder has that many. From a
   * UID window that widens as needed (`UID SEARCH <from>:<top-1>`), so a large folder is never listed whole. `from` is
   * where the window began: every UID in [from, top) is in `uids`, and 1 means all of them.
   */
  private async uidsBelow(c: ImapFlow, top: number, want: number): Promise<{ uids: number[]; from: number }> {
    if (top <= 1) return { uids: [], from: 1 };
    for (let span = Math.max(1000, want * 4); ; span *= 4) {
      const from = span >= top - 1 ? 1 : top - span;
      const got = await c.search({ uid: `${from}:${top - 1}` }, { uid: true });
      // A refused search is not an empty window (that would read as "no older mail").
      if (!Array.isArray(got)) throw badRequest('the mail server refused the search');
      const found = got.filter((u) => u >= from && u < top).sort((a, b) => b - a);
      if (found.length >= want || from === 1) return { uids: found, from };
    }
  }

  /**
   * Brings the cache of the open folder up to date with new mail, cheaply, before a list page: only the UIDs above the
   * high-water mark are asked about (`UID SEARCH <high+1>:*`), and at most SYNC_CAP of them, the newest, are sorted here.
   * The first time, the newest SYNC_CAP messages are, found from UIDNEXT down (`uidsBelow`). More new mail than that: `low`
   * moves up to what was sorted, and the rest is the background sorter's. Mail that left the folder and Gmail's re-sorting
   * are the re-check's. Returns the state as saved.
   */
  private async sync(r: AccountRow, c: ImapFlow, folder: string, gmail: boolean): Promise<SyncState> {
    const validity = this.validity(c);
    const state = this.syncState(r, folder);
    const cap = this.budget(SYNC_CAP);
    if (!state || state.validity !== validity || state.high === 0) {
      // The first time, or a new UIDVALIDITY (every UID means something else now).
      this.sql.exec('DELETE FROM mail_categories WHERE account_id = ? AND folder = ? AND uid_validity != ?', r.id, folder, validity);
      const top = Number(c.mailbox ? c.mailbox.uidNext : 0) || 0;
      const { uids, from } = top > 1 ? await this.uidsBelow(c, top, cap) : { uids: ((await c.search({ all: true }, { uid: true })) || []).sort((a, b) => b - a), from: 1 };
      const got = await this.sortDown(r, c, folder, validity, uids, cap, gmail);
      // Not one message sorted (Gmail's search failed): nothing is saved, and the next list tries again.
      if (got.failed && !got.last) throw mailError(503, 'unavailable', 'Gmail did not answer the inbox tabs search; try again in a moment');
      this.saveSync(r, folder, { validity, high: uids[0] ?? 0, low: uids.length ? (got.done ? from : got.last) : 0, checkedAt: Date.now() });
    } else {
      const fresh = ((await c.search({ uid: `${state.high + 1}:*` }, { uid: true })) || []).filter((u) => u > state.high).sort((a, b) => b - a);
      if (fresh.length) {
        const got = await this.sortDown(r, c, folder, validity, fresh, cap, gmail);
        // Nothing sorted (Gmail's search failed): the state stays, and the next list asks about the same new mail again.
        if (got.failed && !got.last) return state;
        // Only `high`, unless new mail was left unsorted: then the cache reaches down from the newest again (`low` up to the
        // last sorted), and the sorter fills in below. The sorter only ever lowers `low` from the value it read (`extendDown`).
        if (got.done) this.sql.exec('UPDATE mail_sync SET high = ? WHERE account_id = ? AND folder = ?', fresh[0], r.id, folder);
        else this.sql.exec('UPDATE mail_sync SET high = ?, low = ? WHERE account_id = ? AND folder = ?', fresh[0], got.last, r.id, folder);
      }
    }
    return this.syncState(r, folder)!;
  }

  /**
   * One step of the background sorter: the cache of the open folder extended below its `low`, at most `budget` messages
   * sorted. `low` is lowered only if nothing moved it meanwhile (new mail sorted past a gap moves it up, and what lies
   * between is not all cached); what was sorted stays cached either way. Returns how many it sorted, and `failed` when a
   * Gmail search failed (`low` then goes only as far as what was sorted before it, and the run stops).
   */
  private async extendDown(r: AccountRow, c: ImapFlow, folder: string, state: SyncState, budget: number, gmail: boolean): Promise<{ sorted: number; failed: boolean }> {
    if (state.low <= 1) return { sorted: 0, failed: false };
    const { uids, from } = await this.uidsBelow(c, state.low, budget);
    const got = await this.sortDown(r, c, folder, state.validity, uids, budget, gmail);
    const low = got.done ? from : got.last;
    if (low) this.sql.exec('UPDATE mail_sync SET low = ? WHERE account_id = ? AND folder = ? AND uid_validity = ? AND low = ?', low, r.id, folder, state.validity, state.low);
    return { sorted: got.sorted, failed: got.failed };
  }

  /** Forgets cached rows (messages that left the folder). */
  private forgetRows(accountId: string, folder: string, uids: number[]): void {
    for (let i = 0; i < uids.length; i += 5000) {
      this.sql.exec('DELETE FROM mail_categories WHERE account_id = ? AND folder = ? AND uid IN (SELECT value FROM json_each(?))', accountId, folder, JSON.stringify(uids.slice(i, i + 5000)));
    }
  }

  /** How many of a tab's cached messages lie in [low, below), counted up to `max`. */
  private cachedInTab(r: AccountRow, folder: string, state: SyncState, tabs: TabCategory[], category: Category, below: number, max: number): number {
    const q = this.tabRows(tabs);
    return this.sql.exec<{ n: number }>(
      `SELECT COUNT(*) AS n FROM (SELECT 1 FROM ${q.from} WHERE c.account_id = ? AND c.folder = ? AND c.uid_validity = ? AND c.uid < ? AND c.uid >= ? AND ${q.tab} = ? LIMIT ?)`,
      r.id, folder, state.validity, below, Math.max(1, state.low), ...q.params, category, max).toArray()[0]?.n ?? 0;
  }

  /**
   * Sorts older mail into tabs in the background (`background`), on the sorter connection, so no list page waits for it:
   * SORT_BATCH messages a step, each step under the sorter's lock by itself, until the target is met (enough of the tab
   * cached for the pages to come), the whole folder is cached, or SORT_RUN_CAP messages were sorted in this run. A run
   * already going takes the newer target instead.
   */
  private sortSoon(r: AccountRow, folder: string, target: SortTarget): void {
    const key = `${r.id}/${folder}`;
    const running = this.sorting.get(key);
    if (running) {
      running.target = target;
      return;
    }
    const job = { target };
    this.sorting.set(key, job);
    this.background('sort', async () => {
      let sorted = 0, steps = 0;
      try {
        for (; steps < 100 && sorted < SORT_RUN_CAP; steps++) {
          const state = this.syncState(r, folder);
          const t = job.target;
          if (!state || state.low <= 1 || this.cachedInTab(r, folder, state, t.tabs, t.category, t.below, t.want) >= t.want) break;
          // The account as it is now (its password may have changed since the run began; it may be gone).
          const now = this.sql.exec<AccountRow & Record<string, SqlStorageValue>>('SELECT * FROM accounts WHERE id = ?', r.id).toArray()[0];
          if (!now) break;
          const got = await this.withFolder(now, folder, 'sorter', async (c) => {
            await this.testSlow();
            const s = this.syncState(r, folder);
            return s && s.validity === this.validity(c) ? this.extendDown(now, c, folder, s, this.budget(SORT_BATCH), this.isGmail(now, c)) : null;
          });
          if (got === null) break;
          sorted += got.sorted;
          if (got.failed) break;
        }
      } finally {
        this.sorting.delete(key);
      }
      return `${sorted} sorted in ${steps} steps`;
    });
  }

  /** Starts the background re-check if it is due (at most every RECHECK_MS per account), or now with `force` (the test hook). */
  private recheckSoon(r: AccountRow, folder: string, force = false): void {
    const state = this.syncState(r, folder);
    if (!state || state.high === 0 || (!force && Date.now() - state.checkedAt < RECHECK_MS) || this.rechecking.has(r.id)) return;
    this.rechecking.add(r.id);
    this.background('recheck', () => this.recheck(r, folder).finally(() => this.rechecking.delete(r.id)));
  }

  /**
   * The background re-check of the newest RECHECK_SPAN cached messages, on the sorter connection: one `UID SEARCH
   * <floor>:*` over their UID range forgets the rows of mail that has left the folder, and on Gmail `recheckRows`
   * (gmailTabs.ts) takes Gmail's current categories (re-sorting done on gmail.com or by Gmail itself): the four X-GM-RAW
   * searches over ranges of at most 250 cached messages, a row moving only to a category a search returns it under, and
   * going to Primary only when the searches by its own UID leave it out too. A failed or suspicious pass changes nothing.
   * Then, while `repair_below` is set, a batch of older rows cached as "Gmail: no category" is asked about again (only
   * ever leaving Primary). Older rows are otherwise left as they are (a list page drops a UID the server no longer returns).
   */
  private async recheck(started: AccountRow, folder: string): Promise<string> {
    // The account as it is now (its password may have changed since the request that started this).
    const r = this.row(started.id);
    const state = this.syncState(r, folder);
    if (!state || state.high === 0) return 'nothing cached';
    const floor = this.sql.exec<{ uid: number }>('SELECT uid FROM mail_categories WHERE account_id = ? AND folder = ? AND uid_validity = ? ORDER BY uid DESC LIMIT 1 OFFSET ?',
      r.id, folder, state.validity, RECHECK_SPAN - 1).toArray()[0]?.uid ?? 1;
    const range = `${floor}:*`;
    const done = await this.withFolder(r, folder, 'sorter', async (c) => {
      await this.testSlow();
      if (this.validity(c) !== state.validity) return null;
      const log: TabLogEntry = { at: new Date().toISOString(), kind: 'recheck', checked: 0, errors: [] };
      const answer = await c.search({ uid: range }, { uid: true });
      if (!Array.isArray(answer)) {
        // A refused search is not an empty folder: nothing is forgotten or re-sorted.
        log.errors.push('UID search refused by the server');
        this.logTabs(r.id, log);
        return 'the server refused the UID search; nothing changed';
      }
      const present = new Set(answer);
      const cached = this.sql.exec<{ uid: number; category: string }>('SELECT uid, category FROM mail_categories WHERE account_id = ? AND folder = ? AND uid_validity = ? AND uid >= ?',
        r.id, folder, state.validity, floor).toArray();
      const gone = cached.filter((row) => !present.has(row.uid)).map((row) => row.uid);
      this.forgetRows(r.id, folder, gone);
      log.checked = cached.length;
      log.gone = gone.length;
      if (!this.isGmail(r, c)) {
        this.logTabs(r.id, log);
        return `${cached.length} checked, ${gone.length} gone, 0 re-sorted`;
      }
      const result = await recheckRows(searcher(c), cached.filter((row) => present.has(row.uid)));
      this.applyTabs(r, folder, state.validity, result);
      this.logTabs(r.id, { ...log, promoted: result.promoted, moved: result.moved, demoted: result.demoted, confirmed: result.confirmed, errors: result.error ? [result.error] : [] });
      if (result.error) console.warn(`[mail] recheck: ${result.error}; nothing re-sorted`);
      const repaired = state.repairBelow > 0 ? await this.repair(r, c, folder, state, floor) : '';
      return `${cached.length} checked, ${gone.length} gone, ${result.error ? 'not re-sorted (unreliable answer)' : `${result.promoted} promoted, ${result.moved} moved, ${result.demoted} demoted`}${repaired}`;
    });
    if (done === null) return 'a new UIDVALIDITY';
    this.sql.exec('UPDATE mail_sync SET checked_at = ? WHERE account_id = ? AND folder = ? AND uid_validity = ?', Date.now(), r.id, folder, state.validity);
    return done;
  }

  /** Stores a re-check's changes (none when the pass was not believed). */
  private applyTabs(r: AccountRow, folder: string, validity: string, result: RecheckResult): void {
    if (result.error) return;
    for (const change of result.changes) {
      this.sql.exec('UPDATE mail_categories SET category = ?, reason = ? WHERE account_id = ? AND folder = ? AND uid_validity = ? AND uid = ?',
        change.category, change.reason, r.id, folder, validity, change.uid);
    }
  }

  /**
   * One batch of the repair of older Gmail rows cached as Primary with no category (below the re-check's `floor`, newest
   * first, below `repair_below`): any a category search now returns leaves Primary; none is demoted. `repair_below` moves
   * down past the batch, and to 0 once there are none left. A failed batch leaves it for the next re-check.
   */
  private async repair(r: AccountRow, c: ImapFlow, folder: string, state: SyncState, floor: number): Promise<string> {
    const rows = this.sql.exec<{ uid: number; category: string }>(
      'SELECT uid, category FROM mail_categories WHERE account_id = ? AND folder = ? AND uid_validity = ? AND reason = ? AND uid < ? ORDER BY uid DESC LIMIT ?',
      r.id, folder, state.validity, GMAIL_NONE, Math.min(state.repairBelow, floor), REPAIR_BATCH).toArray();
    const result = await recheckRows(searcher(c), rows, { demote: false });
    this.logTabs(r.id, { at: new Date().toISOString(), kind: 'repair', checked: rows.length, promoted: result.promoted, errors: result.error ? [result.error] : [] });
    if (result.error) {
      console.warn(`[mail] repair: ${result.error}`);
      return '; repair failed';
    }
    this.applyTabs(r, folder, state.validity, result);
    const below = rows.length < REPAIR_BATCH ? 0 : rows[rows.length - 1].uid;
    this.sql.exec('UPDATE mail_sync SET repair_below = ? WHERE account_id = ? AND folder = ? AND uid_validity = ?', below, r.id, folder, state.validity);
    return `; repair: ${rows.length} older checked, ${result.promoted} promoted${below ? '' : ', done'}`;
  }

  // ---- inbox tabs: lists ----------------------------------------------------------------------------------------------

  /**
   * The tab of each message of a page listed without `category`, and why: cached, or sorted now (Gmail: asked of Gmail;
   * elsewhere from the headers of the message as fetched with the page, or fetched now for one that came from the cache).
   */
  private async categoriesOf(r: AccountRow, c: ImapFlow, folder: string, tabs: TabCategory[], uids: number[], gmail: boolean, fetched: Map<number, FetchMessageObject>): Promise<Map<number, { category: Category; reason?: string }>> {
    const overrides = this.overrides(r.id);
    const out = new Map<number, { category: Category; reason?: string }>();
    if (!uids.length) return out;
    const validity = this.validity(c);
    const cache = this.cachedRows(r, folder, validity, uids);
    const missing = uids.filter((u) => !cache.has(u));
    if (gmail) await this.classify(r, c, folder, validity, missing, true, cache);
    else if (missing.length) {
      for (const u of missing) { const m = fetched.get(u); if (m?.headers) cache.set(u, this.remember(r, folder, validity, m)); }
      const ask = missing.filter((u) => !cache.has(u));
      if (ask.length) for await (const m of c.fetch(uidSet(ask), { uid: true, envelope: true, internalDate: true, headers: CATEGORY_HEADERS }, { uid: true })) cache.set(m.uid, this.remember(r, folder, validity, m));
    }
    for (const uid of uids) {
      const row = cache.get(uid);
      // (A Gmail message whose search failed is not cached: Primary for now, without a reason, and sorted next time.)
      out.set(uid, row ? { category: this.tabOf(row, overrides, tabs), reason: reasonOf(row.reason, overrides.get(row.sender)) } : { category: 'primary' });
    }
    return out;
  }

  /** The SQL of the cached rows of one folder with their tab (`tab`), the user's choices and the enabled tabs applied. */
  private tabRows(tabs: TabCategory[]): { from: string; tab: string; params: string[] } {
    const e = effectiveSql(tabs);
    return { from: 'mail_categories c LEFT JOIN mail_category_overrides o ON o.account_id = c.account_id AND o.sender = c.sender', tab: e.sql, params: e.params };
  }

  /**
   * One page of a tab, newest first, from the cache, without sorting a large batch first: new mail above the high-water
   * mark is sorted (`sync`, at most SYNC_CAP), then the page is read from SQLite (the cached rows from `low` up) and its
   * summaries fetched in one FETCH. Where the cache ends before the page is full, the page comes back short (even empty)
   * with `sorting` and `next`, and the sorter sorts older mail in the background, as it also does whenever fewer than
   * SORT_AHEAD_PAGES more pages of the tab are cached below this one.
   */
  private async tabList(r: AccountRow, folder: string, tabs: TabCategory[], category: Category, limit: number, before: number | null): Promise<MessagePage> {
    const cursor = before ?? Number.MAX_SAFE_INTEGER;
    const want = limit * (1 + SORT_AHEAD_PAGES);
    const result = await this.withFolder(r, folder, 'background', async (c) => {
      // (Not `c.mailbox.exists`: on a connection that already had INBOX open it may not know of new mail yet; sync asks.)
      if (!c.mailbox || (before !== null && before <= 1)) return null;
      if (category !== 'primary' && !tabs.includes(category as TabCategory)) return null; // a tab that is off has nothing; its mail is in Primary
      const fresh = this.isFresh(r, folder, this.validity(c));
      const state = (fresh && this.syncState(r, folder)) || await this.sync(r, c, folder, this.isGmail(r, c));
      const q = this.tabRows(tabs);
      const found = this.sql.exec<{ uid: number; reason: string; chosen: string | null }>(
        `SELECT c.uid, c.reason, o.category AS chosen FROM ${q.from} WHERE c.account_id = ? AND c.folder = ? AND c.uid_validity = ? AND c.uid < ? AND c.uid >= ? AND ${q.tab} = ? ORDER BY c.uid DESC LIMIT ?`,
        r.id, folder, state.validity, cursor, Math.max(1, state.low), ...q.params, category, limit + 1).toArray();
      const rows = found.map((row) => row.uid);
      const reasons = new Map(found.map((row) => [row.uid, reasonOf(row.reason, row.chosen)]));
      const { page, next, sorting } = tabPage(rows, limit, state.low, cursor);
      const ahead = state.low > 1 && (sorting || this.cachedInTab(r, folder, state, tabs, category, cursor, want) < want);
      const summaries = await this.pageSummaries(r, c, folder, state.validity, page, !fresh);
      // What the cache had but the server no longer has has left the folder (moved elsewhere, from another mail app).
      const gone = page.filter((u) => !summaries.has(u));
      if (gone.length) this.left(r.id, folder, gone);
      return { messages: page.filter((u) => summaries.has(u)).map((u) => ({ ...summaries.get(u)!, category, categoryReason: reasons.get(u) })), next, sorting, ahead };
    });
    this.recheckSoon(r, folder, timing.getStore()?.test.recheck);
    if (!result) return { messages: [], next: null };
    if (result.ahead) this.sortSoon(r, folder, { tabs, category, below: cursor, want });
    return { messages: result.messages, next: result.next, ...(result.sorting ? { sorting: true as const } : {}) };
  }

  /** "Move to tab": the senders of these messages go to `category` from now on. Returns what each had before, for undo. */
  private async moveToTab(r: AccountRow, folder: string, uids: number[], category: Category): Promise<{ senders: string[]; previous: { address: string; category: Category | null }[] }> {
    // The senders are in the cache; only messages it does not have are asked about.
    const out = new Set<string>();
    const known = new Set<number>();
    for (const row of this.sql.exec<{ uid: number; sender: string }>('SELECT uid, sender FROM mail_categories WHERE account_id = ? AND folder = ? AND uid IN (SELECT value FROM json_each(?))', r.id, folder, JSON.stringify(uids)).toArray()) {
      known.add(row.uid);
      if (row.sender) out.add(row.sender);
    }
    const ask = uids.filter((u) => !known.has(u));
    if (ask.length) {
      await this.withFolder(r, folder, 'interactive', async (c) => {
        for await (const m of c.fetch(uidSet(ask), { uid: true, envelope: true }, { uid: true })) {
          const address = (m.envelope?.from?.[0]?.address ?? m.envelope?.sender?.[0]?.address ?? '').toLowerCase();
          if (address) out.add(address);
        }
      });
    }
    const senders = [...out];
    const before = this.overrides(r.id);
    const previous = senders.map((address) => ({ address, category: before.get(address) ?? null }));
    for (const address of senders) this.setOverride(r.id, address, category);
    return { senders, previous };
  }

  /** A sender's chosen tab: the cached rows take it at once, as each is read with the overrides joined (`tabRows`). */
  private setOverride(accountId: string, sender: string, category: Category | null): void {
    if (category === null) this.sql.exec('DELETE FROM mail_category_overrides WHERE account_id = ? AND sender = ?', accountId, sender);
    else this.sql.exec('INSERT OR REPLACE INTO mail_category_overrides (account_id, sender, category, created_at) VALUES (?, ?, ?, ?)', accountId, sender, category, Date.now());
  }

  // ---- conversations ------------------------------------------------------------------------------------------------

  /**
   * One page of a folder's conversations, newest first (docs/specs/mail-api.md, Conversations): the threads with a cached
   * message in the folder, by their newest message there, from the prefetch cache. The first page takes in new mail first
   * (`cacheNew`), as a plain page does; where the cache runs out, one backfill step extends it before answering. With a
   * tab (INBOX, tabs on), new mail is sorted first (`sync`, as a tab's page does) and the threads whose newest message is
   * in the tab are kept; a short page while older mail is not sorted yet says `sorting`, and the sorter is started. The
   * flags of the messages shown are checked against the server in one FLAGS fetch.
   */
  private async threadList(r: AccountRow, folder: string, tabs: TabCategory[], category: Category | null, limit: number, before: number | null): Promise<ThreadPage> {
    const t = timing.getStore();
    const want = limit * (1 + SORT_AHEAD_PAGES);
    const result = await this.withImap(r, 'background', async (c) => {
      const wasOpen = c.mailbox && c.mailbox.path === folder;
      return this.locked(c, folder, async (): Promise<ThreadPage & { ahead?: SortTarget }> => {
        if (!c.mailbox) return { threads: [], next: null };
        const gmail = tabs.length > 0 && this.isGmail(r, c);
        const validity = this.validity(c);
        const now = Date.now();
        let state = this.cache.touchFolder(r.id, folder, await this.kindOf(r, c, folder), now, true);
        if (state.validity !== validity) state = this.cache.resetFolder(r.id, folder, validity);
        // Synced by the alarm lately: the page as the cache stands, with no round trip.
        const fresh = now - state.syncedAt < FRESH_MS;
        if (before === null && !fresh) {
          if (wasOpen) await c.noop();
          await this.cacheNew(r, c, folder, state, this.budget(NEW_CAP));
          state = this.cache.folder(r.id, folder)!;
        }
        let tab: { from: string; tab: string; params: string[]; category: string } | undefined;
        let tabState: SyncState | null = null;
        if (category && tabs.length) {
          if (category !== 'primary' && !tabs.includes(category as TabCategory)) return { threads: [], next: null };
          tabState = (fresh && this.syncState(r, folder)) || await this.sync(r, c, folder, gmail);
          tab = { ...this.tabRows(tabs), category };
        }
        if (state.high === 0 || (before !== null && before <= 1)) return { threads: [], next: null };
        const cursor = before ?? Number.MAX_SAFE_INTEGER;
        const floor = () => (tabState ? Math.max(state.low, tabState.low) : state.low);
        let tops = this.cache.threadPage(r.id, folder, validity, cursor, floor(), limit + 1, tab);
        if (tops.length <= limit && state.low > 1 && !tabState) {
          // The cache ends before the page is full: one step further down, then look again.
          await this.backfill(r, c, folder, state, this.budget(BACKFILL_STEP));
          state = this.cache.folder(r.id, folder)!;
          tops = this.cache.threadPage(r.id, folder, validity, cursor, floor(), limit + 1, tab);
        }
        const page = tops.slice(0, limit);
        const more = tops.length > limit || floor() > 1;
        const sorting = !!tabState && page.length < limit && tabState.low > 1;
        const rows = this.cache.threadRows(r.id, page.map((p) => p.threadId));
        // The flags of the messages shown, as the server has them now; a message it no longer has is dropped.
        const here = rows.filter((x) => x.folder === folder && x.validity === validity);
        let kept = rows;
        if (here.length && !fresh) {
          const { changed, vanished } = await this.refreshFlags(r, c, folder, validity, here.map((x) => x.uid), now, null);
          if (vanished.size) { this.left(r.id, folder, [...vanished]); kept = rows.filter((x) => !(x.folder === folder && vanished.has(x.uid))); }
          if (changed.size) kept = kept.map((x) => { const f = x.folder === folder ? changed.get(x.uid) : undefined; return f ? { ...x, summary: { ...x.summary, seen: f.seen, flagged: f.flagged, answered: f.answered } } : x; });
        }
        let threads = page.map((p) => this.threadSummary(r, folder, p, kept.filter((x) => x.threadId === p.threadId))).filter((x): x is ThreadSummary => !!x);
        if (tabs.length) {
          const categories = await this.categoriesOf(r, c, folder, tabs, threads.map((x) => x.uid), gmail, new Map());
          threads = threads.map((x) => { const tab = categories.get(x.uid); return { ...x, category: tab?.category ?? 'primary', ...(tab?.reason ? { categoryReason: tab.reason } : {}) }; });
        }
        if (t) t.cache = 'hit';
        const last = threads[threads.length - 1];
        const ahead = tabState && tabState.low > 1 && (sorting || this.cachedInTab(r, folder, tabState, tabs, category as Category, cursor, want) < want) ? { tabs, category: category as Category, below: cursor, want } : undefined;
        return { threads, next: more && last ? last.uid : sorting ? Math.min(cursor, tabState!.low) : null, ...(sorting ? { sorting: true as const } : {}), ...(ahead ? { ahead } : {}) };
      });
    });
    if (tabs.length && category) this.recheckSoon(r, folder, timing.getStore()?.test.recheck);
    if (result.ahead) this.sortSoon(r, folder, result.ahead);
    const { ahead: _ahead, ...page } = result;
    return page;
  }

  /** A thread's row for a folder's list, from its cached messages account-wide (each message counted once). */
  private threadSummary(r: AccountRow, folder: string, top: { threadId: string; uid: number }, rows: ThreadRow[]): ThreadSummary | null {
    const here = rows.filter((x) => x.folder === folder).sort((a, b) => b.uid - a.uid);
    const latest = here.find((x) => x.uid === top.uid) ?? here[0];
    if (!latest) return null;
    const rank = (x: ThreadRow) => (x.folder === folder ? 0 : x.folder.toUpperCase() === INBOX ? 1 : 2);
    const byKey = new Map<string, ThreadRow>();
    for (const x of rows) { const have = byKey.get(x.key); if (!have || rank(x) < rank(have)) byKey.set(x.key, x); }
    const unique = [...byKey.values()];
    return {
      threadId: top.threadId, folder, uid: latest.uid, uids: here.map((x) => x.uid), latest: { ...latest.summary, threadId: top.threadId },
      count: unique.length, unread: unique.filter((x) => !x.summary.seen).length, flagged: unique.some((x) => x.summary.flagged),
      participants: participants(unique.map((x) => x.summary), r.email), date: new Date(Math.max(...unique.map((x) => x.date))).toISOString(),
      folders: [...new Set(rows.map((x) => x.folder))],
    };
  }

  /**
   * A conversation as read: every cached message of the thread across the account's folders, oldest first, each once (a
   * copy in the folder it was opened from preferred, then INBOX), with its body when the cache has it; else without, as
   * `bodyPending`, and those bodies are fetched now in the background for the next read.
   */
  private threadRead(r: AccountRow, threadId: string, folder: string | null): { threadId: string; messages: (MessageDetail & { bodyPending?: true })[] } {
    const rows = this.cache.threadRows(r.id, [threadId]);
    if (!rows.length) throw notFound('no such conversation');
    const rank = (x: ThreadRow) => (x.folder === folder ? 0 : x.folder.toUpperCase() === INBOX ? 1 : 2);
    const byKey = new Map<string, ThreadRow>();
    for (const x of rows) { const have = byKey.get(x.key); if (!have || rank(x) < rank(have)) byKey.set(x.key, x); }
    const messages: (MessageDetail & { bodyPending?: true })[] = [];
    const pending: ThreadRow[] = [];
    for (const x of [...byKey.values()].sort((a, b) => a.date - b.date || a.uid - b.uid)) {
      const body = this.cache.body(r.id, x.folder, x.validity, x.uid);
      if (body) { messages.push({ ...body.detail, threadId }); continue; }
      const detail = this.cache.pendingDetail(r.id, x.folder, x.uid);
      if (!detail) continue;
      messages.push({ ...detail, html: null, text: null, bodyPending: true, threadId });
      pending.push(x);
    }
    // Newest first: the last message is the one shown open.
    if (pending.length) this.fetchBodiesSoon(r, pending.reverse().slice(0, 10));
    return { threadId, messages };
  }

  /** Reads these messages in the background (each is kept by `read`), for a conversation opened before the alarm got to them. */
  private fetchBodiesSoon(r: AccountRow, rows: ThreadRow[]): void {
    const key = `${r.id}/bodies`;
    if (this.fetchingBodies.has(key)) return;
    this.fetchingBodies.add(key);
    this.background('thread bodies', async () => {
      try {
        let n = 0;
        for (const x of rows) { await this.read(r, x.folder, x.uid).catch((err) => console.warn(`[mail] thread body: ${(err as Error).message}`)); n++; }
        return `${n} read`;
      } finally {
        this.fetchingBodies.delete(key);
      }
    });
  }

  // ---- the prefetch cache: keeping it ---------------------------------------------------------------------------------

  /** Where the alarm's run is (`mail_state.alarm_step`): kept in SQLite, so a run the runtime cut short still says where it was. */
  private step(what: string): void {
    this.cache.setState('alarm_step', `${new Date().toISOString()} ${what}`);
  }

  /** The run's synchronous sections, by name: how long they took in all and the longest one (`mail_state.alarm_profile`). */
  private profile = new Map<string, { ms: number; n: number; max: number; maxAt: string }>();
  private timed<T>(name: string, what: string, fn: () => T): T {
    const t0 = Date.now();
    try { return fn(); } finally {
      const ms = Date.now() - t0;
      const p = this.profile.get(name) ?? { ms: 0, n: 0, max: 0, maxAt: '' };
      p.ms += ms; p.n++;
      if (ms > p.max) { p.max = ms; p.maxAt = what; }
      this.profile.set(name, p);
      if (ms > 50) this.cache.setState('alarm_profile', JSON.stringify(Object.fromEntries(this.profile)));
    }
  }

  /** The person made a request: the alarm runs often for a while (`last_active_at`, written at most every 10 s). */
  private touch(): void {
    const now = Date.now();
    if (now - this.lastTouch < 10_000) return;
    this.lastTouch = now;
    this.cache.setState('last_active_at', String(now));
  }

  /**
   * Sets the alarm for the next cache run (cache.ts `nextAlarmAt`: 30 s while the person is active, then less often, none
   * after a day idle or with no accounts), unless one is already due sooner. After every request and every run.
   */
  private async armAlarm(now = Date.now()): Promise<void> {
    if (this.env.MAIL_ALARM === 'off') { if ((await this.ctx.storage.getAlarm()) !== null) await this.ctx.storage.deleteAlarm(); return; }
    const has = (this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM accounts').toArray()[0]?.n ?? 0) > 0;
    const at = nextAlarmAt(this.cache.lastActiveAt(), now, has);
    const current = await this.ctx.storage.getAlarm();
    if (at === null) { if (current !== null) await this.ctx.storage.deleteAlarm(); return; }
    if (current === null || current > at || current < now) await this.ctx.storage.setAlarm(at);
  }

  async alarm(): Promise<void> {
    if (this.env.MAIL_ALARM === 'off') return;
    try {
      await this.runCache(Date.now() + ALARM_BUDGET_MS);
    } catch (err) {
      console.warn(`[mail] alarm: ${(err as Error).message}`);
    }
    await this.armAlarm().catch((err) => console.warn(`[mail] alarm: ${(err as Error).message}`));
  }

  /**
   * One run of the cache: each account in turn (starting after the one the last run ended with, so a slow account never
   * starves the rest), each of its cached folders synced on the cache connection, until the budget is spent. An account
   * whose server refuses it is skipped (its status says so); a folder whose sync fails is left alone for a while. When
   * the person is away, the cache connection is logged out right after, so the object can sleep.
   */
  private async runCache(deadline: number): Promise<void> {
    if (this.caching) return;
    this.caching = true;
    const start = Date.now();
    const entry: CacheLogEntry = { at: new Date(start).toISOString(), ms: 0, folders: [], errors: [] };
    const t: Timing = { wait: 0, imap: 0, test: timing.getStore()?.test ?? NO_TEST };
    this.profile = new Map();
    this.cache.setState('alarm_profile', '{}');
    try {
      await timing.run(t, async () => {
        const accounts = this.sql.exec<AccountRow & Record<string, SqlStorageValue>>('SELECT * FROM accounts ORDER BY created_at').toArray();
        const last = this.cache.state('last_account');
        const i = accounts.findIndex((a) => a.id === last);
        const order = i < 0 ? accounts : [...accounts.slice(i + 1), ...accounts.slice(0, i + 1)];
        const active = Date.now() - this.cache.lastActiveAt() < 3 * 60_000;
        for (const r of order) {
          if (Date.now() > deadline) break;
          try {
            await this.withImap(r, 'cache', async (c) => {
              const now = Date.now();
              for (const f of await this.cacheFolders(r, c, now)) {
                if (Date.now() > deadline) break;
                if (f.error && now - f.errorAt < ERROR_BACKOFF_MS) continue;
                try {
                  this.step(`${f.kind}: lock`);
                  const what = await this.locked(c, f.folder, () => this.syncFolder(r, c, f, deadline));
                  entry.folders.push(`${f.kind}: ${what}`);
                } catch (err) {
                  const message = (err as Error).message;
                  this.cache.setMarks(r.id, f.folder, { error: message, errorAt: Date.now() });
                  entry.errors.push(`${f.kind}: ${message}`);
                }
              }
              // Then the bodies, with what is left of the budget.
              if (Date.now() < deadline) {
                this.step('bodies');
                try { entry.folders.push(`bodies: ${await this.prefetchBodies(r, c, deadline)}`); } catch (err) { entry.errors.push(`bodies: ${(err as Error).message}`); }
              }
            });
          } catch (err) {
            entry.errors.push((err as Error).message);
          } finally {
            this.cache.setState('last_account', r.id);
            if (!active) this.closeNow(`${r.id}/cache`);
          }
        }
      });
    } finally {
      this.caching = false;
      entry.ms = Date.now() - start;
      this.step('done');
      this.cache.setState('alarm_profile', JSON.stringify(Object.fromEntries(this.profile)));
      this.cacheLog.push(entry);
      while (this.cacheLog.length > CACHE_LOG_KEEP) this.cacheLog.shift();
      console.log(`[mail] cache: ${entry.folders.length} folders${entry.errors.length ? `, ${entry.errors.length} errors` : ''} ${entry.ms}ms (lock wait ${Math.round(t.wait)}ms, imap ${Math.round(t.imap)}ms)`);
    }
  }

  /** Whether the alarm synced this folder (with this UIDVALIDITY) within FRESH_MS. */
  private isFresh(r: AccountRow, folder: string, validity: string): boolean {
    const f = this.cache.folder(r.id, folder);
    return !!f && f.validity === validity && Date.now() - f.syncedAt < FRESH_MS;
  }

  /** Why a folder is cached: INBOX, Sent, Drafts, Archive or All Mail by its special use, else because it was opened. */
  private async kindOf(r: AccountRow, c: ImapFlow, folder: string): Promise<FolderKind> {
    const f = (await this.folderList(r, c)).find((x) => x.path === folder);
    const use = f ? specialUseOf(f) : null;
    return use && (MAIN_KINDS as readonly string[]).includes(use) ? (use as FolderKind) : 'recent';
  }

  /** The folders the alarm keeps for an account: the main ones (rows made as needed) and those opened lately. */
  private async cacheFolders(r: AccountRow, c: ImapFlow, now: number): Promise<CachedFolder[]> {
    for (const f of await this.folderList(r, c)) {
      if (f.flags.has('\\Noselect')) continue;
      const use = specialUseOf(f);
      if (use && (MAIN_KINDS as readonly string[]).includes(use)) this.cache.touchFolder(r.id, f.path, use as FolderKind, now, false);
    }
    this.cache.expireFolders(r.id, now);
    return this.cache.folders(r.id);
  }

  /**
   * Brings one cached folder up to date, under its lock on the cache connection: new mail above the high-water mark
   * (`cacheNew`), the flags of every cached message and what has left (`refreshFlags`, CONDSTORE's `changedSince` where
   * the server has it), older mail below `low` while there is budget (`backfill`), and the oldest rows past CACHE_ROWS
   * dropped. Each step saves its marks before the next, so a run cut short leaves the cache consistent.
   */
  private async syncFolder(r: AccountRow, c: ImapFlow, f: CachedFolder, deadline: number): Promise<string> {
    const folder = f.folder;
    const validity = this.validity(c);
    let state = f.validity === validity ? f : this.cache.resetFolder(r.id, folder, validity);
    const started = Date.now();
    this.step(`${f.kind}: new mail`);
    const added = await this.cacheNew(r, c, folder, state, this.budget(NEW_CAP));
    state = this.cache.folder(r.id, folder)!;
    // INBOX with tabs on: its new mail sorted into them here, so a tab's page need not (a refused Gmail search is logged, not fatal).
    let sorted = '';
    if (folder.toUpperCase() === INBOX && this.tabsOf(r).length) {
      this.step(`${f.kind}: tabs`);
      try { await this.sync(r, c, folder, this.isGmail(r, c)); sorted = ', tabs sorted'; } catch (err) { sorted = `, tabs not sorted (${(err as Error).message})`; }
    }
    const uids = this.cache.uids(r.id, folder, validity);
    const box = c.mailbox || null;
    const condstore = c.enabled.has('CONDSTORE') && !!box && !box.noModseq && box.highestModseq !== undefined;
    const modseq = condstore ? String(box.highestModseq) : null;
    let changed = 0, gone = 0;
    this.step(`${f.kind}: flags (${uids.length} rows, modseq ${state.modseq} -> ${modseq})`);
    if (uids.length) {
      const since = condstore && state.modseq && state.modseq !== modseq ? BigInt(state.modseq) : null;
      if (condstore && state.modseq && state.modseq === modseq) {
        // Nothing changed flags since the last run; only what left the folder is asked about.
        const present = await c.search({ uid: `${Math.max(1, state.low)}:*` }, { uid: true });
        if (Array.isArray(present)) { const have = new Set(present); const vanished = uids.filter((u) => !have.has(u)); if (vanished.length) this.left(r.id, folder, vanished); gone = vanished.length; }
      } else {
        const got = await this.refreshFlags(r, c, folder, validity, uids, started, since);
        changed = got.changed.size;
        gone = got.vanished.size;
        if (got.vanished.size) this.left(r.id, folder, [...got.vanished]);
      }
      this.cache.setMarks(r.id, folder, { modseq });
    }
    let older = 0;
    for (let steps = 0; steps < 50 && Date.now() < deadline; steps++) {
      state = this.cache.folder(r.id, folder)!;
      if (state.low <= 1 || this.cache.count(r.id, folder, validity) >= CACHE_ROWS) break;
      this.step(`${f.kind}: backfill below ${state.low}`);
      await this.testSlow();
      const got = await this.backfill(r, c, folder, state, this.budget(BACKFILL_STEP));
      older += got.added;
      if (!got.moved) break;
    }
    this.step(`${f.kind}: trim`);
    const trimmed = this.timed('trim', folder, () => this.cache.trim(r.id, folder, validity, CACHE_ROWS));
    this.cache.setMarks(r.id, folder, { syncedAt: Date.now(), error: null, errorAt: 0 });
    return `${added} new, ${changed} flags, ${gone} gone, ${older} older${trimmed ? `, ${trimmed} trimmed` : ''}${sorted}`;
  }

  /**
   * New mail of the open folder above the high-water mark, into the cache: one `UID SEARCH <high+1>:*`, and a FETCH of at
   * most `cap` of them, the newest. The first time (or after a new UIDVALIDITY), the newest `cap` found from UIDNEXT down
   * (`uidsBelow`). More new mail than `cap`: `low` moves up to what was cached, and the backfill fills in below. Returns how
   * many were cached.
   */
  private async cacheNew(r: AccountRow, c: ImapFlow, folder: string, state: CachedFolder, cap: number): Promise<number> {
    const validity = this.validity(c);
    const now = Date.now();
    if (state.high === 0) {
      const top = Number(c.mailbox ? c.mailbox.uidNext : 0) || 0;
      const { uids, from } = top > 1 ? await this.uidsBelow(c, top, cap) : { uids: ((await c.search({ all: true }, { uid: true })) || []).sort((a, b) => b - a), from: 1 };
      const take = uids.slice(0, cap);
      if (!take.length) return 0;
      const { summaries } = await this.cacheFetch(r, c, folder, validity, take, now);
      // A folder synced before while empty (a new mailbox, phase 5.4): what is in it now arrived since, so it is new mail.
      if (state.syncedAt > 0 && folder.toUpperCase() === INBOX) await this.publishReceived(r, folder, summaries);
      this.cache.setMarks(r.id, folder, { high: take[0], low: take.length < uids.length ? take[take.length - 1] : from });
      return take.length;
    }
    const fresh = ((await c.search({ uid: `${state.high + 1}:*` }, { uid: true })) || []).filter((u) => u > state.high).sort((a, b) => b - a);
    if (!fresh.length) return 0;
    const take = fresh.slice(0, cap);
    const { summaries } = await this.cacheFetch(r, c, folder, validity, take, now);
    // Above a high-water mark that existed, so new mail and not the first fill's backlog: into the event log.
    if (folder.toUpperCase() === INBOX) await this.publishReceived(r, folder, summaries);
    if (take.length < fresh.length) this.cache.setMarks(r.id, folder, { high: fresh[0], low: take[take.length - 1] });
    else this.cache.setMarks(r.id, folder, { high: fresh[0] });
    return take.length;
  }

  /**
   * One `mail.received` per new INBOX message (platform.md §5.2), for the account's own eyes: its summary without the
   * body. Skipped while the object's organization is unknown; a failure is logged, never the sync's.
   */
  private async publishReceived(r: AccountRow, folder: string, summaries: MessageSummary[]): Promise<void> {
    const org = this.cache.state('owner_organization_id'), owner = this.cache.state('owner_account_id');
    if (!this.env.EVENTS || !org || !owner || !summaries.length) return;
    const events = [...summaries].sort((a, b) => a.uid - b.uid).map((m) => ({
      type: 'mail.received', organizationId: org, actor: null, audience: `account:${owner}` as const,
      ref: { organizationId: org, app: 'mail', kind: 'message', id: `${r.id}:${folder}:${m.uid}` },
      ts: new Date().toISOString(),
      data: { accountId: r.id, folder, uid: m.uid, from: m.from, subject: m.subject, date: m.date },
    }));
    try {
      await this.env.EVENTS.get(this.env.EVENTS.idFromName(org)).publishMany(events);
    } catch (err) {
      console.error(`[mail] mail.received: ${(err as Error).message}`);
    }
  }

  /** One backfill step: the cache of the open folder extended below `low` by up to `budget` messages (`uidsBelow`, `walkDown`). */
  private async backfill(r: AccountRow, c: ImapFlow, folder: string, state: CachedFolder, budget: number): Promise<{ added: number; moved: boolean }> {
    if (state.low <= 1) return { added: 0, moved: false };
    const { uids, from } = await this.uidsBelow(c, state.low, budget);
    const have = this.cache.cachedUids(r.id, folder, state.validity, uids);
    const { todo, last, done } = walkDown(uids, have, budget);
    if (todo.length) await this.cacheFetch(r, c, folder, state.validity, todo, Date.now());
    const low = done ? from : last;
    if (low && low < state.low) this.cache.lowerLow(r.id, folder, state.validity, state.low, low);
    return { added: todo.length, moved: !!low && low < state.low };
  }

  /** Fetches these messages of the open folder (CACHE_QUERY) and caches them. */
  private async cacheFetch(r: AccountRow, c: ImapFlow, folder: string, validity: string, uids: number[], now: number): Promise<{ fetched: FetchMessageObject[]; summaries: MessageSummary[] }> {
    const fetched: FetchMessageObject[] = [];
    for (let i = 0; i < uids.length; i += 500) {
      for await (const m of c.fetch(uidSet(uids.slice(i, i + 500)), CACHE_QUERY, { uid: true })) fetched.push(m);
    }
    fetched.sort((a, b) => b.uid - a.uid);
    const { summaries } = await this.cacheRows(r, c, folder, validity, fetched, now);
    return { fetched, summaries };
  }

  /** Caches fetched messages (with their snippets), and returns their summaries. */
  private async cacheRows(r: AccountRow, c: ImapFlow, folder: string, validity: string, fetched: FetchMessageObject[], now: number): Promise<{ summaries: MessageSummary[] }> {
    if (!fetched.length) return { summaries: [] };
    const snippets = await this.snippets(c, fetched).catch((err) => { console.warn(`[mail] snippets: ${(err as Error).message}`); return new Map<number, string>(); });
    const rows: NewRow[] = fetched.map((m) => ({ m, summary: toSummary(m, folder, snippets.get(m.uid) ?? ''), headers: m.headers ? Buffer.from(m.headers).toString('latin1') : null, plan: m.bodyStructure ? planBody(m.bodyStructure) : null }));
    const threads = this.timed('insert', `${folder} ${rows.length} rows`, () => this.cache.insert(r.id, folder, validity, rows, now, r.email));
    return { summaries: rows.map((row) => { const threadId = threads.get(row.m.uid); return threadId ? { ...row.summary, threadId } : row.summary; }) };
  }

  /**
   * The flags of these cached messages as the server has them: one `UID FETCH <set> (FLAGS)`, or with `since` (CONDSTORE)
   * only those changed since that modseq. Rows written through after `started` keep what they have (cache.ts `flagDiff`).
   * Returns what changed (applied to the rows) and, from a full fetch, which messages the server no longer has (not applied).
   */
  private async refreshFlags(r: AccountRow, c: ImapFlow, folder: string, validity: string, uids: number[], started: number, since: bigint | null): Promise<{ changed: Map<number, Flags>; vanished: Set<number> }> {
    const fetched = new Map<number, Flags>();
    for (let i = 0; i < uids.length; i += 2000) {
      const set = uidSet(uids.slice(i, i + 2000));
      for await (const m of c.fetch(set, { uid: true, flags: true }, { uid: true, ...(since !== null ? { changedSince: since } : {}) })) fetched.set(m.uid, flagsOf(m.flags));
    }
    const { changed, vanished } = this.timed('flagDiff', `${folder} ${uids.length} rows`, () => flagDiff(this.cache.flags(r.id, folder, validity, uids), fetched, since === null, started));
    const now = Date.now();
    for (const f of changed) {
      this.cache.setFlags(r.id, folder, [f.uid], f, now);
      const o = this.opened.get(`${r.id}/${folder}/${f.uid}`);
      if (o) o.detail = { ...o.detail, seen: f.seen, flagged: f.flagged, answered: f.answered };
    }
    return { changed: new Map(changed.map((f) => [f.uid, f])), vanished: new Set(vanished) };
  }

  // ---- opening a message ----------------------------------------------------------------------------------------------

  /**
   * A message, opened by its parts (body.ts): one FETCH of the summary, the structure and a few headers, then one of just
   * the text parts, the inline pictures and other small parts. Only a structure postal-mime would read differently from
   * its parts (an inline forwarded message) is downloaded whole, as before. The last three opened are kept.
   */
  private async read(r: AccountRow, folder: string, uid: number): Promise<Opened> {
    const key = `${r.id}/${folder}/${uid}`;
    const have = this.opened.get(key);
    if (have) return have;
    const t = timing.getStore();
    // From the prefetch cache when it holds the body: no round trip (its attachments are fetched by the stored plan).
    const state = this.cache.folder(r.id, folder);
    const cached = state ? this.cache.body(r.id, folder, state.validity, uid) : null;
    if (cached) {
      if (t) t.cache = 'hit';
      const opened: Opened = { detail: cached.detail, plan: cached.plan, parts: new Map() };
      this.opened.set(key, opened);
      return opened;
    }
    if (t) t.cache = 'live';
    const opened = await this.withFolder(r, folder, 'interactive', async (c): Promise<Opened> => {
      const m = await c.fetchOne(String(uid), { ...CACHE_QUERY, headers: DETAIL_HEADERS }, { uid: true });
      if (!m) throw notFound('no such message');
      const summary = toSummary(m, folder);
      const plan = planBody(m.bodyStructure);
      // A message the cache has a row for keeps the body once read (`cacheBody`), as the alarm would have fetched it.
      const row = state && state.validity === this.validity(c) ? this.cache.bodyStates(r.id, folder, state.validity, [uid]).get(uid) : undefined;
      const threadId = state ? this.cache.threadOf(r.id, folder, uid) : null;
      const keep = (o: Opened): Opened => {
        if (row === BODY.pending || row === BODY.evicted) this.cacheBody(r.id, folder, uid, o.detail, o.plan);
        return threadId ? { ...o, detail: { ...o.detail, threadId } } : o;
      };
      if (!plan.simple) {
        if ((m.size ?? 0) > MAX_MESSAGE_BYTES) throw mailError(413, 'bad_request', 'the message is too large to open here');
        const download = await c.download(String(uid), undefined, { uid: true, chunkSize: 1024 * 1024 });
        if (!download?.content) throw notFound('no such message');
        const email = await PostalMime.parse(await streamBytes(download.content, MAX_MESSAGE_BYTES), { attachmentEncoding: 'arraybuffer' });
        // Only the parts worth keeping (pictures and small files): three whole large messages would not fit in memory.
        const parts: Opened['parts'] = new Map();
        email.attachments.forEach((a, i) => {
          const content = typeof a.content === 'string' ? Buffer.from(a.content) : Buffer.from(a.content as ArrayBuffer);
          if (content.length <= PREFETCH.inlineMax) parts.set(i, { content, mimeType: a.mimeType, filename: a.filename ?? `attachment-${i + 1}` });
        });
        return keep({ detail: toDetail(summary, email), plan: null, parts });
      }
      if (plan.texts.some((l) => l.size > MAX_TEXT_BYTES)) throw mailError(413, 'bad_request', 'the message is too large to open here');
      const extra = prefetch(plan.attachments, PREFETCH);
      const sections = [...plan.texts.map((l) => l.section), ...extra.map((a) => a.leaf.section)];
      const bodies = new Map<string, Uint8Array>();
      if (sections.length) {
        const got = await c.fetchOne(String(uid), { uid: true, bodyParts: sections }, { uid: true });
        for (const s of sections) {
          const bytes = section(got, s);
          if (bytes) bodies.set(s, bytes);
        }
      }
      const email = await PostalMime.parse(minimalMessage(m.headers, plan, bodies), { attachmentEncoding: 'arraybuffer' });
      const parts: Opened['parts'] = new Map();
      for (const a of extra) {
        const bytes = bodies.get(a.leaf.section);
        if (bytes) parts.set(a.index, { content: decodeTransfer(bytes, a.leaf.encoding), mimeType: a.mimeType, filename: a.filename });
      }
      const attachments: AttachmentInfo[] = plan.attachments.map((a) => ({
        index: a.index, filename: a.filename, mimeType: a.mimeType, size: parts.get(a.index)?.content.length ?? decodedSize(a.leaf), contentId: a.contentId, inline: a.inline,
      }));
      return keep({ detail: toDetail(summary, email, attachments), plan, parts });
    });
    this.opened.set(key, opened);
    while (this.opened.size > 3) this.opened.delete(this.opened.keys().next().value!);
    return opened;
  }

  /** Keeps a message's body in the cache (its row must exist), unless it is too large or was read whole (not by its parts). */
  private cacheBody(accountId: string, folder: string, uid: number, detail: MessageDetail, plan: BodyPlan | null): void {
    const { html, text, ...rest } = detail;
    if (!plan) { this.cache.setBody(accountId, folder, uid, null, BODY.notByParts); return; }
    if ((html?.length ?? 0) > BODY_MAX_HTML || (text?.length ?? 0) > BODY_MAX_TEXT) { this.cache.setBody(accountId, folder, uid, null, BODY.tooLarge); return; }
    this.cache.setBody(accountId, folder, uid, { detail: rest, html, text, plan }, BODY.cached);
  }

  /**
   * The alarm's body step: the bodies of cached messages not fetched yet, the folder looked at last first, unread and
   * newest first within it, BODY_BATCH messages or BODY_BATCH_BYTES per run. Rows with the same text parts are fetched in
   * one command (as the snippets are); each is then parsed as an opened message is (`minimalMessage`, postal-mime) and
   * kept, or marked too large or not openable by its parts. A folder's bodies past BODY_BUDGET_PER_FOLDER lose the oldest.
   */
  private async prefetchBodies(r: AccountRow, c: ImapFlow, deadline: number): Promise<string> {
    let fetched = 0, bytes = 0, skipped = 0;
    const folders = this.cache.folders(r.id).sort((a, b) => b.openedAt - a.openedAt);
    for (const f of folders) {
      if (fetched >= BODY_BATCH || bytes >= BODY_BATCH_BYTES || Date.now() > deadline) break;
      if (!f.validity || f.high === 0) continue;
      const queue = this.timed('bodyQueue', f.folder, () => this.cache.bodyQueue(r.id, f.folder, f.validity, BODY_BATCH - fetched));
      if (!queue.length) continue;
      await this.locked(c, f.folder, async () => {
        if (this.validity(c) !== f.validity) return;
        const todo: QueuedBody[] = [];
        for (const q of queue) {
          if (!q.plan.simple) { this.cache.setBody(r.id, f.folder, q.uid, null, BODY.notByParts); skipped++; continue; }
          const size = q.plan.texts.reduce((n, l) => n + l.size, 0);
          if (q.plan.texts.some((l) => l.size > MAX_TEXT_BYTES) || size > BODY_MAX_HTML + BODY_MAX_TEXT) { this.cache.setBody(r.id, f.folder, q.uid, null, BODY.tooLarge); skipped++; continue; }
          if (bytes + size > BODY_BATCH_BYTES && todo.length) break;
          bytes += size;
          todo.push(q);
        }
        // One FETCH per distinct set of text sections.
        const groups = new Map<string, QueuedBody[]>();
        for (const q of todo) { const k = q.plan.texts.map((l) => l.section).join(','); groups.set(k, [...(groups.get(k) ?? []), q]); }
        for (const [, rows] of groups) {
          const sections = rows[0].plan.texts.map((l) => l.section);
          const byUid = new Map(rows.map((q) => [q.uid, q]));
          this.step(`bodies ${f.kind}: fetch ${rows.length} (${sections.join(',')})`);
          for await (const m of c.fetch(uidSet(rows.map((q) => q.uid)), { uid: true, bodyParts: sections }, { uid: true })) {
            const q = byUid.get(m.uid);
            if (!q) continue;
            this.step(`bodies ${f.kind}: parse uid ${m.uid} (${q.plan.texts.reduce((n, l) => n + l.size, 0)} bytes)`);
            const bodies = new Map<string, Uint8Array>();
            for (const s of sections) { const b = section(m, s); if (b) bodies.set(s, b); }
            const raw = this.timed('minimalMessage', `${f.folder} uid ${m.uid}`, () => minimalMessage(q.headers ?? undefined, q.plan, bodies));
            const t0 = Date.now();
            const email = await PostalMime.parse(raw, { attachmentEncoding: 'arraybuffer' });
            this.timed('parse', `${f.folder} uid ${m.uid} ${raw.length} bytes (${Date.now() - t0}ms)`, () => undefined);
            const attachments: AttachmentInfo[] = q.plan.attachments.map((a) => ({ index: a.index, filename: a.filename, mimeType: a.mimeType, size: decodedSize(a.leaf), contentId: a.contentId, inline: a.inline }));
            this.timed('cacheBody', `${f.folder} uid ${m.uid}`, () => this.cacheBody(r.id, f.folder, q.uid, toDetail(q.summary, email, attachments), q.plan));
            byUid.delete(m.uid);
            fetched++;
          }
          // A message the server no longer returned has left the folder.
          if (byUid.size) this.left(r.id, f.folder, [...byUid.keys()]);
        }
      });
      this.step(`bodies ${f.kind}: evict`);
      const evicted = this.timed('evictBodies', f.folder, () => this.cache.evictBodies(r.id, f.folder, BODY_BUDGET_PER_FOLDER));
      if (evicted) skipped += evicted;
    }
    return `${fetched} bodies${skipped ? `, ${skipped} skipped` : ''}`;
  }

  /** One attachment's bytes: kept from opening the message, else that part alone, in one FETCH. */
  private async attachment(r: AccountRow, folder: string, uid: number, index: number): Promise<{ content: Buffer; mimeType: string; filename: string }> {
    const opened = this.opened.get(`${r.id}/${folder}/${uid}`);
    const kept = opened?.parts.get(index);
    if (kept) return kept;
    return this.withFolder(r, folder, 'interactive', async (c) => {
      // The plan from the message as opened, else from its cached row, else from the server.
      let plan = opened?.plan ?? this.cache.plan(r.id, folder, uid);
      if (!plan) {
        const m = await c.fetchOne(String(uid), { uid: true, bodyStructure: true }, { uid: true });
        if (!m) throw notFound('no such message');
        plan = planBody(m.bodyStructure);
      }
      if (!plan.simple) {
        // Read whole, as it was opened.
        const download = await c.download(String(uid), undefined, { uid: true, chunkSize: 1024 * 1024 });
        if (!download?.content) throw notFound('no such message');
        const email = await PostalMime.parse(await streamBytes(download.content, MAX_MESSAGE_BYTES), { attachmentEncoding: 'arraybuffer' });
        const a = email.attachments[index];
        if (!a) throw notFound('no such attachment');
        return { content: typeof a.content === 'string' ? Buffer.from(a.content) : Buffer.from(a.content as ArrayBuffer), mimeType: a.mimeType, filename: a.filename ?? `attachment-${index + 1}` };
      }
      const a = plan.attachments[index];
      if (!a) throw notFound('no such attachment');
      if (a.leaf.size > MAX_MESSAGE_BYTES) throw mailError(413, 'bad_request', 'the attachment is too large to download here');
      const got = await c.fetchOne(String(uid), { uid: true, bodyParts: [a.leaf.section] }, { uid: true });
      const bytes = section(got, a.leaf.section);
      if (!bytes) throw notFound('no such attachment');
      return { content: decodeTransfer(bytes, a.leaf.encoding), mimeType: a.mimeType, filename: a.filename };
    });
  }

  /** A message's files: those sent with it, and the attachments (not inline pictures) of the one named in `attachFrom`. */
  private async filesOf(r: AccountRow, body: ReturnType<typeof SendBody.parse>): Promise<OutgoingFile[]> {
    const files: OutgoingFile[] = (body.attachments ?? []).map((a) => ({ filename: a.filename, contentType: a.contentType, content: Buffer.from(a.contentBase64, 'base64'), contentId: a.contentId, inline: a.inline }));
    if (body.attachFrom) {
      const { folder, uid } = body.attachFrom;
      const { detail } = await this.read(r, folder, uid);
      // Its files, and its inline pictures where the HTML still shows them (a draft sent as it is).
      for (const a of detail.attachments.filter((x) => !x.inline || (x.contentId && body.html.includes(`cid:${x.contentId}`)))) {
        const got = await this.attachment(r, folder, uid, a.index);
        files.push({ filename: got.filename || a.filename, contentType: got.mimeType || a.mimeType, content: got.content, ...(a.inline && a.contentId ? { contentId: a.contentId, inline: true } : {}) });
      }
    }
    const bodies = new TextEncoder().encode(body.html).length + new TextEncoder().encode(body.text ?? '').length;
    if (bodies + files.reduce((n, f) => n + f.content.length, 0) > MAX_SEND_BYTES) throw mailError(413, 'bad_request', 'the message is larger than 20 MB');
    return files;
  }

  private async send(r: AccountRow, body: ReturnType<typeof SendBody.parse>): Promise<string> {
    const account = this.toAccount(r);
    const recipients = [...body.to, ...(body.cc ?? []), ...(body.bcc ?? [])];
    if (!recipients.length) throw badRequest('to: name at least one recipient');
    if (sendSize(body) > MAX_SEND_BYTES) throw mailError(413, 'bad_request', 'the message is larger than 20 MB');
    const message = outgoingMessage(account, body, await this.filesOf(r, body));
    const transport = smtpTransport(account.smtp, account.smtp.username || account.email, this.password(r));
    try {
      await transport.sendMail(message);
    } catch (err) {
      const e = err as { code?: string; response?: string; message?: string };
      if (e.code === 'EENVELOPE' || e.code === 'EMESSAGE') throw badRequest(`The outgoing mail server refused the message: ${e.response || e.message}`);
      const f = smtpFailure(err);
      if (f.code === 'auth_failed') this.setStatus(r.id, f.code, f.message);
      throw failed(f);
    } finally {
      transport.close();
    }
    // What follows is bookkeeping: the message has gone, so a failure here is logged, not reported.
    if (!savesSentCopy(account.imap, account.smtp)) {
      await this.withImap(r, 'interactive', async (c) => {
        let sent = await this.special(r, c, 'sent');
        if (!sent) {
          await c.mailboxCreate('Sent').catch(() => {});
          sent = (await this.folderList(r, c, true)).find((f) => specialUseOf(f) === 'sent')?.path ?? 'Sent';
        }
        await c.append(sent, await compileMime(message, true), ['\\Seen']);
        // The conversation is read from the cache (threadRead): the copy joins it now rather than at the next sync, so a
        // client's refetch right after the send shows the reply under its message.
        const f = this.cache.touchFolder(r.id, sent, 'sent', Date.now(), false);
        await this.locked(c, sent, () => this.syncFolder(r, c, f, Date.now() + 5_000));
      }).catch((err) => console.warn(`[mail] sent copy: ${(err as Error).message}`));
    }
    if (body.replacesDraft) await this.deleteDraft(r, body.replacesDraft.folder, body.replacesDraft.uid).catch((err) => console.warn(`[mail] sent draft: ${(err as Error).message}`));
    if (body.inReplyTo) {
      await this.withFolder(r, 'INBOX', 'interactive', async (c) => {
        const uids = (await c.search({ header: { 'message-id': body.inReplyTo! } }, { uid: true })) || [];
        if (uids.length) await c.messageFlagsAdd(uids.join(','), ['\\Answered'], { uid: true });
      }).catch((err) => console.warn(`[mail] answered flag: ${(err as Error).message}`));
      this.cache.setAnswered(r.id, body.inReplyTo, Date.now());
    }
    return message.messageId;
  }

  // ---- drafts -----------------------------------------------------------------------------------------------------

  /** The account's Drafts folder (by its special use), made as "Drafts" when it has none. */
  private async draftsFolder(r: AccountRow, c: ImapFlow): Promise<string> {
    const found = await this.special(r, c, 'drafts');
    if (found) return found;
    await c.mailboxCreate('Drafts').catch(() => {});
    return (await this.folderList(r, c, true)).find((f) => specialUseOf(f) === 'drafts')?.path ?? 'Drafts';
  }

  /**
   * Saves a draft: the message built as a send would build it (Bcc kept), appended to Drafts with \Draft and \Seen. Its
   * UID is the server's answer (UIDPLUS), else found by its Message-ID. A draft it replaces is deleted afterwards.
   */
  private async saveDraft(r: AccountRow, body: ReturnType<typeof DraftBody.parse>): Promise<{ folder: string; uid: number | null; messageId: string }> {
    if (sendSize(body) > MAX_SEND_BYTES) throw mailError(413, 'bad_request', 'the message is larger than 20 MB');
    const message = outgoingMessage(this.toAccount(r), body, await this.filesOf(r, body));
    const raw = await compileMime(message, true);
    const saved = await this.withImap(r, 'interactive', async (c) => {
      const folder = await this.draftsFolder(r, c);
      const appended = await c.append(folder, raw, ['\\Draft', '\\Seen']);
      let uid = appended && typeof appended.uid === 'number' ? appended.uid : null;
      if (uid === null) {
        uid = await this.locked(c, folder, async () => {
          const found = (await c.search({ header: { 'message-id': message.messageId } }, { uid: true })) || [];
          return found.length ? Math.max(...found) : null;
        });
      }
      this.folderLists.delete(r.id);
      return { folder, uid };
    });
    if (body.replacesDraft) await this.deleteDraft(r, body.replacesDraft.folder, body.replacesDraft.uid).catch((err) => console.warn(`[mail] replaced draft: ${(err as Error).message}`));
    return { ...saved, messageId: message.messageId };
  }

  /** Removes a draft for good: only a message in the Drafts folder, so this never deletes anything else. */
  private async deleteDraft(r: AccountRow, folder: string, uid: number): Promise<void> {
    await this.withImap(r, 'interactive', async (c) => {
      const drafts = await this.special(r, c, 'drafts');
      if (!drafts || drafts !== folder) throw badRequest('folder: only a message in the Drafts folder can be deleted as a draft');
      await this.locked(c, folder, async () => {
        const m = await c.fetchOne(String(uid), { uid: true, flags: true }, { uid: true });
        if (!m) throw notFound('no such draft');
        await c.messageDelete(String(uid), { uid: true });
      });
    });
    this.left(r.id, folder, [uid]);
  }

  /** Sends a saved draft as it is (its recipients, bodies, threading and attachments), then deletes it. */
  private async sendDraft(r: AccountRow, folder: string, uid: number): Promise<string> {
    const drafts = await this.withImap(r, 'interactive', (c) => this.special(r, c, 'drafts'));
    if (!drafts || drafts !== folder) throw badRequest('folder: only a message in the Drafts folder can be sent as a draft');
    const { detail } = await this.read(r, folder, uid);
    const body = parse(SendBody, {
      to: detail.to, cc: detail.cc, bcc: detail.bcc, subject: detail.subject,
      html: detail.html ?? '', ...(detail.text !== null ? { text: detail.text } : {}),
      ...(detail.inReplyTo ? { inReplyTo: detail.inReplyTo } : {}), ...(detail.references.length ? { references: detail.references } : {}),
      ...(detail.attachments.length ? { attachFrom: { folder, uid } } : {}),
      replacesDraft: { folder, uid },
    });
    return this.send(r, body);
  }

  /** A mail account and everything kept for it. */
  private dropAccount(id: string): void {
    this.forget(id);
    this.sql.exec('DELETE FROM accounts WHERE id = ?', id);
    this.sql.exec('DELETE FROM mail_categories WHERE account_id = ?', id);
    this.sql.exec('DELETE FROM mail_category_overrides WHERE account_id = ?', id);
    this.sql.exec('DELETE FROM mail_sync WHERE account_id = ?', id);
    this.cache.forgetAccount(id);
  }

  // ---- for provisioning (by binding; provisioning/consumer.ts, platform.md §3.4) ----------------------------------------
  // The platform's half of the hosted mailbox: written with the password it set, sealed as a connected one is, and never
  // through a route. Each refuses a call for another account than the object's, as `handle` does.

  private provisioningOwner(account: AccountDTO): void {
    const wrong = ownerMismatch(this.cache, { account, user: null }, 'the Mail');
    if (wrong) throw new Error(wrong);
  }

  /** The hosted mailbox's row, or null. */
  async hostedAccount(account: AccountDTO): Promise<{ id: string; email: string } | null> {
    this.provisioningOwner(account);
    const r = this.sql.exec<{ id: string; email: string }>("SELECT id, email FROM accounts WHERE kind = 'hosted' LIMIT 1").toArray()[0];
    return r ? { id: r.id, email: r.email } : null;
  }

  /** Writes the hosted mailbox: added, or its servers and password replaced (a run again after a partial one). */
  async putHosted(account: AccountDTO, m: HostedMailbox): Promise<{ id: string }> {
    this.provisioningOwner(account);
    const sealed = encryptBlob(Buffer.from(m.password, 'utf8'));
    const secret = new Uint8Array(sealed.blob).buffer;
    const have = this.sql.exec<{ id: string }>("SELECT id FROM accounts WHERE kind = 'hosted' LIMIT 1").toArray()[0];
    if (have) {
      this.sql.exec("UPDATE accounts SET email = ?, imap = ?, smtp = ?, secret = ?, key_id = ?, status = 'ok', status_message = NULL WHERE id = ?",
        m.email, JSON.stringify(m.imap), JSON.stringify(m.smtp), secret, sealed.encKeyId, have.id);
      this.forget(have.id);
      return have;
    }
    const id = crypto.randomUUID();
    this.sql.exec("INSERT INTO accounts (id, kind, email, display_name, imap, smtp, secret, key_id, status, created_at) VALUES (?, 'hosted', ?, ?, ?, ?, ?, ?, 'ok', ?)",
      id, m.email, m.displayName || m.email.split('@')[0], JSON.stringify(m.imap), JSON.stringify(m.smtp), secret, sealed.encKeyId, Date.now());
    await this.armAlarm().catch((err) => console.warn(`[mail] alarm: ${(err as Error).message}`));
    return { id };
  }

  /** The hosted mailbox is gone at the provider (deleted after the retention period): its row goes too. */
  async clearHosted(account: AccountDTO): Promise<void> {
    this.provisioningOwner(account);
    for (const r of this.sql.exec<{ id: string }>("SELECT id FROM accounts WHERE kind = 'hosted'").toArray()) this.dropAccount(r.id);
  }

  // ---- for the Calendar object (by binding; docs/specs/calendar.md §14) ------------------------------------------------
  // The person's Calendar object reads an invitation's part and sends iMIP through these, never through a route: a route
  // that sent prepared mail would be one anybody holding a session could use to send anything. Answers carry their error
  // code (an ApiError does not cross a binding with its code).

  /** The person's mail accounts, as the Calendar object matches addresses: who "me" is, and which account sends. */
  async calendarIdentities(): Promise<{ id: string; email: string; displayName: string; status: string }[]> {
    return this.sql.exec<AccountRow & Record<string, SqlStorageValue>>('SELECT * FROM accounts ORDER BY created_at').toArray().map((r) => ({ id: r.id, email: r.email, displayName: r.display_name, status: r.status }));
  }

  /** One part of a message (an invitation's text/calendar, or its .ics), as `attachments/:index` serves it. */
  async calendarPart(accountId: string, folder: string, uid: number, index: number): Promise<CalendarAnswer<{ content: Uint8Array; mimeType: string; filename: string }>> {
    try {
      const a = await this.attachment(this.row(accountId), folder, uid, index);
      if (a.content.length > MAX_INVITE_BYTES) return { ok: false, status: 413, code: 'bad_request', message: 'the invitation is too large to read' };
      return { ok: true, content: new Uint8Array(a.content), mimeType: a.mimeType, filename: a.filename };
    } catch (err) {
      return answerOf(commandError(err));
    }
  }

  /** Sends an iMIP message (an answer, an invitation, a cancellation) the Calendar object prepared, from one of the person's accounts. */
  async sendCalendarMail(accountId: string, mail: CalendarMail): Promise<CalendarAnswer<{ messageId: string }>> {
    try {
      const r = this.row(accountId);
      const account = this.toAccount(r);
      const message = calendarMessage(account, checkCalendarMail(mail));
      const transport = smtpTransport(account.smtp, account.smtp.username || account.email, this.password(r));
      try {
        await transport.sendMail(message);
      } catch (err) {
        const e = err as { code?: string; response?: string; message?: string };
        if (e.code === 'EENVELOPE' || e.code === 'EMESSAGE') throw badRequest(`The outgoing mail server refused the message: ${e.response || e.message}`);
        const f = smtpFailure(err);
        if (f.code === 'auth_failed') this.setStatus(r.id, f.code, f.message);
        throw failed(f);
      } finally {
        transport.close();
      }
      return { ok: true, messageId: message.messageId };
    } catch (err) {
      return answerOf(err);
    }
  }

  // ---- routes -----------------------------------------------------------------------------------------------------

  private routes(): void {
    const app = this.app;
    app.onError((err, c) => {
      if (err instanceof ApiError) return c.json({ error: { code: err.code, message: err.message } }, err.statusCode as 400);
      console.error(`[mail] ${(err as Error).message}`);
      return c.json({ error: { code: 'server_error', message: 'internal server error' } }, 500);
    });
    app.notFound((c) => c.json({ error: { code: 'not_found', message: 'not found' } }, 404));
    const json = async (c: Context) => c.req.json().catch(() => { throw badRequest('the body is not JSON'); });
    const folderOf = (c: Context) => { const f = c.req.query('folder'); if (!f) throw badRequest('folder: required'); return f; };
    const uidOf = (c: Context) => { const n = Number(c.req.param('uid')); if (!Number.isInteger(n) || n < 1) throw badRequest('uid: not a message id'); return n; };

    app.use('/v1/mail/accounts/:id/*', async (c: MailContext, next) => { c.set('account', this.row(c.req.param('id')!)); await next(); });

    // The hosted mailbox first, then the connected accounts in the order they were added.
    app.get('/v1/mail/accounts', (c) => c.json({ accounts: this.sql.exec<AccountRow & Record<string, SqlStorageValue>>("SELECT * FROM accounts ORDER BY kind = 'hosted' DESC, created_at").toArray().map((r) => this.toAccount(r)) }));

    app.post('/v1/mail/accounts', async (c) => {
      const b = parse(NewAccount, await json(c));
      const email = b.email;
      await this.verify(email, b.imap, b.smtp, b.password);
      const id = crypto.randomUUID();
      const sealed = encryptBlob(Buffer.from(b.password, 'utf8'));
      this.sql.exec('INSERT INTO accounts (id, email, display_name, imap, smtp, secret, key_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        id, email, b.displayName.trim() || email.split('@')[0], JSON.stringify(b.imap), JSON.stringify(b.smtp), new Uint8Array(sealed.blob).buffer, sealed.encKeyId, 'ok', Date.now());
      return c.json({ account: this.toAccount(this.row(id)) }, 201);
    });

    app.patch('/v1/mail/accounts/:id', async (c) => {
      const r = this.row(c.req.param('id'));
      const b = parse(AccountPatch, await json(c));
      if (r.kind === 'hosted' && (b.password !== undefined || b.imap || b.smtp)) throw hostedRefusal();
      const current = this.toAccount(r);
      const imap = b.imap ?? current.imap, smtp = b.smtp ?? current.smtp;
      if (b.password !== undefined || b.imap || b.smtp) {
        await this.verify(r.email, imap, smtp, b.password ?? this.password(r));
        const sealed = b.password !== undefined ? encryptBlob(Buffer.from(b.password, 'utf8')) : null;
        this.sql.exec("UPDATE accounts SET imap = ?, smtp = ?, status = 'ok', status_message = NULL WHERE id = ?", JSON.stringify(imap), JSON.stringify(smtp), r.id);
        if (sealed) this.sql.exec('UPDATE accounts SET secret = ?, key_id = ? WHERE id = ?', new Uint8Array(sealed.blob).buffer, sealed.encKeyId, r.id);
        this.forget(r.id);
      }
      if (b.displayName !== undefined) this.sql.exec('UPDATE accounts SET display_name = ? WHERE id = ?', b.displayName.trim() || r.email.split('@')[0], r.id);
      if (b.tabs !== undefined) this.sql.exec('UPDATE accounts SET tabs = ? WHERE id = ?', JSON.stringify(normalizeTabs(b.tabs)), r.id);
      return c.json({ account: this.toAccount(this.row(r.id)) });
    });

    app.delete('/v1/mail/accounts/:id', (c) => {
      const r = this.row(c.req.param('id'));
      if (r.kind === 'hosted') throw hostedRefusal();
      this.dropAccount(r.id);
      return c.json({ ok: true });
    });

    app.get('/v1/mail/accounts/:id/folders', async (c: MailContext) => {
      const r = c.get('account');
      const list = await this.withImap(r, 'background', async (cl) => {
        const all = await cl.list({ statusQuery: { messages: true, unseen: true } });
        this.folderLists.set(r.id, { at: Date.now(), list: all });
        return all;
      });
      return c.json({ folders: toFolders(list) });
    });

    app.get('/v1/mail/accounts/:id/messages', async (c: MailContext) => {
      const limit = Math.min(200, Math.max(1, Number(c.req.query('limit')) || 50));
      const beforeRaw = c.req.query('before');
      const before = beforeRaw ? Number(beforeRaw) : null;
      if (before !== null && (!Number.isInteger(before) || before < 1)) throw badRequest('before: not a message id');
      const category = c.req.query('category') || null;
      if (category !== null && !(CATEGORIES as readonly string[]).includes(category)) throw badRequest(`category: one of ${CATEGORIES.join(', ')}`);
      const opts = { raw: c.req.query('raw') === '1', unread: c.req.query('unread') === '1' };
      return c.json(await this.list(c.get('account'), c.req.query('folder') || 'INBOX', limit, before, (c.req.query('q') ?? '').trim(), category as Category | null, opts));
    });

    app.post('/v1/mail/accounts/:id/messages/category', async (c: MailContext) => {
      const b = parse(CategoryBody, await json(c));
      if (b.folder.toUpperCase() !== INBOX) throw badRequest('folder: inbox tabs are only for INBOX');
      return c.json({ ok: true, ...(await this.moveToTab(c.get('account'), b.folder, b.uids, b.category)) });
    });

    app.post('/v1/mail/accounts/:id/senders/category', async (c: MailContext) => {
      const b = parse(SendersCategoryBody, await json(c));
      const r = c.get('account');
      for (const s of b.senders) this.setOverride(r.id, s.address, s.category);
      return c.json({ ok: true });
    });

    // What sorted the inbox tabs lately (the last runs, in memory), how the cache stands, and with `?uids=1,2,3` each of
    // those messages' cached tab and reason. Only ever the caller's own account: the object is theirs.
    app.get('/v1/mail/accounts/:id/debug/tabs', (c: MailContext) => {
      const r = c.get('account');
      const folder = c.req.query('folder') || INBOX;
      const state = this.syncState(r, folder);
      const uids = (c.req.query('uids') ?? '').split(',').map((u) => Number(u.trim())).filter((u) => Number.isInteger(u) && u > 0).slice(0, 1000);
      const validity = state?.validity ?? '';
      const counts = this.sql.exec<{ category: string; reason: string; n: number }>(
        'SELECT category, reason, COUNT(*) AS n FROM mail_categories WHERE account_id = ? AND folder = ? AND uid_validity = ? GROUP BY category, reason ORDER BY n DESC LIMIT 100',
        r.id, folder, validity).toArray();
      const messages = uids.length ? this.sql.exec<{ uid: number; category: string; reason: string }>(
        'SELECT uid, category, reason FROM mail_categories WHERE account_id = ? AND folder = ? AND uid_validity = ? AND uid IN (SELECT value FROM json_each(?)) ORDER BY uid DESC',
        r.id, folder, validity, JSON.stringify(uids)).toArray() : undefined;
      return c.json({ folder, sync: state, log: this.tabLog.get(r.id) ?? [], counts, ...(messages ? { messages } : {}) });
    });

    // The composer's address completion: the people written to and heard from, from the cached messages (cache.ts Contacts).
    app.get('/v1/mail/accounts/:id/contacts', (c: MailContext) => {
      const r = c.get('account');
      const limit = Math.min(50, Math.max(1, Number(c.req.query('limit')) || 8));
      this.cache.rebuildContacts(r.id, r.email);
      return c.json({ contacts: this.cache.contacts(r.id, c.req.query('q') ?? '', limit) });
    });

    // How the prefetch cache stands for the account: each cached folder's marks and row count, the last alarm runs (in
    // memory), when the person was last active and when the alarm is next due. Only ever the caller's own account.
    app.get('/v1/mail/accounts/:id/debug/cache', async (c: MailContext) => {
      const r = c.get('account');
      const count = (table: string) => this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE account_id = ?`, r.id).toArray()[0]?.n ?? 0;
      return c.json({
        folders: this.cache.report(r.id), log: this.cacheLog, lastActiveAt: this.cache.lastActiveAt(), nextAlarmAt: await this.ctx.storage.getAlarm(),
        alarmStep: this.cache.state('alarm_step'), alarmProfile: JSON.parse(this.cache.state('alarm_profile') || '{}'), alarmOff: this.env.MAIL_ALARM === 'off',
        tables: { messages: count('mail_messages'), categories: count('mail_categories'), refs: count('mail_refs'), threadIndex: count('mail_thread_index'), overrides: count('mail_category_overrides') },
        databaseBytes: this.sql.databaseSize,
      });
    });

    // One run of the prefetch cache now, for the account's owner (with the alarm off too): what the alarm would do.
    app.post('/v1/mail/accounts/:id/debug/alarm', async (c: MailContext) => {
      c.get('account');
      const start = Date.now();
      await this.runCache(Date.now() + ALARM_BUDGET_MS);
      return c.json({ ok: true, ms: Date.now() - start, run: this.cacheLog[this.cacheLog.length - 1] ?? null, alarmProfile: JSON.parse(this.cache.state('alarm_profile') || '{}') });
    });

    // The inbox tabs' badges: per tab, how many messages arrived after the newest the person saw there (`after=tab:uid,…`),
    // how many are unread, and the newest message; from the cache, so the tab bar can ask every minute at no cost.
    app.get('/v1/mail/accounts/:id/tabs', (c: MailContext) => {
      const r = c.get('account');
      const folder = c.req.query('folder') || INBOX;
      const tabs = folder.toUpperCase() === INBOX ? this.tabsOf(r) : [];
      const state = this.cache.folder(r.id, folder);
      if (!tabs.length || !state || !state.validity || state.high === 0) return c.json({ tabs: [] });
      const after = new Map<string, number>();
      for (const part of (c.req.query('after') ?? '').split(',')) {
        const [tab, uid] = part.split(':');
        if (tab && (CATEGORIES as readonly string[]).includes(tab) && Number.isInteger(Number(uid)) && Number(uid) > 0) after.set(tab, Number(uid));
      }
      const e = effectiveSql(tabs);
      const status = this.cache.tabStatus(r.id, folder, state.validity, state.low, { tab: e.sql, params: e.params }, after);
      const order = ['primary', ...tabs] as string[];
      return c.json({ tabs: order.map((category) => status.find((s) => s.category === category) ?? { category, total: 0, unread: 0, new: 0, newest: null }) });
    });

    app.get('/v1/mail/accounts/:id/threads', async (c: MailContext) => {
      const limit = Math.min(100, Math.max(1, Number(c.req.query('limit')) || 25));
      const beforeRaw = c.req.query('before');
      const before = beforeRaw ? Number(beforeRaw) : null;
      if (before !== null && (!Number.isInteger(before) || before < 1)) throw badRequest('before: not a message id');
      const category = c.req.query('category') || null;
      if (category !== null && !(CATEGORIES as readonly string[]).includes(category)) throw badRequest(`category: one of ${CATEGORIES.join(', ')}`);
      const r = c.get('account');
      const folder = c.req.query('folder') || 'INBOX';
      const tabs = folder.toUpperCase() === INBOX ? this.tabsOf(r) : [];
      return c.json(await this.threadList(r, folder, tabs, tabs.length ? (category as Category | null) : null, limit, before));
    });

    app.get('/v1/mail/accounts/:id/threads/:threadId', (c: MailContext) => {
      const threadId = c.req.param('threadId');
      if (!threadId) throw badRequest('threadId: required');
      return c.json({ thread: this.threadRead(c.get('account'), threadId, c.req.query('folder') || null) });
    });

    app.get('/v1/mail/accounts/:id/messages/:uid', async (c: MailContext) => {
      const { detail } = await this.read(c.get('account'), folderOf(c), uidOf(c));
      return c.json({ message: detail });
    });

    app.get('/v1/mail/accounts/:id/messages/:uid/attachments/:index', async (c: MailContext) => {
      const index = Number(c.req.param('index'));
      if (!Number.isInteger(index) || index < 0) throw notFound('no such attachment');
      const a = await this.attachment(c.get('account'), folderOf(c), uidOf(c), index);
      const type = a.mimeType || 'application/octet-stream';
      // Served from the app's own origin: only a picture may be shown inline, and nothing it holds may run.
      const inline = c.req.query('inline') === '1' && /^image\/(png|jpe?g|gif|webp|bmp|avif)$/i.test(type);
      return new Response(new Uint8Array(a.content), {
        headers: {
          'content-type': inline ? type : type.replace(/[^\w.+/-]/g, ''),
          'content-disposition': contentDisposition(inline ? 'inline' : 'attachment', a.filename || `attachment-${index + 1}`),
          'x-content-type-options': 'nosniff',
          'content-security-policy': "sandbox; default-src 'none'",
          'cache-control': 'private, max-age=3600',
        },
      });
    });

    app.patch('/v1/mail/accounts/:id/messages', async (c: MailContext) => {
      const b = parse(FlagsBody, await json(c));
      const r = c.get('account');
      // Flags go on the background connection: the app has already shown the change, and marking the message just read
      // must not hold up opening the next one, which uses the interactive connection.
      await this.withFolder(r, b.folder, 'background', async (cl) => {
        const range = b.uids.join(',');
        const set = async (flag: string, on: boolean | undefined) => {
          if (on === undefined) return;
          await (on ? cl.messageFlagsAdd(range, [flag], { uid: true }) : cl.messageFlagsRemove(range, [flag], { uid: true }));
        };
        await set('\\Seen', b.seen);
        await set('\\Flagged', b.flagged);
      });
      // The kept copy of an open message, and the cached rows, say what the flags are now.
      for (const uid of b.uids) {
        const o = this.opened.get(`${r.id}/${b.folder}/${uid}`);
        if (o) o.detail = { ...o.detail, ...(b.seen !== undefined ? { seen: b.seen } : {}), ...(b.flagged !== undefined ? { flagged: b.flagged } : {}) };
      }
      this.cache.setFlags(r.id, b.folder, b.uids, { ...(b.seen !== undefined ? { seen: b.seen } : {}), ...(b.flagged !== undefined ? { flagged: b.flagged } : {}) }, Date.now());
      return c.json({ ok: true });
    });

    app.post('/v1/mail/accounts/:id/messages/move', async (c: MailContext) => {
      const b = parse(MoveBody, await json(c));
      const r = c.get('account');
      if (b.to === b.folder) return c.json({ ok: true });
      await this.withFolder(r, b.folder, 'interactive', async (cl) => {
        if (!(await cl.messageMove(b.uids.join(','), b.to, { uid: true }))) throw badRequest('the mail server did not move the messages');
      });
      this.left(r.id, b.folder, b.uids);
      return c.json({ ok: true });
    });

    app.post('/v1/mail/accounts/:id/messages/delete', async (c: MailContext) => {
      const b = parse(DeleteBody, await json(c));
      const r = c.get('account');
      await this.withImap(r, 'interactive', async (cl) => {
        const trash = await this.special(r, cl, 'trash');
        if (b.trashOnly && !trash) throw mailError(409, 'conflict', 'this account has no Trash folder, so nothing was deleted');
        if (b.trashOnly && trash === b.folder) throw mailError(409, 'conflict', 'these messages are already in Trash; nothing was deleted');
        await this.locked(cl, b.folder, async () => {
          if (!trash || trash === b.folder) await cl.messageDelete(b.uids.join(','), { uid: true });
          else if (!(await cl.messageMove(b.uids.join(','), trash, { uid: true }))) throw badRequest('the mail server did not move the messages to Trash');
        });
      });
      this.left(r.id, b.folder, b.uids);
      return c.json({ ok: true });
    });

    app.post('/v1/mail/accounts/:id/send', async (c: MailContext) => {
      if (Number(c.req.header('content-length') ?? 0) > MAX_SEND_BYTES * 1.4 + 1_000_000) throw mailError(413, 'bad_request', 'the message is larger than 20 MB');
      const b = parse(SendBody, await json(c));
      return c.json({ ok: true, messageId: await this.send(c.get('account'), b) });
    });

    app.post('/v1/mail/accounts/:id/drafts', async (c: MailContext) => {
      if (Number(c.req.header('content-length') ?? 0) > MAX_SEND_BYTES * 1.4 + 1_000_000) throw mailError(413, 'bad_request', 'the message is larger than 20 MB');
      const b = parse(DraftBody, await json(c));
      return c.json({ ok: true, ...(await this.saveDraft(c.get('account'), b)) }, 201);
    });

    app.delete('/v1/mail/accounts/:id/drafts/:uid', async (c: MailContext) => {
      await this.deleteDraft(c.get('account'), folderOf(c), uidOf(c));
      return c.json({ ok: true });
    });

    app.post('/v1/mail/accounts/:id/drafts/:uid/send', async (c: MailContext) => {
      return c.json({ ok: true, messageId: await this.sendDraft(c.get('account'), folderOf(c), uidOf(c)) });
    });
  }

  /** Messages that left a folder (through us, or seen gone): their kept copies, their cached tabs and their cached rows go. */
  private left(id: string, folder: string, uids: number[]): void {
    for (const key of [...this.opened.keys()]) if (key.startsWith(`${id}/${folder}/`)) this.opened.delete(key);
    this.forgetRows(id, folder, uids);
    this.cache.remove(id, folder, uids);
  }
}
