// What the per-account objects (Mail, Calendar) share (platform.md §3.6): each is `idFromName(accountId)`, records whose it
// is on first use and refuses a request for anyone else's account; and their rows can be copied whole into another object
// of their kind, for the one-time move from the per-person objects (routes/admin.ts, POST /v1/admin/accounts/rekey).
import type { CallerContext } from './org/routes/compat';
import { insertRows, type ImportRow } from './importing';

/** The state keys naming the object's account, its holder and its organization. Never copied from one object to another. */
export const OWNER_KEYS = ['owner_account_id', 'owner_user_id', 'owner_organization_id'] as const;
/** What the per-person objects kept about their person (Calendar's `user_id`): stale in an account's object, so not copied. */
const DROPPED_KEYS = new Set<string>([...OWNER_KEYS, 'user_id']);

interface StateStore { state(key: string): string | null; setState(key: string, value: string): void }

/**
 * The guard against a mis-keyed call: the caller's account is the object's (recorded on its first request), or the request
 * is refused. Answers the message to refuse with, or null. A caller with no account never reaches an object.
 */
export function ownerMismatch(store: StateStore, caller: (Pick<CallerContext, 'account' | 'user'> & { organizationId?: string | null }) | null | undefined, what: string): string | null {
  const account = caller?.account;
  if (!account) return `${what} was called without an account in the caller context`;
  const stored = store.state('owner_account_id');
  // The organization, for the event log (platform.md §5.2); objects made before it learn it on their next request.
  const org = account.organizationId || caller?.organizationId;
  if ((!stored || stored === account.id) && org && !store.state('owner_organization_id')) store.setState('owner_organization_id', org);
  if (!stored) {
    store.setState('owner_account_id', account.id);
    store.setState('owner_user_id', account.principalId || caller?.user?.id || '');
    return null;
  }
  return stored === account.id ? null : `${what} object of account ${stored} was called for account ${account.id}`;
}

/** A refusal from `ownerMismatch`, as the objects answer errors. */
export const ownerRefusal = (message: string) => Response.json({ error: { code: 'wrong_account', message } }, { status: 500 });

/** Rows per page of an export: Mail's cached messages carry bodies, and an RPC answer has a size limit. */
export const EXPORT_PAGE = 200;

/** One page of each table's rows (or of the one named), in rowid order, as an object's export answers them. */
export function exportTables(sql: SqlStorage, tables: readonly string[], opts: { table?: string; offset?: number; limit?: number } = {}): { table: string; rows: ImportRow[] }[] {
  const names = opts.table ? tables.filter((t) => t === opts.table) : tables;
  if (opts.table && !names.length) throw new Error(`not a table here: ${opts.table}`);
  const limit = Math.max(1, Math.min(opts.limit ?? EXPORT_PAGE, 5000)), offset = Math.max(0, opts.offset ?? 0);
  return names.map((table) => ({ table, rows: sql.exec(`SELECT * FROM ${table} ORDER BY rowid LIMIT ? OFFSET ?`, limit, offset).toArray() as ImportRow[] }));
}

/** Rows into one of the object's tables, keeping any already there (`INSERT OR IGNORE`: the move can run again). */
export function importTable(sql: SqlStorage, tables: readonly string[], stateTable: string, table: string, rows: ImportRow[]): { added: number } {
  if (!tables.includes(table)) throw new Error(`not a table here: ${table}`);
  const kept = table === stateTable ? rows.filter((r) => !DROPPED_KEYS.has(String(r.key))) : rows;
  return { added: insertRows(sql, table, kept) };
}
