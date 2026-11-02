// Rows arriving from the one-time import (packages/server/scripts/export-to-edge.ts). The exporter has already turned
// Postgres's values into SQLite's: timestamps to milliseconds, booleans to 0 and 1, JSON to text. Bytes come as
// { $b64 } and are decoded here.
export type ImportRow = Record<string, unknown>;

export function fromImport(value: unknown): unknown {
  if (value && typeof value === 'object' && '$b64' in (value as object)) {
    const bytes = Buffer.from((value as { $b64: string }).$b64, 'base64');
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }
  return value;
}

/** Inserts rows as they are, keeping any already there (an import can be run again). Returns how many were new. */
export function insertRows(sql: SqlStorage, table: string, rows: ImportRow[]): number {
  if (!/^[a-z_]+$/.test(table)) throw new Error(`bad table ${table}`);
  let added = 0;
  for (const row of rows) {
    const columns = Object.keys(row);
    if (!columns.every((c) => /^[a-z_0-9]+$/.test(c))) throw new Error(`bad column in ${table}`);
    let cursor;
    try {
      cursor = sql.exec(`INSERT OR IGNORE INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`, ...columns.map((c) => fromImport(row[c])) as never[]);
    } catch (err) {
      throw new Error(`${table} ${String(row.id ?? JSON.stringify(row).slice(0, 120))}: ${(err as Error).message}`);
    }
    cursor.toArray();
    added += cursor.rowsWritten;
  }
  return added;
}

/** Row counts per table, to compare an import with its source. */
export function tableCounts(sql: SqlStorage): Record<string, number> {
  const names = sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND substr(name, 1, 1) != '_' AND name NOT LIKE 'sqlite%'").toArray().map((r) => r.name as string);
  return Object.fromEntries(names.map((n) => [n, sql.exec(`SELECT COUNT(*) AS n FROM ${n}`).one().n as number]).filter(([, n]) => n));
}
