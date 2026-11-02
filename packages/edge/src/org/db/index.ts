// The organization's database. The services import `db` as they did on Node; here it resolves to the database of the object
// handling this request, because several organizations' objects can share one isolate.
import { AsyncLocalStorage } from 'node:async_hooks';
import { drizzle, type DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import * as schema from './schema';

export type DB = DrizzleSqliteDODatabase<typeof schema>;
export type Tx = DB;

const current = new AsyncLocalStorage<DB>();

export function openDb(storage: DurableObjectStorage): DB {
  const db = drizzle(storage, { schema });
  // Drizzle's transaction here takes a synchronous callback and the services' are async. The object's own async
  // transaction gives them the same all-or-nothing.
  (db as unknown as { transaction: unknown }).transaction = <T>(fn: (tx: DB) => Promise<T>) => storage.transaction(() => fn(db));
  return db;
}

export function withDb<T>(db: DB, fn: () => T): T {
  return current.run(db, fn);
}

export const db = new Proxy({} as DB, {
  get(_t, prop) {
    const active = current.getStore();
    if (!active) throw new Error('no organization database: call inside withDb');
    const value = (active as never)[prop];
    return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(active) : value;
  },
});

export { schema };
