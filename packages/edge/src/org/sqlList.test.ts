// inList binds one variable whatever the list's length (Durable Object SQLite allows about 100 per statement).
import { describe, expect, it } from 'vitest';
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { orgStorage } from '../../test/orgStorage';
import { inList } from './sqlList';

const items = sqliteTable('list_items', { id: text('id').primaryKey(), n: integer('n').notNull() });

function setup() {
  const { db, sqlite } = orgStorage();
  sqlite.exec('CREATE TABLE list_items (id TEXT PRIMARY KEY, n INTEGER NOT NULL)');
  const insert = sqlite.prepare('INSERT INTO list_items (id, n) VALUES (?, ?)');
  for (let i = 0; i < 400; i++) insert.run(`id-${i}`, i);
  return db;
}

const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();

describe('inList', () => {
  it('an empty list matches nothing', () => {
    const db = setup();
    expect(db.select().from(items).where(inList(items.id, [])).all()).toEqual([]);
  });

  it('one value', () => {
    const db = setup();
    expect(db.select().from(items).where(inList(items.id, ['id-7'])).all()).toEqual([{ id: 'id-7', n: 7 }]);
  });

  it('300 values, past the 100-variable limit, bind as one', () => {
    const db = setup();
    const wanted = Array.from({ length: 300 }, (_, i) => `id-${i}`).concat(['missing']);
    const query = db.select().from(items).where(inList(items.id, wanted));
    expect(query.toSQL().params).toHaveLength(1);
    expect(ids(query.all())).toEqual(Array.from({ length: 300 }, (_, i) => `id-${i}`).sort());
  });

  it('numbers match an integer column', () => {
    const db = setup();
    const wanted = Array.from({ length: 150 }, (_, i) => i * 2);
    const rows = db.select().from(items).where(inList(items.n, wanted)).all();
    expect(rows.map((r) => r.n).sort((a, b) => a - b)).toEqual(wanted.filter((n) => n < 400));
  });
});
