// An Org object's storage for tests: the runtime's `ctx.storage.sql` over node:sqlite, with the object's migrations
// applied, so services run on the same SQL they run on in the Worker.
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';
import { openDb, type DB } from '../src/org/db/index';
import { ORG_MIGRATIONS } from '../src/org/db/migrations';
import { HUDDLE_ROSTER_DDL } from '../src/org/huddles';

const toBinding = (v: unknown): SQLInputValue => (v instanceof ArrayBuffer ? new Uint8Array(v) : (v as SQLInputValue));
const fromValue = (v: unknown) => (v instanceof Uint8Array ? v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) : v);

/** Runs at once, as the runtime's do, and reads as objects or as arrays by position (drizzle reads a join whose tables
 * share column names that way). */
function cursor(statement: StatementSync, bindings: SQLInputValue[]) {
  const names = statement.columns().map((c) => c.name);
  statement.setReturnArrays(true);
  const arrays = (statement.all(...bindings) as unknown as unknown[][]).map((r) => r.map(fromValue));
  const objects = arrays.map((r) => Object.fromEntries(names.map((n, i) => [n, r[i]])));
  let at = 0;
  return {
    toArray: () => objects,
    one: () => { if (objects.length !== 1) throw new Error(`expected one row, got ${objects.length}`); return objects[0]; },
    raw: () => ({ toArray: () => arrays }),
    next: () => (at < objects.length ? { done: false, value: objects[at++] } : { done: true, value: undefined }),
  };
}

export function orgStorage(): { db: DB; sqlite: DatabaseSync } {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  const exec = (query: string, ...bindings: unknown[]) => {
    const statement = sqlite.prepare(query);
    const values = bindings.map(toBinding);
    if (statement.columns().length === 0) { statement.run(...values); return cursor(sqlite.prepare('SELECT 1 WHERE 0'), []); }
    return cursor(statement, values);
  };
  const storage = {
    sql: { exec },
    transactionSync: <T>(fn: () => T): T => fn(),
    transaction: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
  };
  for (const m of ORG_MIGRATIONS) for (const statement of m.split('--> statement-breakpoint')) if (statement.trim()) sqlite.exec(statement);
  sqlite.exec(HUDDLE_ROSTER_DDL);
  return { db: openDb(storage as unknown as DurableObjectStorage), sqlite };
}
