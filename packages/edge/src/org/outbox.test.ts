import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { OutboxFlusher, type OutboxSql } from './outbox';

function table(): { sql: OutboxSql; add: (id: string) => void; left: () => string[] } {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE _outbox (seq INTEGER PRIMARY KEY, kind TEXT NOT NULL, id TEXT NOT NULL, user_id TEXT, role TEXT, payload TEXT)');
  const sql: OutboxSql = { exec: (q, ...args) => { const st = db.prepare(q); const rows = /^\s*(SELECT|.*RETURNING)/i.test(q) ? st.all(...(args as never[])) : (st.run(...(args as never[])), []); return { toArray: () => rows as Record<string, unknown>[] }; } };
  return { sql, add: (id) => db.prepare("INSERT INTO _outbox (kind, id) VALUES ('leave', ?)").run(id), left: () => (db.prepare('SELECT id FROM _outbox ORDER BY seq').all() as { id: string }[]).map((r) => r.id) };
}

describe('OutboxFlusher', () => {
  it('loses no change when flushes overlap and the emptied table reuses a number (2026-11-11)', async () => {
    const t = table();
    const sent: string[] = [];
    const gates: (() => void)[] = [];
    const flusher = new OutboxFlusher(t.sql, async (rows) => {
      await new Promise<void>((r) => gates.push(r));
      sent.push(...rows.map((r) => r.id as string));
      return { ok: true };
    });
    t.add('a');
    const first = flusher.flush();
    const second = flusher.flush();
    await Promise.resolve();
    gates.shift()!();
    await first;
    // The table is empty now; the next change would take seq 1 again.
    t.add('b');
    await new Promise((r) => setTimeout(r, 0));
    gates.shift()!();
    await second;
    expect(sent).toEqual(['a', 'b']);
    expect(t.left()).toEqual([]);
  });

  it('keeps a change made while a batch is being sent, and the rows of a refused batch', async () => {
    const t = table();
    let refuse = true;
    const sent: string[][] = [];
    const flusher = new OutboxFlusher(t.sql, async (rows) => {
      sent.push(rows.map((r) => r.id as string));
      t.add('during');
      return refuse ? { ok: false, message: 'no' } : { ok: true };
    });
    t.add('x');
    await flusher.flush();
    expect(t.left()).toEqual(['x', 'during']);
    refuse = false;
    await flusher.flush();
    expect(sent.at(-1)).toEqual(['x', 'during']);
    expect(t.left()).toEqual(['during']);
  });
});
