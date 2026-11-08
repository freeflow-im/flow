// The per-account objects (platform.md §3.6): the guard against a mis-keyed call, and the one-time move's export and import
// (routes/admin.ts), on the Mail and Calendar objects themselves over node:sqlite.
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { Calendar } from './calendar/object';
import { CALENDAR_TABLES } from './calendar/store';
import { MAIL_TABLES, Mail } from './imap/object';
import type { CallerContext } from './org/routes/compat';
import { ownerMismatch } from './perAccount';

const toBinding = (v: unknown): SQLInputValue => (v instanceof ArrayBuffer ? new Uint8Array(v) : (v as SQLInputValue));
const fromValue = (v: unknown) => (v instanceof Uint8Array ? v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) : v);

/** `ctx.storage.sql` as the runtime's: rows as objects, bytes as ArrayBuffers, and `rowsWritten`. */
function storage() {
  const db = new DatabaseSync(':memory:');
  const exec = (query: string, ...bindings: unknown[]) => {
    const statement = db.prepare(query);
    const values = bindings.map(toBinding);
    let rows: Record<string, unknown>[] = [], rowsWritten = 0;
    if (statement.columns().length) rows = (statement.all(...values) as Record<string, unknown>[]).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, fromValue(v)])));
    else rowsWritten = Number(statement.run(...values).changes);
    return { toArray: () => rows, one: () => rows[0], rowsWritten };
  };
  return { db, ctx: { storage: { sql: { exec } }, id: {} } };
}

function count(db: DatabaseSync, table: string): number {
  return Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
}

/** Every page of every table, as the route reads them, into the other object. */
async function move(from: { exportRows: Mail['exportRows'] }, to: { importRows: Mail['importRows'] }, tables: readonly string[], page = 2): Promise<number> {
  let added = 0;
  for (const table of tables) {
    for (let offset = 0; ; ) {
      const rows = from.exportRows({ table, offset, limit: page })[0]!.rows;
      if (rows.length) added += to.importRows(table, rows).added;
      offset += rows.length;
      if (rows.length < page) break;
    }
  }
  return added;
}

const caller = (accountId: string, userId = 'u1') => ({ user: null, account: { id: accountId, principalId: userId } }) as unknown as CallerContext;

describe('the owner guard', () => {
  it('records the account on first use and refuses another', () => {
    const kv = new Map<string, string>();
    const store = { state: (k: string) => kv.get(k) ?? null, setState: (k: string, v: string) => void kv.set(k, v) };
    expect(ownerMismatch(store, caller('a1'), 'the Mail')).toBeNull();
    expect(Object.fromEntries(kv)).toEqual({ owner_account_id: 'a1', owner_user_id: 'u1' });
    expect(ownerMismatch(store, caller('a1'), 'the Mail')).toBeNull();
    expect(ownerMismatch(store, caller('a2'), 'the Mail')).toMatch(/account a1 was called for account a2/);
    expect(ownerMismatch(store, { user: null, account: null }, 'the Mail')).toMatch(/without an account/);
  });

  it('answers a mis-keyed request with a 500 before it reaches the routes', async () => {
    const { ctx, db } = storage();
    const mail = new Mail(ctx as never, {} as never);
    db.prepare(`INSERT INTO mail_state (key, value) VALUES ('owner_account_id', 'a1')`).run();
    const wrong = await mail.handle(new Request('https://x/v1/mail/accounts'), caller('a2'));
    expect(wrong.status).toBe(500);
    expect(((await wrong.json()) as { error: { code: string } }).error.code).toBe('wrong_account');
  });
});

describe('the move to the per-account objects', () => {
  it('copies every Mail table, keeps the bytes, leaves the owner behind, and adds nothing the second time', async () => {
    const a = storage(), b = storage();
    const from = new Mail(a.ctx as never, {} as never), to = new Mail(b.ctx as never, {} as never);
    const secret = new Uint8Array([1, 2, 3, 250]);
    a.db.prepare(`INSERT INTO accounts (id, email, display_name, imap, smtp, secret, key_id, created_at) VALUES (?, ?, 'Ann', '{}', '{}', ?, 'k1', ?)`).run('m1', 'ann@example.com', secret, 1);
    a.db.prepare(`INSERT INTO accounts (id, email, display_name, imap, smtp, secret, key_id, created_at) VALUES (?, ?, 'Ann', '{}', '{}', ?, 'k1', ?)`).run('m2', 'ann@work.com', secret, 2);
    for (let uid = 1; uid <= 5; uid++) a.db.prepare(`INSERT INTO mail_messages (account_id, folder, uid_validity, uid, summary) VALUES ('m1', 'INBOX', '7', ?, '{}')`).run(uid);
    a.db.prepare(`INSERT INTO mail_contacts (account_id, address, name) VALUES ('m1', 'bo@example.com', 'Bo')`).run();
    a.db.prepare(`INSERT INTO mail_state (key, value) VALUES ('owner_account_id', 'old'), ('owner_user_id', 'u1'), ('alarm_step', '3')`).run();
    b.db.prepare(`INSERT INTO mail_state (key, value) VALUES ('owner_account_id', 'acct-1')`).run();

    expect(await move(from, to, MAIL_TABLES)).toBe(2 + 5 + 1 + 1);
    expect(count(b.db, 'accounts')).toBe(2);
    expect(count(b.db, 'mail_messages')).toBe(5);
    expect(count(b.db, 'mail_contacts')).toBe(1);
    expect(new Uint8Array(b.db.prepare(`SELECT secret FROM accounts WHERE id = 'm1'`).get()!.secret as Uint8Array)).toEqual(secret);
    expect(Object.fromEntries((b.db.prepare('SELECT key, value FROM mail_state').all() as { key: string; value: string }[]).map((r) => [r.key, r.value]))).toMatchObject({ owner_account_id: 'acct-1', alarm_step: '3' });
    expect(b.db.prepare(`SELECT value FROM mail_state WHERE key = 'owner_user_id'`).get()).toBeUndefined();
    expect(await move(from, to, MAIL_TABLES)).toBe(0);
    expect(count(a.db, 'mail_messages')).toBe(5);
    expect(() => to.importRows('sqlite_master', [])).toThrow(/not a table/);
  });

  it('copies every Calendar table, without the per-person object\'s user id', async () => {
    const a = storage(), b = storage();
    const from = new Calendar(a.ctx as never, {} as never), to = new Calendar(b.ctx as never, {} as never);
    a.db.prepare(`INSERT INTO accounts (id, email, display_name, server, secret, key_id, created_at) VALUES ('c1', 'ann@example.com', 'Ann', '{}', ?, 'k1', 1)`).run(new Uint8Array([9]));
    a.db.prepare(`INSERT INTO calendars (id, account_id, href, name, created_at) VALUES ('cal1', 'c1', 'https://dav/x/', 'Work', 1)`).run();
    for (const id of ['e1', 'e2', 'e3']) {
      a.db.prepare(`INSERT INTO events (id, calendar_id, uid, href, etag, kind, start_utc, end_utc, recur_until, status, search, data) VALUES (?, 'cal1', ?, ?, 'e', 0, 0, 1, 1, 'confirmed', '', '{}')`).run(id, id, `https://dav/x/${id}.ics`);
      a.db.prepare(`INSERT INTO objects (calendar_id, href, uid, etag, raw) VALUES ('cal1', ?, ?, 'e', 'BEGIN:VCALENDAR')`).run(`https://dav/x/${id}.ics`, id);
    }
    a.db.prepare(`INSERT INTO sync_runs (calendar_id, at, ms, mode) VALUES ('cal1', 1, 2, 'full')`).run();
    a.db.prepare(`INSERT INTO calendar_state (key, value) VALUES ('user_id', 'u1'), ('last_active_at', '5')`).run();

    expect(await move(from, to, CALENDAR_TABLES)).toBe(1 + 1 + 3 + 3 + 1 + 1);
    for (const t of ['accounts', 'calendars', 'events', 'objects', 'sync_runs']) expect(count(b.db, t)).toBe(count(a.db, t));
    expect(b.db.prepare(`SELECT value FROM calendar_state WHERE key = 'user_id'`).get()).toBeUndefined();
    expect(await move(from, to, CALENDAR_TABLES)).toBe(0);
  });
});
