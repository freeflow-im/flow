// Organizations (server/scope.ts): the roots of the library, the access check, and the stores scoped by them.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openDb, type DB } from './db.ts';
import { FileStore } from './files.ts';
import { FolderStore } from './folders.ts';
import { ImageStore } from './images.ts';
import { canAccess, inScope, scopeKey, type Scope } from './scope.ts';
import { SheetStore } from './sheets.ts';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

let dir: string;
let db: DB;
let sheets: SheetStore;
let files: FileStore;
let folders: FolderStore;
let images: ImageStore;

const harbor = 'ws-harbor';
const other = 'ws-other';
const shared: Scope = { ownerId: 'alice', workspaceId: harbor, private: false };
const aliceAtHarbor: Scope = { ownerId: 'alice', workspaceId: harbor, private: true };
const aliceElsewhere: Scope = { ownerId: 'alice', workspaceId: other, private: true };
const bobAtHarbor: Scope = { ownerId: 'bob', workspaceId: harbor, private: true };
const alice = { userId: 'alice', workspaces: new Set([harbor, other]) };
const bob = { userId: 'bob', workspaces: new Set([harbor]) };
const dave = { userId: 'dave', workspaces: new Set<string>() };

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'docs-scope-'));
  db = openDb(path.join(dir, 'app.db'));
  for (const id of ['alice', 'bob', 'dave']) db.prepare("INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, '', '')").run(id, `${id}@x.test`);
  sheets = new SheetStore(db, path.join(dir, 'sheets'));
  files = new FileStore(db, path.join(dir, 'files'));
  images = new ImageStore(db, path.join(dir, 'images'));
  folders = new FolderStore(db);
  await Promise.all([sheets.init(), files.init(), images.init()]);
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('canAccess', () => {
  const row = (owner_id: string, workspace_id: string | null, priv: number) => ({ owner_id, workspace_id, private: priv });
  it('a private row is its owner’s only, in an organization or not', () => {
    expect(canAccess('alice', row('alice', null, 1))).toBe(true);
    expect(canAccess(bob, row('alice', null, 1))).toBe(false);
    expect(canAccess(alice, row('alice', harbor, 1))).toBe(true);
    expect(canAccess(bob, row('alice', harbor, 1))).toBe(false);
  });
  it('a shared row is any member’s of its organization, and no one else’s', () => {
    expect(canAccess(bob, row('alice', harbor, 0))).toBe(true);
    expect(canAccess(dave, row('alice', harbor, 0))).toBe(false);
    // A plain user id is a user in no organization (the standalone app, the plugin).
    expect(canAccess('bob', row('alice', harbor, 0))).toBe(false);
  });
  it('names each root apart', () => {
    expect(new Set([scopeKey(shared), scopeKey(aliceAtHarbor), scopeKey(aliceElsewhere), scopeKey('alice')]).size).toBe(4);
    expect(inScope(row('alice', null, 1), aliceAtHarbor)).toBe(true);
    expect(inScope(row('alice', harbor, 0), aliceAtHarbor)).toBe(false);
  });
});

describe('the stores, by scope', () => {
  it('lists Organization files to every member, and My files per user and per organization', async () => {
    const team = await sheets.createDoc(shared, 'Team plan', { type: 'doc', content: [] } as never);
    const mine = await sheets.createDoc(aliceAtHarbor, 'Mine at Harbor', { type: 'doc', content: [] } as never);
    const elsewhere = await sheets.createDoc(aliceElsewhere, 'Mine at Other', { type: 'doc', content: [] } as never);
    const legacy = await sheets.createDoc('alice', 'From before', { type: 'doc', content: [] } as never);
    const titles = (list: { title: string }[]) => list.map((m) => m.title).sort();
    expect(titles(sheets.list({ ...shared, ownerId: 'bob' }, 'doc'))).toEqual(['Team plan']);
    expect(titles(sheets.list(aliceAtHarbor, 'doc'))).toEqual(['From before', 'Mine at Harbor']);
    expect(titles(sheets.list(aliceElsewhere, 'doc'))).toEqual(['From before', 'Mine at Other']);
    expect(titles(sheets.list(bobAtHarbor, 'doc'))).toEqual([]);
    // A plain user id: all of the user's private files (the plugin's My files).
    expect(titles(sheets.list('alice', 'doc'))).toEqual(['From before', 'Mine at Harbor', 'Mine at Other']);
    expect(team).toMatchObject({ workspaceId: harbor, shared: true });
    expect(mine.shared).toBeUndefined();
    // By id: find plus canAccess.
    expect(sheets.get(bob, team.id)).not.toBeNull();
    expect(sheets.get(dave, team.id)).toBeNull();
    expect(sheets.get(bob, mine.id)).toBeNull();
    expect(sheets.get(bob, elsewhere.id)).toBeNull();
    expect(sheets.get(bob, legacy.id)).toBeNull();
    expect(await sheets.loadDoc(bob, team.id)).not.toBeNull();
    expect(await sheets.saveDoc(dave, team.id, { type: 'doc', content: [] } as never)).toBeNull();
  });

  it('moves a file between the roots: shared, then private to whoever made it private', async () => {
    const f = await files.create(aliceAtHarbor, 'notes.txt', 'text/plain', Buffer.from('hi'));
    expect(files.get(bob, f.id)).toBeNull();
    expect(files.setScope(alice, f.id, shared, '')).toMatchObject({ shared: true, workspaceId: harbor });
    expect(files.get(bob, f.id)).not.toBeNull();
    files.setScope(bob, f.id, bobAtHarbor, '');
    expect(files.get(alice, f.id)).toBeNull();
    expect(files.get(bob, f.id)).not.toBeNull();
    expect(files.setScope(dave, f.id, shared, '')).toBeNull();
  });

  it('keeps folder paths per root, and moves a folder with its contents', async () => {
    expect(folders.create(shared, 'Clients/Acme')).toBe(true);
    expect(folders.create(aliceAtHarbor, 'Clients')).toBe(true);
    expect(folders.children({ ...shared, ownerId: 'bob' }, '')).toEqual(['Clients']);
    expect(folders.children(bobAtHarbor, '')).toEqual([]);
    const doc = await sheets.createMarkdown(aliceAtHarbor, 'Brief', { version: 1, text: '# Brief' } as never, 'Clients');
    const moved = folders.moveTo(aliceAtHarbor, 'Clients', { ...shared, ownerId: 'alice' });
    expect(moved).toMatchObject({ path: 'Clients', sheets: [doc.id] });
    expect(sheets.get(bob, doc.id)).toMatchObject({ folder: 'Clients', shared: true });
    expect(folders.exists(aliceAtHarbor, 'Clients')).toBe(false);
    expect(folders.remove(shared, 'Clients/Acme')).toBe('ok');
  });

  it('shows a picture to the members of the organization it was uploaded in, or moved into with its file', async () => {
    const url = await images.create(aliceAtHarbor, 'image/png', PNG);
    const id = url.slice('/api/images/'.length);
    expect(images.get(bob, id)).not.toBeNull();
    expect(images.get(dave, id)).toBeNull();
    const old = (await images.create('alice', 'image/png', PNG)).slice('/api/images/'.length);
    expect(images.get(bob, old)).toBeNull();
    images.retag(alice, [old], harbor);
    expect(images.get(bob, old)).not.toBeNull();
  });
});

describe('the migration', () => {
  it('keeps every existing file private and turns the old folders into folders of their owner’s files', () => {
    const file = path.join(dir, 'old.db');
    const old = new DatabaseSync(file);
    old.exec(`
      CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL);
      INSERT INTO users VALUES ('u1', 'u1@x.test', '', '');
      CREATE TABLE folders (owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, path TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (owner_id, path));
      INSERT INTO folders VALUES ('u1', 'Reports', '2026-01-01');
    `);
    old.close();
    const db2 = openDb(file);
    const f = new FolderStore(db2);
    expect(f.exists('u1', 'Reports')).toBe(true);
    expect(f.exists({ ownerId: 'u1', workspaceId: harbor, private: true }, 'Reports')).toBe(true);
    expect(f.exists({ ownerId: 'u1', workspaceId: harbor, private: false }, 'Reports')).toBe(false);
    const cols = (db2.prepare('PRAGMA table_info(sheets)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['workspace_id', 'private']));
    db2.close();
  });
});
