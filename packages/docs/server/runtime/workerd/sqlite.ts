// The part of `node:sqlite` the Docs stores use, over the object's own SQLite, which is synchronous too. Every database file
// the stores open (app.db, plugin.db, settings.db) is this one database: their tables do not overlap.
import { docsContext } from './context.ts';

const NOT_HERE = /^\s*PRAGMA\s+(journal_mode|foreign_keys|synchronous|busy_timeout)\b[^;]*;?/gim;

function fromSql(row: Record<string, unknown>): Record<string, unknown> {
  for (const key of Object.keys(row)) {
    const v = row[key];
    if (v instanceof ArrayBuffer) row[key] = Buffer.from(v);
  }
  return row;
}
const toSql = (v: unknown) => (v === undefined ? null : v instanceof Uint8Array ? v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) : typeof v === 'boolean' ? Number(v) : v);

export class StatementSync {
  constructor(private readonly query: string) {}
  private cursor(args: unknown[]) {
    // Named parameters arrive as one object; SQLite here takes them by position in the order they appear.
    const first = args[0];
    if (args.length === 1 && first && typeof first === 'object' && !(first instanceof Uint8Array)) {
      const names = [...this.query.matchAll(/[:@$]([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]!);
      const positional = this.query.replace(/[:@$][A-Za-z_][A-Za-z0-9_]*/g, '?');
      return docsContext().sql.exec(positional, ...names.map((n) => toSql((first as Record<string, unknown>)[n])) as never[]);
    }
    return docsContext().sql.exec(this.query, ...args.map(toSql) as never[]);
  }
  all(...args: unknown[]): unknown[] { return this.cursor(args).toArray().map(fromSql); }
  get(...args: unknown[]): unknown { const rows = this.cursor(args).toArray(); return rows.length ? fromSql(rows[0]!) : undefined; }
  run(...args: unknown[]): { changes: number; lastInsertRowid: number } {
    const c = this.cursor(args);
    c.toArray();
    return { changes: c.rowsWritten, lastInsertRowid: 0 };
  }
}

export class DatabaseSync {
  constructor(_file?: string) {}
  exec(query: string): void {
    const clean = query.replace(NOT_HERE, '');
    if (clean.trim()) docsContext().sql.exec(clean);
  }
  prepare(query: string): StatementSync { return new StatementSync(query); }
  close(): void { /* the object keeps it */ }
}
