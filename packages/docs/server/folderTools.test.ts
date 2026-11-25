// The assistant's folder tools in this process (server/agent/tools.ts runFolderTool): list a folder, create folders, move
// documents and stored files into one, delete an empty one; and in an organization only a folder's maker deletes it.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { access, atLeast, folderObjectId } from './access.ts';
import { runServerTool, validateToolInput, type FolderTools, type ServerToolEnv } from './agent/tools.ts';
import { openDb, type DB } from './db.ts';
import { FileStore } from './files.ts';
import { FolderStore } from './folders.ts';
import { scopeKey, type Scope, type Viewer } from './scope.ts';
import { SheetStore } from './sheets.ts';

const harbor = 'ws-harbor';
const annMine: Scope = { ownerId: 'ann', workspaceId: harbor, private: true };
const orgRoot: Scope = { ownerId: 'ann', workspaceId: harbor, private: false };
const viewer = (userId: string): Viewer => ({ userId, workspaces: new Set([harbor]), accountId: `acct-${userId}` });

let dir: string;
let db: DB;
let sheets: SheetStore;
let files: FileStore;
let folders: FolderTools;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'docs-folder-tools-'));
  db = openDb(path.join(dir, 'app.db'));
  for (const id of ['ann', 'bob']) db.prepare("INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, '', '')").run(id, `${id}@x.test`);
  sheets = new SheetStore(db, path.join(dir, 'sheets'));
  files = new FileStore(db, path.join(dir, 'files'));
  await sheets.init();
  await files.init();
  const store = new FolderStore(db);
  // As app.ts gives it: an organization's folder is its maker's to delete.
  folders = { store, mayRemove: (v, scope, p) => { const role = access(db, v, 'folder', folderObjectId(scopeKey(scope), p)); return !!role && atLeast(role, 'owner'); } };
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const envFor = (scope: Scope, who: string): ServerToolEnv => ({ userId: who, scope, viewer: viewer(who), sheets, files, folders, context: { page: 'home' } });
const run = async (env: ServerToolEnv, name: string, input: Record<string, unknown>) => {
  const v = validateToolInput(name, input);
  if (!v.ok) throw new Error(v.error);
  return JSON.parse(await runServerTool(name, v.input, env)) as Record<string, any>;
};

describe('folder tools', () => {
  it('create folders, move files into them, list them, and delete an empty one', async () => {
    const env = envFor(annMine, 'ann');
    const doc = await sheets.createDoc(annMine, 'Plan', { type: 'doc', content: [] } as never);
    const pdf = await files.create(annMine, 'invoice.pdf', 'application/pdf', Buffer.from('%PDF-1.4'));
    const dupe = await files.create(annMine, 'invoice (1).pdf', 'application/pdf', Buffer.from('%PDF-1.4'));

    expect(await run(env, 'create_folder', { path: 'Invoices/2026' })).toEqual({ folder: 'Invoices/2026', created: true });
    expect(await run(env, 'create_folder', { path: '/Invoices/' })).toEqual({ folder: 'Invoices', created: false });
    await expect(run(env, 'create_folder', { path: 'a/../b' })).rejects.toThrow(/not a folder path/);

    expect(await run(env, 'move_file', { ids: [pdf.id, dupe.id, doc.id, 'nope'], folder: 'Invoices/2026' })).toEqual({
      folder: 'Invoices/2026',
      moved: [pdf.id, dupe.id, doc.id],
      failed: [{ id: 'nope', error: expect.stringMatching(/no file/) }],
    });
    await expect(run(env, 'move_file', { ids: [pdf.id], folder: 'Nowhere' })).rejects.toThrow(/create_folder/);

    expect(await run(env, 'list_folder', {})).toEqual({ folder: '', folders: ['Invoices'], docs: [], files: [] });
    const inside = await run(env, 'list_folder', { folder: 'Invoices/2026' });
    expect(inside.folders).toEqual([]);
    expect(inside.docs).toEqual([{ id: doc.id, kind: 'doc', title: 'Plan' }]);
    expect(inside.files.map((f: { filename: string }) => f.filename).sort()).toEqual(['invoice (1).pdf', 'invoice.pdf']);
    await expect(run(env, 'list_folder', { folder: 'Nowhere' })).rejects.toThrow(/no folder "Nowhere"/);

    await expect(run(env, 'delete_folder', { path: 'Invoices/2026' })).rejects.toThrow(/not empty/);
    await expect(run(env, 'delete_folder', { path: 'Invoices' })).rejects.toThrow(/not empty/);
    await run(env, 'move_file', { ids: [pdf.id, dupe.id, doc.id], folder: '' });
    expect(await run(env, 'delete_folder', { path: 'Invoices/2026' })).toEqual({ deleted: true, folder: 'Invoices/2026' });
    expect(await run(env, 'delete_folder', { path: 'Invoices' })).toEqual({ deleted: true, folder: 'Invoices' });
    await expect(run(env, 'delete_folder', { path: 'Invoices' })).rejects.toThrow(/no folder/);
    expect((await run(env, 'list_folder', {})).folders).toEqual([]);
  });

  it('moves only within the chat’s root, and an organization’s folder is deleted by its maker alone', async () => {
    const mine = await files.create(annMine, 'private.txt', 'text/plain', Buffer.from('x'));
    const ann = envFor(orgRoot, 'ann');
    await run(ann, 'create_folder', { path: 'Shared' });
    expect(await run(ann, 'move_file', { ids: [mine.id], folder: 'Shared' })).toEqual({ folder: 'Shared', moved: [], failed: [{ id: mine.id, error: expect.stringMatching(/another part of the library/) }] });

    await expect(run(envFor(orgRoot, 'bob'), 'delete_folder', { path: 'Shared' })).rejects.toThrow(/Only the person who made/);
    expect(await run(ann, 'delete_folder', { path: 'Shared' })).toEqual({ deleted: true, folder: 'Shared' });
  });

  it('are not available without the folders', async () => {
    await expect(run({ ...envFor(annMine, 'ann'), folders: undefined }, 'create_folder', { path: 'X' })).rejects.toThrow(/cannot be changed here/);
  });
});
