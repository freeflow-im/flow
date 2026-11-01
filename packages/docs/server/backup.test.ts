import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { newWorkbook } from '../shared/types.ts';
import { Backup, keys, parseKey, restore } from './backup.ts';
import { MemoryObjectStore } from './blob.ts';
import { openDb, type DB } from './db.ts';
import { ImageStore } from './images.ts';
import { SheetStore } from './sheets.ts';

const OWNER = 'user-1';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

describe('backup', () => {
  let dir: string;
  let db: DB;
  let store: MemoryObjectStore;
  let backup: Backup;
  let sheets: SheetStore;
  let images: ImageStore;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'backup-'));
    db = openDb(path.join(dir, 'app.db'));
    db.prepare("INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, '', ?)").run(OWNER, 'a@example.com', new Date().toISOString());
    store = new MemoryObjectStore();
    backup = new Backup(store, { dataDir: dir, db, retryDelays: [1, 100] });
    sheets = new SheetStore(db, path.join(dir, 'sheets'));
    await sheets.init();
    sheets.backup = backup;
    images = new ImageStore(db, path.join(dir, 'images'));
    await images.init();
    images.backup = backup;
  });

  afterEach(async () => {
    backup.stop();
    db.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('puts every revision of a file, bases, images and deletion markers', async () => {
    const meta = await sheets.create(OWNER, 'Budget');
    const wb = newWorkbook('t1');
    wb.tabs[0].cells.A1 = { v: '42' };
    const saved = await sheets.save(OWNER, meta.id, wb);
    const branch = await sheets.branch(OWNER, meta.id, 'Budget copy');
    await images.create(OWNER, 'image/png', PNG);
    await sheets.delete(OWNER, meta.id);
    expect(await backup.drain()).toBe(true);

    const ks = [...store.objects.keys()];
    expect(ks).toContain(keys.file(OWNER, 'sheet', meta.id, meta.updatedAt));
    expect(ks).toContain(keys.file(OWNER, 'sheet', meta.id, saved!.updatedAt));
    expect(ks).toContain(keys.base(OWNER, branch!.id));
    expect(ks).toContain(keys.deleted(OWNER, 'sheet', meta.id));
    expect(ks.filter((k) => k.includes('/images/'))).toHaveLength(1);
    const latest = JSON.parse(store.objects.get(keys.file(OWNER, 'sheet', meta.id, saved!.updatedAt))!.body.toString());
    expect(latest.tabs[0].cells.A1.v).toBe('42');
  });

  it('retries a failed put and keeps the save working', async () => {
    store.failing = true;
    const meta = await sheets.create(OWNER, 'Doc');
    expect(sheets.get(OWNER, meta.id)).not.toBeNull();
    await new Promise((r) => setTimeout(r, 5));
    store.failing = false;
    expect(await backup.drain()).toBe(true);
    expect(store.objects.has(keys.file(OWNER, 'sheet', meta.id, meta.updatedAt))).toBe(true);
    expect(backup.failed).toBe(0);
  });

  it('gives up after the retries and reconcile fills the gap', async () => {
    store.failing = true;
    const meta = await sheets.create(OWNER, 'Doc');
    await backup.drain();
    expect(backup.failed).toBe(1);
    store.failing = false;
    expect(store.objects.size).toBe(0);
    const r = await backup.reconcile();
    expect(r).toEqual({ files: 1, bases: 0, images: 0 });
    expect(store.objects.has(keys.file(OWNER, 'sheet', meta.id, meta.updatedAt))).toBe(true);
    // A second pass has nothing to do.
    expect(await backup.reconcile()).toEqual({ files: 0, bases: 0, images: 0 });
  });

  it('snapshots the database and prunes old snapshots', async () => {
    await sheets.create(OWNER, 'Doc');
    const key = await backup.snapshotDb(path.join(dir, 'app.db'), '2026-10-06');
    expect(key).toBe('backups/2026-10-06/app.db');
    expect(await backup.snapshotDb(path.join(dir, 'plugin.db'))).toBeNull();
    await store.put('backups/2026-01-01/app.db', Buffer.from('old'));
    expect(await backup.pruneSnapshots(Date.parse('2026-10-07'))).toBe(1);
    expect([...store.objects.keys()].filter((k) => k.startsWith('backups/'))).toEqual(['backups/2026-10-06/app.db']);
  });

  it('purges files deleted more than 30 days ago', async () => {
    const meta = await sheets.create(OWNER, 'Doc');
    await sheets.delete(OWNER, meta.id);
    await backup.drain();
    expect(await backup.purgeDeleted()).toBe(0);
    await store.put(keys.deleted(OWNER, 'sheet', meta.id), JSON.stringify({ deletedAt: '2026-01-01T00:00:00.000Z' }));
    expect(await backup.purgeDeleted(Date.parse('2026-10-06'))).toBe(1);
    expect([...store.objects.keys()].filter((k) => k.includes(meta.id))).toEqual([]);
  });

  it('restores a data directory with the newest revision of every live file', async () => {
    const a = await sheets.create(OWNER, 'A');
    const wb = newWorkbook('t1');
    wb.tabs[0].cells.B2 = { v: 'latest' };
    await sheets.save(OWNER, a.id, wb);
    const b = await sheets.branch(OWNER, a.id, 'B');
    const gone = await sheets.create(OWNER, 'Gone');
    await sheets.delete(OWNER, gone.id);
    await images.create(OWNER, 'image/png', PNG);
    await backup.drain();
    await backup.snapshotDb(path.join(dir, 'app.db'));

    const target = path.join(dir, 'restored');
    const r = await restore(store, target);
    expect(r).toMatchObject({ databases: ['app.db'], files: 2, bases: 1, images: 1, skippedDeleted: 1 });
    expect(JSON.parse(await readFile(path.join(target, 'sheets', `${a.id}.json`), 'utf8')).tabs[0].cells.B2.v).toBe('latest');
    expect(await readdir(path.join(target, 'sheets'))).toContain(`${b!.id}.base.json`);
    const restored = openDb(path.join(target, 'app.db'));
    expect(restored.prepare('SELECT COUNT(*) AS n FROM sheets').get()).toEqual({ n: 2 });
    restored.close();

    await expect(restore(store, target)).rejects.toThrow(/not empty/);
    const all = await restore(store, path.join(dir, 'restored-all'), { includeDeleted: true });
    expect(all.files).toBe(3);
  });

  it('parses keys', () => {
    expect(parseKey('users/u/doc/d1/2026-10-06T00:00:00.000Z.json')).toEqual({ ownerId: 'u', kind: 'doc', id: 'd1', rest: '2026-10-06T00:00:00.000Z.json' });
    expect(parseKey('users/u/images/i1')).toEqual({ ownerId: 'u', kind: 'images', id: 'i1', rest: '' });
    expect(parseKey('backups/2026-10-06/app.db')).toBeNull();
  });
});
