// FreeFlow Mail: one object per person (`idFromName(userId)`), holding the mail accounts they connected and talking to
// those accounts' own servers over IMAP and SMTP. The contract is docs/specs/mail-api.md.
//
// The accounts are in the object's SQLite, each password sealed with FLOW_DATA_KEY (org/crypto, the same scheme as Chat's
// files) and never returned or logged. While the object is awake it keeps up to two IMAP connections per account: an
// "interactive" one for what the user is waiting on (opening a message and its attachments, flags, moves, deletes, the
// IMAP side of sending) and a "background" one for lists, folders, the tab counts and sorting mail into tabs, so a slow
// list never holds up opening a message. Each is opened when first needed, reused, and logged out after a minute with
// nothing to do; a request finding it dropped opens another. Every operation on a folder holds that connection's lock on
// it (imapflow's getMailboxLock, which is per connection).
import { AsyncLocalStorage } from 'node:async_hooks';
import { DurableObject } from 'cloudflare:workers';
import { connect } from 'cloudflare:sockets';
import { Hono, type Context } from 'hono';
import { ImapFlow, createSocketsTransport, type FetchMessageObject, type FetchQueryObject, type ListResponse, type SearchObject } from 'imapflow';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer';
import PostalMime, { type Email } from 'postal-mime';
import { ApiError } from '../errors';
import { decryptBlob, encryptBlob } from '../org/crypto/index';
import { decodeTransfer, decodedSize, minimalMessage, planBody, prefetch, type BodyPlan } from './body';
import { contentDisposition, specialUseOf, snippetOf, textPartOf, toDetail, toFolders, toSummary, type AttachmentInfo, type MessageDetail, type MessageSummary, type SpecialUse, type TextPart } from './convert';
import { CATEGORIES, CATEGORY_HEADERS, classifyHeaders, effective, effectiveSql, gmailCategorySearches, isGmailHost, normalizeTabs, parseHeaders, uidSet, type Category, type TabCategory } from './categorize';
import { AccountPatch, CategoryBody, DeleteBody, FlagsBody, MAX_SEND_BYTES, MoveBody, NewAccount, SendBody, SendersCategoryBody, checkServer, mailError, notFound, parse, savesSentCopy, sendSize, badRequest, type ServerSettings } from './rules';

export interface MailEnv {
  FLOW_DATA_KEY?: string;
  /** `1` lets an account use `security: 'none'`, any port and a local host: local dev against GreenMail only. */
  MAIL_ALLOW_INSECURE?: string;
}

interface AccountRow {
  id: string; email: string; display_name: string; imap: string; smtp: string;
  secret: ArrayBuffer; key_id: string; status: string; status_message: string | null; created_at: number; tabs: string | null;
}
interface Account {
  id: string; email: string; displayName: string; imap: ServerSettings; smtp: ServerSettings;
  status: 'ok' | 'auth_failed' | 'connect_failed'; statusMessage?: string;
  tabs: TabCategory[];
}
/** One INBOX message's tab (Gmail's own, or as its headers decide it), with what the tab bar shows of it. */
interface CategoryRow { uid: number; sender: string; from_name: string; subject: string; date: number; category: string; reason: string }
interface TabCount { id: Category; unread: number; new: number; latest: { from: { name: string; address: string } | null; subject: string } | null }
/** How far the cache of a folder's tabs reaches: every UID of the folder from `low` to `high` has its row. */
interface SyncState { validity: string; high: number; low: number; checkedAt: number }
/** A message as opened: what GET returns, and the parts already here (so its inline pictures do not each fetch again). */
interface Opened { detail: MessageDetail; plan: BodyPlan | null; parts: Map<number, { content: Buffer; mimeType: string; filename: string }> }

type Kind = 'interactive' | 'background';
/** Where one request's time went, for its log line: waiting for a connection and a folder's lock, and talking IMAP. */
interface Timing { wait: number; imap: number; test: TestHooks }
/** Local dev only (MAIL_ALLOW_INSECURE=1), from x-mail-test-* headers, for test/e2e-mail.mjs. */
interface TestHooks { slowMs: number; cap: number | null; recheck: boolean }
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
/** The tab counts are kept this long per account, unless something here changes them. */
const COUNTS_TTL_MS = 20_000;
/** How often the whole cached INBOX is checked again against the server (Gmail re-sorting, mail moved elsewhere). */
const RECHECK_MS = 10 * 60_000;
const DDL = [
  `CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, email TEXT NOT NULL, display_name TEXT NOT NULL, imap TEXT NOT NULL, smtp TEXT NOT NULL,
    secret BLOB NOT NULL, key_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ok', status_message TEXT, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS rate_limit_windows (key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL DEFAULT 1)`,
  // Inbox tabs: each INBOX message's tab (Gmail's category, or by its headers elsewhere), kept per UIDVALIDITY so neither a
  // list nor the tab counts ask the server twice; and the tab the user chose for a sender ("Move to tab").
  `CREATE TABLE IF NOT EXISTS mail_categories (account_id TEXT NOT NULL, folder TEXT NOT NULL, uid_validity TEXT NOT NULL, uid INTEGER NOT NULL,
    sender TEXT NOT NULL, from_name TEXT NOT NULL, subject TEXT NOT NULL, date INTEGER NOT NULL, category TEXT NOT NULL, reason TEXT NOT NULL,
    PRIMARY KEY (account_id, folder, uid_validity, uid))`,
  `CREATE TABLE IF NOT EXISTS mail_category_overrides (account_id TEXT NOT NULL, sender TEXT NOT NULL, category TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (account_id, sender))`,
  // How far mail_categories reaches per folder (SyncState): `high` is the newest UID sorted, the high-water mark.
  `CREATE TABLE IF NOT EXISTS mail_sync (account_id TEXT NOT NULL, folder TEXT NOT NULL, uid_validity TEXT NOT NULL, high INTEGER NOT NULL, low INTEGER NOT NULL,
    checked_at INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (account_id, folder))`,
];
/** Columns added after the first release, each added once (ALTER fails when the column is already there). */
const ADDED_COLUMNS = [`ALTER TABLE accounts ADD COLUMN tabs TEXT NOT NULL DEFAULT '[]'`];
/** Messages sorted into tabs per request at most (the rest is sorted as the list pages on, or in the background). */
const CLASSIFY_CAP = 300;
/** Unread messages sorted per background re-check at most. */
const BACKFILL_CAP = 1000;
const INBOX = 'INBOX';

type Failure = { code: 'auth_failed' | 'connect_failed'; message: string };
const SUMMARY_QUERY: FetchQueryObject = { uid: true, envelope: true, flags: true, bodyStructure: true, size: true, internalDate: true };
/** The headers kept for postal-mime when a message is opened by its parts: what MessageDetail needs beyond the envelope. */
const DETAIL_HEADERS = ['from', 'reply-to', 'bcc', 'in-reply-to', 'references'];

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
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** The request's route for its log line, with the ids taken out (no account, message or folder ever appears). */
const routeOf = (method: string, url: string) =>
  `${method} ${new URL(url).pathname.replace(/\/accounts\/[^/]+/, '/accounts/:id').replace(/\/messages\/\d+/, '/messages/:uid').replace(/\/attachments\/[^/]+/, '/attachments/:index')}`;

type MailContext = Context<{ Variables: { account: AccountRow } }>;

export class Mail extends DurableObject<MailEnv> {
  private readonly sql: SqlStorage;
  private readonly app = new Hono<{ Variables: { account: AccountRow } }>();
  /** The open connections, `<account>/<kind>`, as the promise of each, so two requests at once share one login. */
  private readonly conns = new Map<string, Promise<ImapFlow>>();
  private readonly users = new Map<string, number>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly folderLists = new Map<string, { at: number; list: ListResponse[] }>();
  /** The last few messages opened, so a message's inline images do not each fetch it again. */
  private readonly opened = new Map<string, Opened>();
  /** The tab counts per account, for COUNTS_TTL_MS. */
  private readonly counts = new Map<string, { at: number; key: string; counts: TabCount[] }>();
  /** Bumped when something here changes an account's counts, so a count started before is not kept. */
  private readonly countsEpoch = new Map<string, number>();
  /** Accounts whose INBOX is being re-checked in the background. */
  private readonly rechecking = new Set<string>();

  constructor(ctx: DurableObjectState, env: MailEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    for (const statement of DDL) this.sql.exec(statement);
    for (const statement of ADDED_COLUMNS) {
      try { this.sql.exec(statement); } catch { /* already added */ }
    }
    this.routes();
  }

  /** A request from routes/mail.ts, made by the person this object belongs to. Logs one line of where its time went. */
  async handle(request: Request): Promise<Response> {
    const t: Timing = { wait: 0, imap: 0, test: { slowMs: 0, cap: null, recheck: false } };
    // Local dev only: a pause where sorting runs (holding the background lock), a smaller sorting budget, and the re-check now.
    if (this.allowInsecure) {
      const h = request.headers;
      t.test = { slowMs: Math.min(10_000, Number(h.get('x-mail-test-slow-ms')) || 0), cap: Number(h.get('x-mail-test-classify-cap')) || null, recheck: h.get('x-mail-test-recheck') === '1' };
    }
    const start = Date.now();
    let status = 500;
    try {
      const res = await timing.run(t, () => this.app.fetch(request));
      status = res.status;
      return res;
    } finally {
      console.log(`[mail] ${routeOf(request.method, request.url)} ${status} ${Date.now() - start}ms (lock wait ${Math.round(t.wait)}ms, imap ${Math.round(t.imap)}ms)`);
    }
  }

  // ---- accounts -------------------------------------------------------------------------------------------------

  private get allowInsecure() { return this.env.MAIL_ALLOW_INSECURE === '1'; }

  private row(id: string): AccountRow {
    const row = this.sql.exec<AccountRow & Record<string, SqlStorageValue>>('SELECT * FROM accounts WHERE id = ?', id).toArray()[0];
    if (!row) throw notFound('no such mail account');
    return row;
  }

  private toAccount(r: AccountRow): Account {
    return { id: r.id, email: r.email, displayName: r.display_name, imap: JSON.parse(r.imap), smtp: JSON.parse(r.smtp), status: r.status as Account['status'], ...(r.status_message ? { statusMessage: r.status_message } : {}), tabs: this.tabsOf(r) };
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
    for (const kind of ['interactive', 'background'] as const) {
      const key = `${id}/${kind}`;
      const conn = this.conns.get(key);
      this.conns.delete(key);
      clearTimeout(this.timers.get(key));
      this.timers.delete(key);
      void conn?.then((c) => c.logout()).catch(() => {});
    }
    this.folderLists.delete(id);
    this.dropCounts(id);
    for (const key of [...this.opened.keys()]) if (key.startsWith(`${id}/`)) this.opened.delete(key);
  }

  private dropCounts(id: string): void {
    this.counts.delete(id);
    this.countsEpoch.set(id, (this.countsEpoch.get(id) ?? 0) + 1);
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
    const conn = this.conns.get(key);
    this.conns.delete(key);
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

  /** The test hook (MAIL_ALLOW_INSECURE only): a pause where sorting would run, holding the background lock. */
  private async testSlow(): Promise<void> {
    const ms = timing.getStore()?.test.slowMs ?? 0;
    if (ms > 0) await sleep(ms);
  }

  /** Messages sorted into tabs per request at most. */
  private cap(): number {
    return timing.getStore()?.test.cap ?? CLASSIFY_CAP;
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

  /** Summaries of these UIDs, newest first, with their snippets: one FETCH, then the snippets' partial FETCHes. */
  private async summaries(c: ImapFlow, folder: string, uids: number[], query: FetchQueryObject = SUMMARY_QUERY): Promise<{ fetched: FetchMessageObject[]; snippets: Map<number, string> }> {
    const fetched: FetchMessageObject[] = [];
    if (uids.length) for await (const m of c.fetch(uidSet(uids), query, { uid: true })) fetched.push(m);
    fetched.sort((a, b) => b.uid - a.uid);
    const snippets = await this.snippets(c, fetched).catch((err) => { console.warn(`[mail] snippets: ${(err as Error).message}`); return new Map<number, string>(); });
    return { fetched, snippets };
  }

  private async list(r: AccountRow, folder: string, limit: number, before: number | null, q: string, category: Category | null = null): Promise<{ messages: MessageSummary[]; next: number | null }> {
    const tabs = folder.toUpperCase() === INBOX ? this.tabsOf(r) : [];
    // A search covers the whole folder, as Gmail's does; and with tabs off there is only the one list.
    if (category && !q && tabs.length) return this.tabList(r, folder, tabs, category, limit, before);
    return this.withImap(r, 'background', async (c) => {
      const wasOpen = c.mailbox && c.mailbox.path === folder;
      return this.locked(c, folder, async () => {
        // A folder this connection already had open has not heard of new mail since (no IDLE): ask.
        if (wasOpen && !q && before === null) await c.noop();
        const box = c.mailbox;
        const exists = box ? box.exists : 0;
        if (!exists || (before !== null && before <= 1)) return { messages: [], next: null };
        const fetched: FetchMessageObject[] = [];
        let more: boolean;
        // With tabs on, each page's messages are sorted into them (other servers: from the few headers fetched with it).
        const gmail = tabs.length > 0 && this.isGmail(r, c);
        const query: FetchQueryObject = tabs.length && !gmail ? { ...SUMMARY_QUERY, headers: CATEGORY_HEADERS } : SUMMARY_QUERY;
        if (!q && before === null) {
          const start = Math.max(1, exists - limit + 1);
          more = start > 1;
          for await (const m of c.fetch(`${start}:${exists}`, query)) fetched.push(m);
        } else {
          const range: SearchObject = before !== null ? { uid: `1:${before - 1}` } : {};
          // TEXT already covers the headers; some servers (GreenMail) refuse FROM with a space in it, and then TEXT alone does.
          let found = q ? await c.search({ ...range, or: [{ text: q }, { from: q }, { subject: q }] }, { uid: true }) : await c.search(range.uid ? range : { all: true }, { uid: true });
          if (found === false && q) found = await c.search({ ...range, text: q }, { uid: true });
          if (found === false) throw badRequest('the mail server refused the search');
          found = (found ?? []).sort((a, b) => a - b);
          more = found.length > limit;
          const page = found.slice(-limit);
          if (page.length) for await (const m of c.fetch(page.join(','), query, { uid: true })) fetched.push(m);
        }
        fetched.sort((a, b) => b.uid - a.uid);
        const snippets = await this.snippets(c, fetched).catch((err) => { console.warn(`[mail] snippets: ${(err as Error).message}`); return new Map<number, string>(); });
        const categories = tabs.length ? await this.categoriesOf(r, c, folder, tabs, fetched, gmail) : null;
        const messages = fetched.map((m) => ({ ...toSummary(m, folder, snippets.get(m.uid) ?? ''), ...(categories ? { category: categories.get(m.uid) ?? 'primary' } : {}) }));
        return { messages, next: more && messages.length ? messages[messages.length - 1].uid : null };
      });
    });
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
   * Sorts these UIDs of the open folder into tabs and caches them. Gmail: its own categories, one X-GM-RAW search per
   * category over the UIDs' range, then one envelope FETCH for the sender, subject and date. Elsewhere: one FETCH of the
   * envelope and the few headers the rules read. In batches, so each command stays short.
   */
  private async classify(r: AccountRow, c: ImapFlow, folder: string, validity: string, uids: number[], gmail: boolean, into?: Map<number, CategoryRow>): Promise<void> {
    if (!uids.length) return;
    await this.testSlow();
    const size = gmail ? 250 : 100;
    const sorted = [...uids].sort((a, b) => b - a);
    for (let i = 0; i < sorted.length; i += size) {
      const batch = sorted.slice(i, i + size);
      if (gmail) {
        const natural = new Map<number, TabCategory>();
        const want = new Set(batch);
        for (const { tab, query } of gmailCategorySearches(batch)) {
          for (const uid of (await c.search(query, { uid: true })) || []) if (want.has(uid) && !natural.has(uid)) natural.set(uid, tab);
        }
        for await (const m of c.fetch(uidSet(batch), { uid: true, envelope: true, internalDate: true }, { uid: true })) {
          const tab = natural.get(m.uid);
          const row = this.store(r, folder, validity, this.rowOf(m, tab ?? 'primary', tab ? `Gmail category:${tab}` : 'Gmail: no category'));
          into?.set(m.uid, row);
        }
      } else {
        for await (const m of c.fetch(uidSet(batch), { uid: true, envelope: true, internalDate: true, headers: CATEGORY_HEADERS }, { uid: true })) {
          const row = this.remember(r, folder, validity, m);
          into?.set(m.uid, row);
        }
      }
    }
  }

  private syncState(r: AccountRow, folder: string): SyncState | null {
    const row = this.sql.exec<{ uid_validity: string; high: number; low: number; checked_at: number }>('SELECT uid_validity, high, low, checked_at FROM mail_sync WHERE account_id = ? AND folder = ?', r.id, folder).toArray()[0];
    return row ? { validity: row.uid_validity, high: row.high, low: row.low, checkedAt: row.checked_at } : null;
  }

  private saveSync(r: AccountRow, folder: string, s: SyncState): void {
    this.sql.exec('INSERT OR REPLACE INTO mail_sync (account_id, folder, uid_validity, high, low, checked_at) VALUES (?, ?, ?, ?, ?, ?)', r.id, folder, s.validity, s.high, s.low, s.checkedAt);
  }

  /**
   * Walks `desc` (UIDs, newest first) sorting the ones not cached yet, at most `budget` of them. Returns how far it got:
   * the last UID looked at, and whether that was all of them.
   */
  private async sortDown(r: AccountRow, c: ImapFlow, folder: string, validity: string, desc: number[], budget: number, gmail: boolean): Promise<{ last: number; done: boolean; sorted: number }> {
    if (!desc.length) return { last: 0, done: true, sorted: 0 };
    const have = this.cachedUids(r, folder, validity, desc);
    const todo: number[] = [];
    let i = 0;
    for (; i < desc.length; i++) {
      if (have.has(desc[i])) continue;
      if (todo.length >= budget) break;
      todo.push(desc[i]);
    }
    await this.classify(r, c, folder, validity, todo, gmail);
    return i >= desc.length ? { last: desc[desc.length - 1], done: true, sorted: todo.length } : { last: desc[i - 1], done: false, sorted: todo.length };
  }

  /**
   * Brings the cache of the open folder up to date with new mail: only the UIDs above the high-water mark are asked about
   * (`UID SEARCH <high+1>:*`), and sorted. The first time, the newest CLASSIFY_CAP messages are. Mail that left the folder
   * and Gmail's re-sorting are the background re-check's (`recheck`). Returns the state, and how many it sorted.
   */
  private async sync(r: AccountRow, c: ImapFlow, folder: string, gmail: boolean): Promise<{ state: SyncState; sorted: number }> {
    const validity = this.validity(c);
    let state = this.syncState(r, folder);
    if (!state || state.validity !== validity) {
      // A new UIDVALIDITY: every UID means something else now.
      this.sql.exec('DELETE FROM mail_categories WHERE account_id = ? AND folder = ? AND uid_validity != ?', r.id, folder, validity);
      state = { validity, high: 0, low: 0, checkedAt: state?.checkedAt ?? 0 };
    }
    let sorted = 0;
    if (state.high === 0) {
      const all = ((await c.search({ all: true }, { uid: true })) || []).sort((a, b) => b - a);
      if (all.length) {
        const got = await this.sortDown(r, c, folder, validity, all, this.cap(), gmail);
        state = { ...state, high: all[0], low: got.done ? 1 : got.last };
        sorted = got.sorted;
      }
    } else {
      const fresh = ((await c.search({ uid: `${state.high + 1}:*` }, { uid: true })) || []).filter((u) => u > state!.high).sort((a, b) => b - a);
      if (fresh.length) {
        const got = await this.sortDown(r, c, folder, validity, fresh, this.cap(), gmail);
        // More new mail than one request sorts: the cache reaches down from the newest again, and the rest is sorted later.
        state = { ...state, high: fresh[0], low: got.done ? state.low : got.last };
        sorted = got.sorted;
      }
    }
    this.saveSync(r, folder, state);
    return { state, sorted };
  }

  /** Extends the cache of the open folder below its `low`, sorting at most `budget` messages. */
  private async extendDown(r: AccountRow, c: ImapFlow, folder: string, state: SyncState, budget: number, gmail: boolean): Promise<{ state: SyncState; sorted: number }> {
    if (state.low <= 1) return { state, sorted: 0 };
    const older = ((await c.search({ uid: `1:${state.low - 1}` }, { uid: true })) || []).filter((u) => u < state.low).sort((a, b) => b - a);
    const got = await this.sortDown(r, c, folder, state.validity, older, budget, gmail);
    const next = { ...state, low: got.done ? 1 : got.last };
    this.saveSync(r, folder, next);
    return { state: next, sorted: got.sorted };
  }

  /** Forgets cached rows (messages that left the folder). */
  private forgetRows(accountId: string, folder: string, uids: number[]): void {
    for (let i = 0; i < uids.length; i += 5000) {
      this.sql.exec('DELETE FROM mail_categories WHERE account_id = ? AND folder = ? AND uid IN (SELECT value FROM json_each(?))', accountId, folder, JSON.stringify(uids.slice(i, i + 5000)));
    }
  }

  /**
   * Starts the background re-check if it is due (at most every RECHECK_MS per account), without waiting for it. The test
   * hook runs it now and waits.
   */
  private async recheckSoon(r: AccountRow, folder: string, now = false): Promise<void> {
    const state = this.syncState(r, folder);
    if (!state || state.high === 0 || (!now && Date.now() - state.checkedAt < RECHECK_MS) || this.rechecking.has(r.id)) return;
    this.rechecking.add(r.id);
    if (now) {
      try { await this.recheck(r, folder); } finally { this.rechecking.delete(r.id); }
      return;
    }
    // Not part of the request that started it: its own time is not that request's.
    const job = timing.run(undefined, () => this.recheck(r, folder))
      .catch((err) => console.warn(`[mail] recheck: ${(err as Error).message}`))
      .finally(() => this.rechecking.delete(r.id));
    this.ctx.waitUntil(job);
  }

  /**
   * The background re-check of a folder's cache: forgets the rows of mail that has left it (one `UID SEARCH ALL`), takes
   * Gmail's current categories for every cached message (one X-GM-RAW search per category over the whole folder), and
   * sorts unread mail that is not cached yet. Each step takes the background lock by itself, so lists go on in between.
   */
  private async recheck(r: AccountRow, folder: string): Promise<void> {
    const step = <T>(fn: (c: ImapFlow, validity: string, gmail: boolean) => Promise<T>) =>
      this.withFolder(r, folder, 'background', (c) => fn(c, this.validity(c), this.isGmail(r, c)));
    const state = this.syncState(r, folder);
    if (!state) return;
    const present = await step(async (c, validity) => (validity === state.validity ? ((await c.search({ all: true }, { uid: true })) || []) : null));
    if (!present) return;
    const all = new Set(present);
    const cached = this.sql.exec<{ uid: number; category: string }>('SELECT uid, category FROM mail_categories WHERE account_id = ? AND folder = ? AND uid_validity = ?', r.id, folder, state.validity).toArray();
    this.forgetRows(r.id, folder, cached.filter((row) => !all.has(row.uid)).map((row) => row.uid));
    const gmail = await step(async (c, validity, isGmail) => {
      if (!isGmail || validity !== state.validity) return isGmail;
      const now = new Map<number, Category>();
      for (const tab of ['promotions', 'social', 'updates', 'forums'] as const) {
        for (const uid of (await c.search({ gmraw: `category:${tab}` }, { uid: true })) || []) if (!now.has(uid)) now.set(uid, tab);
      }
      for (const row of cached) {
        if (!all.has(row.uid)) continue;
        const tab = now.get(row.uid) ?? 'primary';
        if (tab !== row.category) {
          this.sql.exec('UPDATE mail_categories SET category = ?, reason = ? WHERE account_id = ? AND folder = ? AND uid_validity = ? AND uid = ?',
            tab, tab === 'primary' ? 'Gmail: no category' : `Gmail category:${tab}`, r.id, folder, validity, row.uid);
        }
      }
      return true;
    });
    await step(async (c, validity) => {
      if (validity !== state.validity) return;
      const unseen = ((await c.search({ seen: false }, { uid: true })) || []).sort((a, b) => b - a);
      await this.sortDown(r, c, folder, validity, unseen, BACKFILL_CAP, gmail);
    });
    const latest = this.syncState(r, folder);
    if (latest && latest.validity === state.validity) this.saveSync(r, folder, { ...latest, checkedAt: Date.now() });
    this.dropCounts(r.id);
  }

  // ---- inbox tabs: lists and counts -----------------------------------------------------------------------------------

  /** The tab of each message of a page listed without `category`: cached, or sorted now. */
  private async categoriesOf(r: AccountRow, c: ImapFlow, folder: string, tabs: TabCategory[], fetched: FetchMessageObject[], gmail: boolean): Promise<Map<number, Category>> {
    const overrides = this.overrides(r.id);
    const out = new Map<number, Category>();
    if (!fetched.length) return out;
    const validity = this.validity(c);
    const uids = fetched.map((m) => m.uid);
    const cache = this.cachedRows(r, folder, validity, uids);
    if (gmail) await this.classify(r, c, folder, validity, uids.filter((u) => !cache.has(u)), true, cache);
    for (const m of fetched) {
      const row = cache.get(m.uid) ?? (gmail ? undefined : this.remember(r, folder, validity, m));
      out.set(m.uid, row ? this.tabOf(row, overrides, tabs) : 'primary');
    }
    return out;
  }

  /** The SQL of the cached rows of one folder with their tab (`tab`), the user's choices and the enabled tabs applied. */
  private tabRows(tabs: TabCategory[]): { from: string; tab: string; params: string[] } {
    const e = effectiveSql(tabs);
    return { from: 'mail_categories c LEFT JOIN mail_category_overrides o ON o.account_id = c.account_id AND o.sender = c.sender', tab: e.sql, params: e.params };
  }

  /**
   * One page of a tab, newest first, from the cache: new mail is sorted first (`sync`, cheap), then the page is read from
   * SQLite and its summaries fetched in one FETCH. Past what the cache reaches, older mail is sorted as the page needs it,
   * at most CLASSIFY_CAP messages per request; `next` then says where to carry on, so a page can come back short (even
   * empty) with more to come.
   */
  private async tabList(r: AccountRow, folder: string, tabs: TabCategory[], category: Category, limit: number, before: number | null): Promise<{ messages: MessageSummary[]; next: number | null }> {
    const result = await this.withFolder(r, folder, 'background', async (c) => {
      // (Not `c.mailbox.exists`: on a connection that already had INBOX open it may not know of new mail yet; sync asks.)
      if (!c.mailbox || (before !== null && before <= 1)) return { messages: [], next: null };
      if (category !== 'primary' && !tabs.includes(category as TabCategory)) return { messages: [], next: null }; // a tab that is off has nothing; its mail is in Primary
      const gmail = this.isGmail(r, c);
      let { state } = await this.sync(r, c, folder, gmail);
      const q = this.tabRows(tabs);
      const page: number[] = [];
      let cursor = before ?? Number.MAX_SAFE_INTEGER;
      let budget = this.cap();
      let next: number | null = null;
      for (;;) {
        const want = limit - page.length;
        const rows = this.sql.exec<{ uid: number }>(
          `SELECT c.uid FROM ${q.from} WHERE c.account_id = ? AND c.folder = ? AND c.uid_validity = ? AND c.uid < ? AND c.uid >= ? AND ${q.tab} = ? ORDER BY c.uid DESC LIMIT ?`,
          r.id, folder, state.validity, cursor, Math.max(1, state.low), ...q.params, category, want + 1).toArray();
        for (const row of rows.slice(0, want)) page.push(row.uid);
        // A full page with more of the tab cached after it; or full, with older mail not looked at yet.
        if (rows.length > want) { next = page[page.length - 1]; break; }
        if (page.length >= limit) { next = state.low > 1 ? page[page.length - 1] : null; break; }
        if (state.low <= 1) { next = null; break; }
        if (budget <= 0) { next = Math.min(cursor, state.low); break; }
        // Everything the cache reaches has been read: sort the mail below it.
        cursor = Math.min(cursor, state.low);
        const got = await this.extendDown(r, c, folder, state, budget, gmail);
        state = got.state;
        budget -= Math.max(1, got.sorted);
      }
      const { fetched, snippets } = await this.summaries(c, folder, page);
      // What the cache had but the server no longer has has left the folder (moved elsewhere, from another mail app).
      const back = new Set(fetched.map((m) => m.uid));
      const gone = page.filter((u) => !back.has(u));
      if (gone.length) this.forgetRows(r.id, folder, gone);
      return { messages: fetched.map((m) => ({ ...toSummary(m, folder, snippets.get(m.uid) ?? ''), category })), next };
    });
    void this.recheckSoon(r, folder);
    return result;
  }

  /**
   * Primary and each enabled tab: its unread count, how many of those arrived after `since` (per tab), and its latest
   * message. From the cache: new mail is sorted (`sync`), one `UID SEARCH UNSEEN` gives what is unread, and SQLite the rest.
   * Kept for COUNTS_TTL_MS, unless something done here changes them.
   */
  private async tabCounts(r: AccountRow, folder: string, since: Partial<Record<Category, number>>): Promise<TabCount[]> {
    const tabs = this.tabsOf(r);
    const ids: Category[] = ['primary', ...tabs];
    const key = JSON.stringify([tabs, since]);
    const test = timing.getStore()?.test;
    if (test?.recheck) await this.recheckSoon(r, folder, true);
    const kept = this.counts.get(r.id);
    if (kept && kept.key === key && Date.now() - kept.at < COUNTS_TTL_MS && !test?.slowMs && !test?.recheck) return kept.counts;
    const at = Date.now(), epoch = this.countsEpoch.get(r.id) ?? 0;
    const counts = await this.withFolder(r, folder, 'background', async (c) => {
      await this.testSlow();
      if (!c.mailbox) return ids.map((id) => ({ id, unread: 0, new: 0, latest: null }));
      const gmail = this.isGmail(r, c);
      const { state } = await this.sync(r, c, folder, gmail);
      const unseen = ((await c.search({ seen: false }, { uid: true })) || []).sort((a, b) => b - a);
      // Unread mail the cache does not have yet (older than it reaches) is sorted now, up to a point; the re-check does the rest.
      const missing = unseen.filter((u) => u < state.low);
      if (missing.length) await this.sortDown(r, c, folder, state.validity, missing, this.cap(), gmail);
      const q = this.tabRows(tabs);
      const out = new Map<Category, TabCount>(ids.map((id) => [id, { id, unread: 0, new: 0, latest: null }]));
      for (let i = 0; i < unseen.length; i += 5000) {
        const rows = this.sql.exec<{ tab: string; date: number }>(
          `SELECT ${q.tab} AS tab, c.date FROM ${q.from} WHERE c.account_id = ? AND c.folder = ? AND c.uid_validity = ? AND c.uid IN (SELECT value FROM json_each(?))`,
          ...q.params, r.id, folder, state.validity, JSON.stringify(unseen.slice(i, i + 5000))).toArray();
        for (const row of rows) {
          const t = out.get(row.tab as Category);
          if (!t) continue;
          t.unread++;
          if (row.date > (since[t.id] ?? 0)) t.new++;
        }
      }
      for (const id of ids) {
        const row = this.sql.exec<{ sender: string; from_name: string; subject: string }>(
          `SELECT c.sender, c.from_name, c.subject FROM ${q.from} WHERE c.account_id = ? AND c.folder = ? AND c.uid_validity = ? AND ${q.tab} = ? ORDER BY c.uid DESC LIMIT 1`,
          r.id, folder, state.validity, ...q.params, id).toArray()[0];
        if (row) out.get(id)!.latest = { from: row.sender || row.from_name ? { name: row.from_name, address: row.sender } : null, subject: row.subject };
      }
      return [...out.values()];
    });
    // Kept only if nothing here changed them meanwhile.
    if ((this.countsEpoch.get(r.id) ?? 0) === epoch) this.counts.set(r.id, { at, key, counts });
    void this.recheckSoon(r, folder);
    return counts;
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
    this.dropCounts(accountId);
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
    const opened = await this.withFolder(r, folder, 'interactive', async (c): Promise<Opened> => {
      const m = await c.fetchOne(String(uid), { ...SUMMARY_QUERY, headers: DETAIL_HEADERS }, { uid: true });
      if (!m) throw notFound('no such message');
      const summary = toSummary(m, folder);
      const plan = planBody(m.bodyStructure);
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
        return { detail: toDetail(summary, email), plan: null, parts };
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
      return { detail: toDetail(summary, email, attachments), plan, parts };
    });
    this.opened.set(key, opened);
    while (this.opened.size > 3) this.opened.delete(this.opened.keys().next().value!);
    return opened;
  }

  /** One attachment's bytes: kept from opening the message, else that part alone, in one FETCH. */
  private async attachment(r: AccountRow, folder: string, uid: number, index: number): Promise<{ content: Buffer; mimeType: string; filename: string }> {
    const opened = this.opened.get(`${r.id}/${folder}/${uid}`);
    const kept = opened?.parts.get(index);
    if (kept) return kept;
    return this.withFolder(r, folder, 'interactive', async (c) => {
      let plan = opened?.plan;
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

  private async send(r: AccountRow, body: ReturnType<typeof SendBody.parse>): Promise<string> {
    const account = this.toAccount(r);
    const recipients = [...body.to, ...(body.cc ?? []), ...(body.bcc ?? [])];
    if (!recipients.length) throw badRequest('to: name at least one recipient');
    if (sendSize(body) > MAX_SEND_BYTES) throw mailError(413, 'bad_request', 'the message is larger than 20 MB');
    const domain = account.email.split('@')[1] || 'freeflow.im';
    const message = {
      from: { name: account.displayName, address: account.email },
      to: body.to, cc: body.cc, bcc: body.bcc,
      subject: body.subject, html: body.html, text: body.text,
      inReplyTo: body.inReplyTo, references: body.references,
      messageId: `<${crypto.randomUUID()}@${domain}>`,
      date: new Date(),
      attachments: (body.attachments ?? []).map((a) => ({ filename: a.filename, contentType: a.contentType, content: Buffer.from(a.contentBase64, 'base64') })),
    };
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
        const composer = new MailComposer(message).compile();
        composer.keepBcc = true;
        const raw = await new Promise<Buffer>((resolve, reject) => composer.build((err, out) => (err ? reject(err) : resolve(out))));
        await c.append(sent, raw, ['\\Seen']);
      }).catch((err) => console.warn(`[mail] sent copy: ${(err as Error).message}`));
    }
    if (body.inReplyTo) {
      await this.withFolder(r, 'INBOX', 'interactive', async (c) => {
        const uids = (await c.search({ header: { 'message-id': body.inReplyTo! } }, { uid: true })) || [];
        if (uids.length) await c.messageFlagsAdd(uids.join(','), ['\\Answered'], { uid: true });
      }).catch((err) => console.warn(`[mail] answered flag: ${(err as Error).message}`));
    }
    this.dropCounts(r.id);
    return message.messageId;
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

    app.get('/v1/mail/accounts', (c) => c.json({ accounts: this.sql.exec<AccountRow & Record<string, SqlStorageValue>>('SELECT * FROM accounts ORDER BY created_at').toArray().map((r) => this.toAccount(r)) }));

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
      if (b.tabs !== undefined) {
        this.sql.exec('UPDATE accounts SET tabs = ? WHERE id = ?', JSON.stringify(normalizeTabs(b.tabs)), r.id);
        this.dropCounts(r.id);
      }
      return c.json({ account: this.toAccount(this.row(r.id)) });
    });

    app.delete('/v1/mail/accounts/:id', (c) => {
      const r = this.row(c.req.param('id'));
      this.forget(r.id);
      this.sql.exec('DELETE FROM accounts WHERE id = ?', r.id);
      this.sql.exec('DELETE FROM mail_categories WHERE account_id = ?', r.id);
      this.sql.exec('DELETE FROM mail_category_overrides WHERE account_id = ?', r.id);
      this.sql.exec('DELETE FROM mail_sync WHERE account_id = ?', r.id);
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
      return c.json(await this.list(c.get('account'), c.req.query('folder') || 'INBOX', limit, before, (c.req.query('q') ?? '').trim(), category as Category | null));
    });

    app.get('/v1/mail/accounts/:id/categories', async (c: MailContext) => {
      const folder = c.req.query('folder') || INBOX;
      if (folder.toUpperCase() !== INBOX) throw badRequest('folder: inbox tabs are only for INBOX');
      // since=promotions:1730000000000,social:… — when the user last opened each tab, for its "new" count.
      const since: Partial<Record<Category, number>> = {};
      for (const part of (c.req.query('since') ?? '').split(',')) {
        const [id, ms] = part.split(':');
        if ((CATEGORIES as readonly string[]).includes(id) && Number.isFinite(Number(ms))) since[id as Category] = Number(ms);
      }
      return c.json({ categories: await this.tabCounts(c.get('account'), folder, since) });
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
      await this.withFolder(r, b.folder, 'interactive', async (cl) => {
        const range = b.uids.join(',');
        const set = async (flag: string, on: boolean | undefined) => {
          if (on === undefined) return;
          await (on ? cl.messageFlagsAdd(range, [flag], { uid: true }) : cl.messageFlagsRemove(range, [flag], { uid: true }));
        };
        await set('\\Seen', b.seen);
        await set('\\Flagged', b.flagged);
      });
      if (b.seen !== undefined) this.dropCounts(r.id);
      // The kept copy of an open message says what its flags are now.
      for (const uid of b.uids) {
        const o = this.opened.get(`${r.id}/${b.folder}/${uid}`);
        if (o) o.detail = { ...o.detail, ...(b.seen !== undefined ? { seen: b.seen } : {}), ...(b.flagged !== undefined ? { flagged: b.flagged } : {}) };
      }
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
  }

  /** Messages that left a folder through us: their kept copies and their cached tabs go, and the counts change. */
  private left(id: string, folder: string, uids: number[]): void {
    for (const key of [...this.opened.keys()]) if (key.startsWith(`${id}/${folder}/`)) this.opened.delete(key);
    this.forgetRows(id, folder, uids);
    this.dropCounts(id);
  }
}
