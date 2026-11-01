import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { openDb } from './db.ts';
import { SignatureStore } from './signatures.ts';

it('keeps the one signature the first version saved as the first of the list', () => {
  const db = openDb(path.join(mkdtempSync(path.join(tmpdir(), 'sig-')), 'app.db'));
  db.prepare("INSERT INTO users (id, email, password_hash, created_at) VALUES ('u1', 'a@x.com', '', '2026-01-01')").run();
  db.exec('CREATE TABLE signatures (user_id TEXT PRIMARY KEY, image TEXT NOT NULL, updated_at TEXT NOT NULL)');
  db.prepare("INSERT INTO signatures VALUES ('u1', 'data:image/png;base64,old', '2026-10-19T00:00:00.000Z')").run();
  const store = new SignatureStore(db);
  store.add('u1', 'data:image/png;base64,new');
  expect(store.list('u1').map((s) => s.image)).toEqual(['data:image/png;base64,old', 'data:image/png;base64,new']);
  expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'signatures'").get()).toBeUndefined();
  // Opening it again changes nothing.
  expect(new SignatureStore(db).list('u1')).toHaveLength(2);
});
