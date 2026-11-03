// FreeFlow Mail: one object per person (`idFromName(userId)`), holding the mail accounts they connected and talking to
// those accounts' own servers over IMAP and SMTP. The contract is docs/specs/mail-api.md.
//
// The accounts are in the object's SQLite, each password sealed with FLOW_DATA_KEY (org/crypto, the same scheme as Chat's
// files) and never returned or logged. While the object is awake it keeps one IMAP connection per account and reuses it,
// closing it after a minute with nothing to do; a request finding it dropped opens another. Every operation on a folder
// holds that folder's lock (imapflow's getMailboxLock), so two requests never act on different folders at once.
import { DurableObject } from 'cloudflare:workers';
import { connect } from 'cloudflare:sockets';
import { Hono, type Context } from 'hono';
import { ImapFlow, createSocketsTransport, type FetchMessageObject, type FetchQueryObject, type ListResponse, type SearchObject } from 'imapflow';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer';
import PostalMime, { type Email } from 'postal-mime';
import { ApiError } from '../errors';
import { decryptBlob, encryptBlob } from '../org/crypto/index';
import { contentDisposition, specialUseOf, snippetOf, textPartOf, toDetail, toFolders, toSummary, type MessageSummary, type SpecialUse, type TextPart } from './convert';
import { CATEGORIES, CATEGORY_HEADERS, classifyHeaders, effective, gmailQuery, isGmailHost, normalizeTabs, parseHeaders, type Category, type TabCategory } from './categorize';
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
/** One INBOX message's tab as its headers decide it (categorize.ts), with what the tab bar shows of it. */
interface CategoryRow { uid: number; sender: string; from_name: string; subject: string; date: number; category: string; reason: string }
interface TabCount { id: Category; unread: number; new: number; latest: { from: { name: string; address: string } | null; subject: string } | null }

const IDLE_MS = 60_000;
const LOGIN_LIMIT = 10;
const LOGIN_WINDOW_MS = 15 * 60_000;
const MAX_MESSAGE_BYTES = 50 * 1024 * 1024;
const FOLDER_TTL_MS = 5 * 60_000;
const DDL = [
  `CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, email TEXT NOT NULL, display_name TEXT NOT NULL, imap TEXT NOT NULL, smtp TEXT NOT NULL,
    secret BLOB NOT NULL, key_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'ok', status_message TEXT, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS rate_limit_windows (key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL DEFAULT 1)`,
  // Inbox tabs: each INBOX message's tab by its headers (servers other than Gmail), kept per UIDVALIDITY so a list or
  // the tab counts never fetch a message's headers twice; and the tab the user chose for a sender ("Move to tab").
  `CREATE TABLE IF NOT EXISTS mail_categories (account_id TEXT NOT NULL, folder TEXT NOT NULL, uid_validity TEXT NOT NULL, uid INTEGER NOT NULL,
    sender TEXT NOT NULL, from_name TEXT NOT NULL, subject TEXT NOT NULL, date INTEGER NOT NULL, category TEXT NOT NULL, reason TEXT NOT NULL,
    PRIMARY KEY (account_id, folder, uid_validity, uid))`,
  `CREATE TABLE IF NOT EXISTS mail_category_overrides (account_id TEXT NOT NULL, sender TEXT NOT NULL, category TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (account_id, sender))`,
];
/** Columns added after the first release, each added once (ALTER fails when the column is already there). */
const ADDED_COLUMNS = [`ALTER TABLE accounts ADD COLUMN tabs TEXT NOT NULL DEFAULT '[]'`];
/** Headers fetched to sort INBOX into tabs, per request at most (the rest is classified as the list pages on). */
const CLASSIFY_CAP = 300;
const INBOX = 'INBOX';

type Failure = { code: 'auth_failed' | 'connect_failed'; message: string };
const SUMMARY_QUERY: FetchQueryObject = { uid: true, envelope: true, flags: true, bodyStructure: true, size: true, internalDate: true };

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

type MailContext = Context<{ Variables: { account: AccountRow } }>;

export class Mail extends DurableObject<MailEnv> {
  private readonly sql: SqlStorage;
  private readonly app = new Hono<{ Variables: { account: AccountRow } }>();
  /** The open connection per account, as the promise of it, so two requests at once share one login. */
  private readonly conns = new Map<string, Promise<ImapFlow>>();
  private readonly users = new Map<string, number>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly folderLists = new Map<string, { at: number; list: ListResponse[] }>();
  /** The last few messages read in full, so a message's inline images do not each download it again. */
  private readonly parsed = new Map<string, Email>();

  constructor(ctx: DurableObjectState, env: MailEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    for (const statement of DDL) this.sql.exec(statement);
    for (const statement of ADDED_COLUMNS) {
      try { this.sql.exec(statement); } catch { /* already added */ }
    }
    this.routes();
  }

  /** A request from routes/mail.ts, made by the person this object belongs to. */
  async handle(request: Request): Promise<Response> {
    return this.app.fetch(request);
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
    const conn = this.conns.get(id);
    this.conns.delete(id);
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
    this.folderLists.delete(id);
    for (const key of [...this.parsed.keys()]) if (key.startsWith(`${id}/`)) this.parsed.delete(key);
    void conn?.then((c) => c.logout()).catch(() => {});
  }

  // ---- the IMAP connection ----------------------------------------------------------------------------------------

  private open(r: AccountRow): Promise<ImapFlow> {
    const imap = JSON.parse(r.imap) as ServerSettings;
    const client = new ImapFlow(imapOptions(imap, imap.username || r.email, this.password(r)));
    client.on('error', (err: Error) => console.warn(`[mail] imap ${r.id}: ${err.message}`));
    client.on('close', () => { if (this.conns.get(r.id) === pending) this.conns.delete(r.id); });
    const pending = client.connect().then(() => {
      this.setStatus(r.id, 'ok', null);
      return client;
    }, (err) => {
      if (this.conns.get(r.id) === pending) this.conns.delete(r.id);
      const f = imapFailure(err);
      this.setStatus(r.id, f.code, f.message);
      throw failed(f);
    });
    this.conns.set(r.id, pending);
    return pending;
  }

  private async client(r: AccountRow): Promise<ImapFlow> {
    const have = this.conns.get(r.id);
    if (have) {
      const c = await have.catch(() => null);
      if (c?.usable) return c;
      if (this.conns.get(r.id) === have) this.conns.delete(r.id);
    }
    return this.conns.get(r.id) ?? this.open(r);
  }

  /** Runs `fn` on the account's connection, once more on a fresh one if the connection had dropped. */
  private async withImap<T>(r: AccountRow, fn: (c: ImapFlow) => Promise<T>): Promise<T> {
    clearTimeout(this.timers.get(r.id));
    this.users.set(r.id, (this.users.get(r.id) ?? 0) + 1);
    try {
      for (let attempt = 0; ; attempt++) {
        const c = await this.client(r);
        try {
          return await fn(c);
        } catch (err) {
          if (attempt === 0 && (dropped(err) || !c.usable)) { this.conns.delete(r.id); continue; }
          throw commandError(err);
        }
      }
    } finally {
      const left = (this.users.get(r.id) ?? 1) - 1;
      this.users.set(r.id, left);
      if (left === 0) this.timers.set(r.id, setTimeout(() => this.closeIdle(r.id), IDLE_MS));
    }
  }

  private closeIdle(id: string): void {
    if (this.users.get(id)) return;
    const conn = this.conns.get(id);
    this.conns.delete(id);
    this.timers.delete(id);
    void conn?.then((c) => c.logout()).catch(() => {});
  }

  private withFolder<T>(r: AccountRow, folder: string, fn: (c: ImapFlow) => Promise<T>): Promise<T> {
    return this.withImap(r, async (c) => {
      const lock = await c.getMailboxLock(folder);
      try { return await fn(c); } finally { lock.release(); }
    });
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

  private async list(r: AccountRow, folder: string, limit: number, before: number | null, q: string, category: Category | null = null): Promise<{ messages: MessageSummary[]; next: number | null }> {
    const tabs = folder.toUpperCase() === INBOX ? this.tabsOf(r) : [];
    // A search covers the whole folder, as Gmail's does; and with tabs off there is only the one list.
    if (category && !q && tabs.length) return this.tabList(r, folder, tabs, category, limit, before);
    return this.withFolder(r, folder, async (c) => {
      const box = c.mailbox;
      const exists = box ? box.exists : 0;
      if (!exists || (before !== null && before <= 1)) return { messages: [], next: null };
      let fetched: FetchMessageObject[] = [];
      let more: boolean;
      // With tabs on, each page's messages are sorted into them from the same FETCH (the few headers it needs).
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
      fetched = fetched.sort((a, b) => b.uid - a.uid);
      const snippets = await this.snippets(c, fetched).catch((err) => { console.warn(`[mail] snippets: ${(err as Error).message}`); return new Map<number, string>(); });
      const categories = tabs.length ? await this.categoriesOf(r, c, folder, tabs, fetched, gmail) : null;
      const messages = fetched.map((m) => ({ ...toSummary(m, folder, snippets.get(m.uid) ?? ''), ...(categories ? { category: categories.get(m.uid) ?? 'primary' } : {}) }));
      return { messages, next: more && messages.length ? messages[messages.length - 1].uid : null };
    });
  }

  // ---- inbox tabs ---------------------------------------------------------------------------------------------------

  private isGmail(r: AccountRow, c: ImapFlow): boolean {
    return isGmailHost((JSON.parse(r.imap) as ServerSettings).host) || c.capabilities.has('X-GM-EXT-1');
  }

  private overrides(accountId: string): Map<string, Category> {
    return new Map(this.sql.exec<{ sender: string; category: string }>('SELECT sender, category FROM mail_category_overrides WHERE account_id = ?', accountId).toArray().map((o) => [o.sender, o.category as Category]));
  }

  /** The tab a cached message shows in: the sender's chosen tab, else its headers', and Primary for a tab that is off. */
  private tabOf(row: CategoryRow, overrides: Map<string, Category>, tabs: TabCategory[]): Category {
    return effective(overrides.get(row.sender) ?? (row.category as Category), tabs);
  }

  private validity(c: ImapFlow): string {
    return String(c.mailbox ? c.mailbox.uidValidity : 0);
  }

  /** The cached classifications for a UID range of the open folder. */
  private cached(r: AccountRow, folder: string, validity: string, from: number, to: number): Map<number, CategoryRow> {
    const rows = this.sql.exec<CategoryRow & Record<string, SqlStorageValue>>(
      'SELECT uid, sender, from_name, subject, date, category, reason FROM mail_categories WHERE account_id = ? AND folder = ? AND uid_validity = ? AND uid BETWEEN ? AND ?',
      r.id, folder, validity, from, to).toArray();
    return new Map(rows.map((row) => [row.uid, { ...row }]));
  }

  /** Classifies a fetched message by its headers (it must have been fetched with envelope and CATEGORY_HEADERS) and caches it. */
  private remember(r: AccountRow, folder: string, validity: string, m: FetchMessageObject): CategoryRow {
    const { category, reason } = classifyHeaders(parseHeaders(m.headers));
    const from = m.envelope?.from?.[0] ?? m.envelope?.sender?.[0];
    const row: CategoryRow = {
      uid: m.uid, sender: (from?.address ?? '').toLowerCase(), from_name: from?.name ?? '', subject: m.envelope?.subject ?? '',
      date: new Date(m.internalDate ?? m.envelope?.date ?? 0).getTime() || 0, category, reason,
    };
    this.sql.exec('INSERT OR REPLACE INTO mail_categories (account_id, folder, uid_validity, uid, sender, from_name, subject, date, category, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      r.id, folder, validity, row.uid, row.sender, row.from_name, row.subject, row.date, row.category, row.reason);
    return row;
  }

  /** Fetches the headers of these UIDs and classifies them into `into`. */
  private async classify(r: AccountRow, c: ImapFlow, folder: string, validity: string, uids: number[], into: Map<number, CategoryRow>): Promise<void> {
    if (!uids.length) return;
    for await (const m of c.fetch(uids.join(','), { uid: true, envelope: true, internalDate: true, headers: CATEGORY_HEADERS }, { uid: true })) into.set(m.uid, this.remember(r, folder, validity, m));
  }

  /** Gmail's own categories for a set of UIDs: one X-GM-RAW search per enabled tab, over their UID range. */
  private async gmailNatural(c: ImapFlow, tabs: TabCategory[], uids: number[]): Promise<Map<number, Category>> {
    const out = new Map<number, Category>();
    if (!uids.length) return out;
    const range = `${Math.min(...uids)}:${Math.max(...uids)}`;
    for (const tab of tabs) {
      const found = await c.search({ uid: range, gmraw: `category:${tab}` }, { uid: true });
      for (const uid of found || []) if (!out.has(uid)) out.set(uid, tab);
    }
    return out;
  }

  /** The tab of each message of a page listed without `category`. */
  private async categoriesOf(r: AccountRow, c: ImapFlow, folder: string, tabs: TabCategory[], fetched: FetchMessageObject[], gmail: boolean): Promise<Map<number, Category>> {
    const overrides = this.overrides(r.id);
    const out = new Map<number, Category>();
    if (!fetched.length) return out;
    if (gmail) {
      const natural = await this.gmailNatural(c, tabs, fetched.map((m) => m.uid));
      for (const m of fetched) out.set(m.uid, effective(overrides.get((m.envelope?.from?.[0]?.address ?? '').toLowerCase()) ?? natural.get(m.uid) ?? 'primary', tabs));
      return out;
    }
    const validity = this.validity(c);
    const uids = fetched.map((m) => m.uid);
    const cache = this.cached(r, folder, validity, Math.min(...uids), Math.max(...uids));
    for (const m of fetched) out.set(m.uid, this.tabOf(cache.get(m.uid) ?? this.remember(r, folder, validity, m), overrides, tabs));
    return out;
  }

  /**
   * One page of a tab, newest first. Gmail: an X-GM-RAW search. Elsewhere: INBOX is walked newest first, classifying
   * what is not cached yet, until the page is full, the folder ends, or CLASSIFY_CAP headers have been fetched; `next`
   * then says where to carry on, so a page can come back short (even empty) with more to come.
   */
  private async tabList(r: AccountRow, folder: string, tabs: TabCategory[], category: Category, limit: number, before: number | null): Promise<{ messages: MessageSummary[]; next: number | null }> {
    return this.withFolder(r, folder, async (c) => {
      if (!c.mailbox || !c.mailbox.exists || (before !== null && before <= 1)) return { messages: [], next: null };
      const range: SearchObject = before !== null ? { uid: `1:${before - 1}` } : {};
      const overrides = this.overrides(r.id);
      let page: number[];
      let next: number | null;
      if (category !== 'primary' && !tabs.includes(category as TabCategory)) {
        page = []; next = null; // a tab that is off has nothing; its mail is in Primary
      } else if (this.isGmail(r, c)) {
        const found = ((await c.search({ ...range, gmraw: gmailQuery(category, tabs, overrides) }, { uid: true })) || []).sort((a, b) => b - a);
        page = found.slice(0, limit);
        next = found.length > limit ? page[page.length - 1] : null;
      } else {
        const all = ((await c.search(range.uid ? range : { all: true }, { uid: true })) || []).sort((a, b) => b - a);
        const validity = this.validity(c);
        const cache = all.length ? this.cached(r, folder, validity, all[all.length - 1], all[0]) : new Map<number, CategoryRow>();
        const tried = new Set<number>();
        let fetchedHeaders = 0;
        page = [];
        let i = 0;
        for (; i < all.length && page.length < limit; i++) {
          const uid = all[i];
          if (!cache.has(uid) && !tried.has(uid)) {
            if (fetchedHeaders >= CLASSIFY_CAP) break;
            const batch: number[] = [];
            for (let j = i; j < all.length && batch.length < Math.min(100, CLASSIFY_CAP - fetchedHeaders); j++) if (!cache.has(all[j])) batch.push(all[j]);
            await this.classify(r, c, folder, validity, batch, cache);
            for (const u of batch) tried.add(u);
            fetchedHeaders += batch.length;
          }
          const row = cache.get(uid);
          if (row && this.tabOf(row, overrides, tabs) === category) page.push(uid);
        }
        // `before` for the rest: everything older than the last message looked at.
        next = i < all.length ? all[i] + 1 : null;
      }
      const fetched: FetchMessageObject[] = [];
      if (page.length) for await (const m of c.fetch(page.join(','), SUMMARY_QUERY, { uid: true })) fetched.push(m);
      fetched.sort((a, b) => b.uid - a.uid);
      const snippets = await this.snippets(c, fetched).catch((err) => { console.warn(`[mail] snippets: ${(err as Error).message}`); return new Map<number, string>(); });
      return { messages: fetched.map((m) => ({ ...toSummary(m, folder, snippets.get(m.uid) ?? ''), category })), next };
    });
  }

  /** Primary and each enabled tab: its unread count, how many of those arrived after `since` (per tab), and its latest message. */
  private async tabCounts(r: AccountRow, folder: string, since: Partial<Record<Category, number>>): Promise<TabCount[]> {
    const tabs = this.tabsOf(r);
    const ids: Category[] = ['primary', ...tabs];
    return this.withFolder(r, folder, async (c) => {
      const latestOf = async (uid: number | undefined): Promise<TabCount['latest']> => {
        if (!uid) return null;
        const m = await c.fetchOne(String(uid), { uid: true, envelope: true }, { uid: true });
        const from = m ? m.envelope?.from?.[0] : undefined;
        return m ? { from: from ? { name: from.name ?? '', address: from.address ?? '' } : null, subject: m.envelope?.subject ?? '' } : null;
      };
      if (!c.mailbox || !c.mailbox.exists) return ids.map((id) => ({ id, unread: 0, new: 0, latest: null }));
      const overrides = this.overrides(r.id);
      if (tabs.length && this.isGmail(r, c)) {
        const out: TabCount[] = [];
        for (const id of ids) {
          const q = gmailQuery(id, tabs, overrides);
          const unread = (await c.search({ seen: false, gmraw: q }, { uid: true })) || [];
          const after = since[id];
          const fresh = after ? (await c.search({ seen: false, gmraw: `(${q}) after:${Math.floor(after / 1000)}` }, { uid: true })) || [] : unread;
          const all = (await c.search({ gmraw: q }, { uid: true })) || [];
          out.push({ id, unread: unread.length, new: fresh.length, latest: await latestOf(all.length ? Math.max(...all) : undefined) });
        }
        return out;
      }
      const all = ((await c.search({ all: true }, { uid: true })) || []).sort((a, b) => b - a);
      const unseen = new Set((await c.search({ seen: false }, { uid: true })) || []);
      const validity = this.validity(c);
      const cache = all.length ? this.cached(r, folder, validity, all[all.length - 1], all[0]) : new Map<number, CategoryRow>();
      // What is not classified yet: the unread first (they make the counts), then the newest (the latest of each tab).
      const missing = [...all.filter((u) => unseen.has(u) && !cache.has(u)), ...all.slice(0, 50).filter((u) => !unseen.has(u) && !cache.has(u))].slice(0, CLASSIFY_CAP);
      for (let i = 0; i < missing.length; i += 100) await this.classify(r, c, folder, validity, missing.slice(i, i + 100), cache);
      // Messages that have left the folder since they were classified, and other UIDVALIDITYs, are forgotten.
      const present = new Set(all);
      const gone = [...cache.keys()].filter((u) => !present.has(u));
      for (let i = 0; i < gone.length; i += 90) {
        const chunk = gone.slice(i, i + 90);
        this.sql.exec(`DELETE FROM mail_categories WHERE account_id = ? AND folder = ? AND uid_validity = ? AND uid IN (${chunk.map(() => '?').join(',')})`, r.id, folder, validity, ...chunk);
      }
      this.sql.exec('DELETE FROM mail_categories WHERE account_id = ? AND folder = ? AND uid_validity != ?', r.id, folder, validity);
      const out = new Map<Category, TabCount>(ids.map((id) => [id, { id, unread: 0, new: 0, latest: null }]));
      for (const uid of all) {
        const row = cache.get(uid);
        if (!row) continue;
        const t = out.get(this.tabOf(row, overrides, tabs))!;
        if (!t.latest) t.latest = { from: row.sender || row.from_name ? { name: row.from_name, address: row.sender } : null, subject: row.subject };
        if (unseen.has(uid)) {
          t.unread++;
          if (row.date > (since[t.id] ?? 0)) t.new++;
        }
      }
      return [...out.values()];
    });
  }

  /** "Move to tab": the senders of these messages go to `category` from now on. Returns what each had before, for undo. */
  private async moveToTab(r: AccountRow, folder: string, uids: number[], category: Category): Promise<{ senders: string[]; previous: { address: string; category: Category | null }[] }> {
    const senders = await this.withFolder(r, folder, async (c) => {
      const out = new Set<string>();
      for await (const m of c.fetch(uids.join(','), { uid: true, envelope: true }, { uid: true })) {
        const address = (m.envelope?.from?.[0]?.address ?? m.envelope?.sender?.[0]?.address ?? '').toLowerCase();
        if (address) out.add(address);
      }
      return [...out];
    });
    const before = this.overrides(r.id);
    const previous = senders.map((address) => ({ address, category: before.get(address) ?? null }));
    for (const address of senders) this.setOverride(r.id, address, category);
    return { senders, previous };
  }

  private setOverride(accountId: string, sender: string, category: Category | null): void {
    if (category === null) this.sql.exec('DELETE FROM mail_category_overrides WHERE account_id = ? AND sender = ?', accountId, sender);
    else this.sql.exec('INSERT OR REPLACE INTO mail_category_overrides (account_id, sender, category, created_at) VALUES (?, ?, ?, ?)', accountId, sender, category, Date.now());
  }

  private async read(r: AccountRow, folder: string, uid: number): Promise<{ summary: MessageSummary; email: Email }> {
    return this.withFolder(r, folder, async (c) => {
      const m = await c.fetchOne(String(uid), SUMMARY_QUERY, { uid: true });
      if (!m) throw notFound('no such message');
      if ((m.size ?? 0) > MAX_MESSAGE_BYTES) throw mailError(413, 'bad_request', 'the message is too large to open here');
      const key = `${r.id}/${folder}/${uid}`;
      let email = this.parsed.get(key);
      if (!email) {
        const download = await c.download(String(uid), undefined, { uid: true });
        if (!download?.content) throw notFound('no such message');
        email = await PostalMime.parse(await streamBytes(download.content, MAX_MESSAGE_BYTES), { attachmentEncoding: 'arraybuffer' });
        this.parsed.set(key, email);
        while (this.parsed.size > 3) this.parsed.delete(this.parsed.keys().next().value!);
      }
      return { summary: toSummary(m, folder), email };
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
      await this.withImap(r, async (c) => {
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
      await this.withFolder(r, 'INBOX', async (c) => {
        const uids = (await c.search({ header: { 'message-id': body.inReplyTo! } }, { uid: true })) || [];
        if (uids.length) await c.messageFlagsAdd(uids.join(','), ['\\Answered'], { uid: true });
      }).catch((err) => console.warn(`[mail] answered flag: ${(err as Error).message}`));
    }
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
      if (b.tabs !== undefined) this.sql.exec('UPDATE accounts SET tabs = ? WHERE id = ?', JSON.stringify(normalizeTabs(b.tabs)), r.id);
      return c.json({ account: this.toAccount(this.row(r.id)) });
    });

    app.delete('/v1/mail/accounts/:id', (c) => {
      const r = this.row(c.req.param('id'));
      this.forget(r.id);
      this.sql.exec('DELETE FROM accounts WHERE id = ?', r.id);
      this.sql.exec('DELETE FROM mail_categories WHERE account_id = ?', r.id);
      this.sql.exec('DELETE FROM mail_category_overrides WHERE account_id = ?', r.id);
      return c.json({ ok: true });
    });

    app.get('/v1/mail/accounts/:id/folders', async (c: MailContext) => {
      const r = c.get('account');
      const list = await this.withImap(r, async (cl) => {
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
      const { summary, email } = await this.read(c.get('account'), folderOf(c), uidOf(c));
      return c.json({ message: toDetail(summary, email) });
    });

    app.get('/v1/mail/accounts/:id/messages/:uid/attachments/:index', async (c: MailContext) => {
      const { email } = await this.read(c.get('account'), folderOf(c), uidOf(c));
      const index = Number(c.req.param('index'));
      const a = Number.isInteger(index) ? email.attachments[index] : undefined;
      if (!a) throw notFound('no such attachment');
      const type = a.mimeType || 'application/octet-stream';
      // Served from the app's own origin: only a picture may be shown inline, and nothing it holds may run.
      const inline = c.req.query('inline') === '1' && /^image\/(png|jpe?g|gif|webp|bmp|avif)$/i.test(type);
      const content: BodyInit = typeof a.content === 'string' ? new TextEncoder().encode(a.content) : (a.content as ArrayBuffer);
      return new Response(content, {
        headers: {
          'content-type': inline ? type : type.replace(/[^\w.+/-]/g, ''),
          'content-disposition': contentDisposition(inline ? 'inline' : 'attachment', a.filename ?? `attachment-${index + 1}`),
          'x-content-type-options': 'nosniff',
          'content-security-policy': "sandbox; default-src 'none'",
          'cache-control': 'private, max-age=3600',
        },
      });
    });

    app.patch('/v1/mail/accounts/:id/messages', async (c: MailContext) => {
      const b = parse(FlagsBody, await json(c));
      await this.withFolder(c.get('account'), b.folder, async (cl) => {
        const range = b.uids.join(',');
        const set = async (flag: string, on: boolean | undefined) => {
          if (on === undefined) return;
          await (on ? cl.messageFlagsAdd(range, [flag], { uid: true }) : cl.messageFlagsRemove(range, [flag], { uid: true }));
        };
        await set('\\Seen', b.seen);
        await set('\\Flagged', b.flagged);
      });
      return c.json({ ok: true });
    });

    app.post('/v1/mail/accounts/:id/messages/move', async (c: MailContext) => {
      const b = parse(MoveBody, await json(c));
      const r = c.get('account');
      if (b.to === b.folder) return c.json({ ok: true });
      await this.withFolder(r, b.folder, async (cl) => {
        if (!(await cl.messageMove(b.uids.join(','), b.to, { uid: true }))) throw badRequest('the mail server did not move the messages');
      });
      this.dropParsed(r.id, b.folder);
      return c.json({ ok: true });
    });

    app.post('/v1/mail/accounts/:id/messages/delete', async (c: MailContext) => {
      const b = parse(DeleteBody, await json(c));
      const r = c.get('account');
      await this.withImap(r, async (cl) => {
        const trash = await this.special(r, cl, 'trash');
        const lock = await cl.getMailboxLock(b.folder);
        try {
          if (!trash || trash === b.folder) await cl.messageDelete(b.uids.join(','), { uid: true });
          else if (!(await cl.messageMove(b.uids.join(','), trash, { uid: true }))) throw badRequest('the mail server did not move the messages to Trash');
        } finally { lock.release(); }
      });
      this.dropParsed(r.id, b.folder);
      return c.json({ ok: true });
    });

    app.post('/v1/mail/accounts/:id/send', async (c: MailContext) => {
      if (Number(c.req.header('content-length') ?? 0) > MAX_SEND_BYTES * 1.4 + 1_000_000) throw mailError(413, 'bad_request', 'the message is larger than 20 MB');
      const b = parse(SendBody, await json(c));
      return c.json({ ok: true, messageId: await this.send(c.get('account'), b) });
    });
  }

  private dropParsed(id: string, folder: string): void {
    for (const key of [...this.parsed.keys()]) if (key.startsWith(`${id}/${folder}/`)) this.parsed.delete(key);
  }
}
