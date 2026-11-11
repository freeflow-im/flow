// The Org object's outbox flush (object.ts): changes this organization made that the directory must learn, sent in order.

/** The one SQL call the flush needs: the Durable Object's storage, or node:sqlite in tests. */
export interface OutboxSql {
  exec(query: string, ...args: unknown[]): { toArray(): Record<string, unknown>[] };
}

/** What the directory answered for a batch: taken (the rows go) or refused (they stay for the next flush). */
export type OutboxAnswer = { ok: true } | { ok: false; message: string };

/**
 * Flushes `_outbox` one batch at a time. Two flushes in flight could both send row n; the first deletes it, the emptied
 * table gives n's number to the next change (`seq` is a rowid, not AUTOINCREMENT), and the second's delete then took that
 * change unsent: on 2026-11-11 two of 54 leaves never reached the directory. One flush at a time keeps a batch's rows in
 * the table while it waits, so a change made meanwhile gets a higher number; and only the rows sent are deleted.
 */
export class OutboxFlusher {
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly sql: OutboxSql, private readonly send: (rows: Record<string, unknown>[]) => Promise<OutboxAnswer>) {}

  flush(): Promise<void> {
    const run = this.chain.then(() => this.once());
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async once(): Promise<void> {
    const rows = this.sql.exec('SELECT * FROM _outbox ORDER BY seq').toArray();
    if (!rows.length) return;
    const answer = await this.send(rows);
    if (answer.ok) this.sql.exec('DELETE FROM _outbox WHERE seq IN (SELECT value FROM json_each(?))', JSON.stringify(rows.map((r) => r.seq)));
    else console.error(`directory refused org changes: ${answer.message}`);
  }
}
