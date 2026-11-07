// Grants in Docs (server/access.ts, platform phase 3.2): the role a reader has on a file or folder, from the owner
// column and the grants of its container chain; and the one-time migration from `private` and public links.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { access, folderObjectId, grant, linkTokenOf, resolveLink, roleOf } from './access.ts';
import { openDb, type DB } from './db.ts';
import { FolderStore } from './folders.ts';
import { scopeKey, type Scope, type Viewer } from './scope.ts';
import { SheetStore } from './sheets.ts';

const harbor = 'ws-harbor';
const annMine: Scope = { ownerId: 'ann', workspaceId: harbor, private: true };
const orgRoot: Scope = { ownerId: 'ann', workspaceId: harbor, private: false };
const reader = (userId: string, more: Partial<Viewer> = {}): Viewer => ({ userId, workspaces: new Set([harbor]), accountId: `acct-${userId}`, ...more });
const ann = reader('ann');
const bob = reader('bob');
const cat = reader('cat', { channelIds: ['general'] });
const dave = { userId: 'dave', workspaces: new Set<string>(), accountId: 'acct-dave', channelIds: ['general'] };
const DOC = { type: 'doc', content: [] } as never;

let dir: string;
let db: DB;
let sheets: SheetStore;
let folders: FolderStore;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'docs-access-'));
  db = openDb(path.join(dir, 'app.db'));
  for (const id of ['ann', 'bob', 'cat', 'dave']) db.prepare("INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, '', '')").run(id, `${id}@x.test`);
  sheets = new SheetStore(db, path.join(dir, 'sheets'));
  folders = new FolderStore(db);
  await sheets.init();
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('access', () => {
  it('the owner is the owner; a private file is no one else’s', async () => {
    const doc = await sheets.createDoc(annMine, 'Plan', DOC);
    expect(access(db, ann, 'sheet', doc.id)).toBe('owner');
    expect(access(db, bob, 'sheet', doc.id)).toBeNull();
    expect(access(db, 'ann', 'sheet', doc.id)).toBe('owner');
    expect(access(db, bob, 'sheet', 'no-such-id')).toBeNull();
  });

  it('a grant to an account gives that account its role, and no one else', async () => {
    const doc = await sheets.createDoc(annMine, 'For Bob', DOC);
    grant(db, 'sheet', doc.id, 'account:acct-bob', 'viewer', 'ann');
    expect(access(db, bob, 'sheet', doc.id)).toBe('viewer');
    expect(access(db, cat, 'sheet', doc.id)).toBeNull();
    // A member of another organization's account, or one not in the row's organization, gets nothing from it.
    expect(access(db, { ...bob, workspaces: new Set() }, 'sheet', doc.id)).toBeNull();
  });

  it('inherits through two folders, to the channel’s members', async () => {
    folders.create(annMine, 'Projects/Q4');
    const doc = await sheets.createDoc(annMine, 'Deep', DOC, 'Projects/Q4');
    grant(db, 'folder', folderObjectId(scopeKey(annMine), 'Projects'), 'channel:general', 'editor', 'ann');
    expect(access(db, cat, 'sheet', doc.id)).toBe('editor');
    expect(access(db, cat, 'folder', folderObjectId(scopeKey(annMine), 'Projects/Q4'))).toBe('editor');
    expect(access(db, bob, 'sheet', doc.id)).toBeNull();
    // Dave is in the channel's list but not in the organization.
    expect(access(db, dave, 'sheet', doc.id)).toBeNull();
    // The highest role of the chain wins.
    grant(db, 'sheet', doc.id, 'channel:general', 'viewer', 'ann');
    expect(access(db, cat, 'sheet', doc.id)).toBe('editor');
  });

  it('an organization file is every member’s to edit (its org grant)', async () => {
    const doc = await sheets.createDoc(orgRoot, 'Team', DOC);
    expect(access(db, bob, 'sheet', doc.id)).toBe('editor');
    expect(access(db, dave, 'sheet', doc.id)).toBeNull();
    expect(access(db, 'bob', 'sheet', doc.id)).toBeNull();
  });

  it('a link grant opens its file by its token, until it expires', async () => {
    const deck = await sheets.createDeck(annMine, 'Talk', { version: 1, slides: [] } as never);
    const token = 'a'.repeat(32);
    grant(db, 'sheet', deck.id, `link:${token}`, 'viewer', 'ann');
    expect(linkTokenOf(db, 'sheet', deck.id)).toBe(token);
    expect(resolveLink(db, token)).toEqual({ kind: 'sheet', id: deck.id, grantedBy: 'ann' });
    // A link is not a member's grant: it gives a signed-in member nothing by itself.
    expect(access(db, bob, 'sheet', deck.id)).toBeNull();
    grant(db, 'sheet', deck.id, `link:${token}`, 'viewer', 'ann', new Date(Date.now() - 1000).toISOString());
    expect(resolveLink(db, token)).toBeNull();
    expect(linkTokenOf(db, 'sheet', deck.id)).toBeNull();
  });

  it('an expired grant gives nothing', async () => {
    const doc = await sheets.createDoc(annMine, 'Lapsed', DOC);
    grant(db, 'sheet', doc.id, 'account:acct-bob', 'editor', 'ann', new Date(Date.now() - 1000).toISOString());
    expect(access(db, bob, 'sheet', doc.id)).toBeNull();
    grant(db, 'sheet', doc.id, 'account:acct-bob', 'editor', 'ann', new Date(Date.now() + 60_000).toISOString());
    expect(access(db, bob, 'sheet', doc.id)).toBe('editor');
  });

  it('a viewer reads but cannot write, rename or delete; an editor writes but cannot delete', async () => {
    const doc = await sheets.createDoc(annMine, 'Read me', DOC);
    grant(db, 'sheet', doc.id, 'account:acct-bob', 'viewer', 'ann');
    expect((await sheets.loadDoc(bob, doc.id))?.meta).toMatchObject({ title: 'Read me', role: 'viewer' });
    await expect(sheets.saveDoc(bob, doc.id, DOC)).rejects.toMatchObject({ statusCode: 403 });
    expect(() => sheets.rename(bob, doc.id, 'Mine now')).toThrow(/not change it/);
    grant(db, 'sheet', doc.id, 'account:acct-bob', 'editor', 'ann');
    expect(await sheets.saveDoc(bob, doc.id, DOC)).toMatchObject({ role: 'editor' });
    await expect(sheets.delete(bob, doc.id)).rejects.toMatchObject({ statusCode: 403 });
    expect(await sheets.delete(ann, doc.id)).toBe(true);
    // Its grants go with it.
    expect(db.prepare('SELECT COUNT(*) AS n FROM grants WHERE object_id = ?').get(doc.id)).toEqual({ n: 0 });
  });

  it('roleOf takes the row as read', () => {
    expect(roleOf(db, ann, 'file', { id: 'x', owner_id: 'ann', workspace_id: null, private: 1 })).toBe('owner');
  });
});

describe('the migration to grants', () => {
  it('gives shared rows the org grant and private rows none, turns public links into link grants, and derives private again', async () => {
    const file = path.join(dir, 'before.db');
    let old = openDb(file);
    old.prepare("INSERT INTO users (id, email, password_hash, created_at) VALUES ('ann', 'ann@x.test', '', '')").run();
    const insert = old.prepare("INSERT INTO sheets (id, owner_id, workspace_id, private, kind, title, folder, file, created_at, updated_at) VALUES (?, 'ann', ?, ?, ?, ?, ?, '', '', '')");
    insert.run('private-doc', harbor, 1, 'doc', 'Mine', '');
    insert.run('shared-doc', harbor, 0, 'doc', 'Team', 'Reports');
    insert.run('stray-doc', null, 0, 'doc', 'Shared with no organization', '');
    insert.run('talk', harbor, 1, 'deck', 'Talk', '');
    old.prepare("INSERT INTO stored_files (id, owner_id, workspace_id, private, filename, folder, type, size, created_at) VALUES ('clip', 'ann', ?, 1, 'clip.mp4', '', 'video/mp4', 1, '')").run(harbor);
    old.prepare("INSERT INTO folders (owner_id, workspace_id, private, scope, path, created_at) VALUES ('ann', ?, 0, ?, 'Reports', '')").run(harbor, `org:${harbor}`);
    old.prepare("INSERT INTO public_links (token, owner_id, workspace_id, kind, file_id, created_at) VALUES (?, 'ann', ?, 'deck', 'talk', '2026-10-01T00:00:00.000Z'), (?, 'ann', ?, 'file', 'clip', '2026-10-02T00:00:00.000Z')").run('t'.repeat(32), harbor, 'v'.repeat(32), harbor);
    // As a database from before grants: none, and the migration not yet run.
    old.exec("DELETE FROM grants; DELETE FROM docs_migrations WHERE name = 'grants'");
    old.close();

    old = openDb(file);
    const grants = old.prepare('SELECT object_kind, object_id, principal, role, granted_by FROM grants ORDER BY object_kind, object_id').all();
    expect(grants).toEqual([
      { object_kind: 'file', object_id: 'clip', principal: `link:${'v'.repeat(32)}`, role: 'viewer', granted_by: 'ann' },
      { object_kind: 'folder', object_id: `org:${harbor}/Reports`, principal: 'org', role: 'editor', granted_by: 'ann' },
      { object_kind: 'sheet', object_id: 'shared-doc', principal: 'org', role: 'editor', granted_by: 'ann' },
      { object_kind: 'sheet', object_id: 'talk', principal: `link:${'t'.repeat(32)}`, role: 'viewer', granted_by: 'ann' },
    ]);
    expect(old.prepare("SELECT granted_at FROM grants WHERE object_id = 'talk'").get()).toEqual({ granted_at: Date.parse('2026-10-01T00:00:00.000Z') });
    const priv = Object.fromEntries((old.prepare('SELECT id, private FROM sheets').all() as { id: string; private: number }[]).map((r) => [r.id, r.private]));
    expect(priv).toEqual({ 'private-doc': 1, 'shared-doc': 0, 'stray-doc': 1, talk: 1 });
    // The public links stay, unread, for one release; the migration runs once.
    expect(old.prepare('SELECT COUNT(*) AS n FROM public_links').get()).toEqual({ n: 2 });
    old.prepare("DELETE FROM grants WHERE object_id = 'shared-doc'").run();
    old.close();
    old = openDb(file);
    expect(old.prepare("SELECT COUNT(*) AS n FROM grants WHERE object_id = 'shared-doc'").get()).toEqual({ n: 0 });
    old.close();
  });
});
