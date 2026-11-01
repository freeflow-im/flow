import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cleanFolderName, cleanFolderPath, folderTrail } from '../shared/folders.ts';
import type { SheetMeta, StoredFile } from '../shared/types.ts';
import { buildApp } from './app.ts';
import { mailbox, signUp } from './testing.ts';

let dir: string;
let app: Awaited<ReturnType<typeof buildApp>>;
let cookie: string;
let other: string;

interface Library {
  folder: string;
  folders: { name: string; path: string }[];
  docs: SheetMeta[];
  files: StoredFile[];
}
const call = async <T>(method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown, as = cookie) => {
  const res = await app.inject({ method, url, payload: payload as object | undefined, headers: { cookie: as } });
  return { status: res.statusCode, body: res.json() as T };
};
const library = async (folder = '', as = cookie) => (await call<Library>('GET', `/api/library${folder ? `?folder=${encodeURIComponent(folder)}` : ''}`, undefined, as)).body;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'sheetsweb-folders-'));
  const box = mailbox();
  app = await buildApp({ dataDir: dir, sendMail: box.send, appUrl: 'https://sheets.test', blob: null });
  cookie = (await signUp(app, box, 'folders@x.com')).cookie;
  other = (await signUp(app, box, 'other@x.com')).cookie;
});

afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('folder paths', () => {
  it('accepts plain names and refuses ones that could reach elsewhere', () => {
    expect(cleanFolderName('  Reports ')).toBe('Reports');
    expect(cleanFolderName('.git')).toBe('.git');
    for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'a:b', 7]) expect(cleanFolderName(bad)).toBeNull();
    expect(cleanFolderPath('')).toBe('');
    expect(cleanFolderPath('a/b')).toBe('a/b');
    expect(cleanFolderPath('a/.x')).toBe('a/.x');
    for (const bad of ['../a', 'a/../b', 'a/./b', 'a/ b']) expect(cleanFolderPath(bad)).toBeNull();
    expect(folderTrail('a/b')).toEqual([{ name: 'a', path: 'a' }, { name: 'b', path: 'a/b' }]);
  });
});

describe('folders', () => {
  it('are created inside one another and listed one level at a time', async () => {
    expect((await call('POST', '/api/folders', { name: 'Reports' })).status).toBe(200);
    expect((await call<{ folder: { path: string } }>('POST', '/api/folders', { name: '2026', folder: 'Reports' })).body.folder.path).toBe('Reports/2026');
    expect((await call('POST', '/api/folders', { name: 'Reports' })).status).toBe(409);
    expect((await call('POST', '/api/folders', { name: 'x', folder: 'Nowhere' })).status).toBe(404);
    expect((await library()).folders).toEqual([{ name: 'Reports', path: 'Reports' }]);
    expect((await library('Reports')).folders).toEqual([{ name: '2026', path: 'Reports/2026' }]);
    // Another account sees none of it.
    expect((await library('', other)).folders).toEqual([]);
    expect((await call('GET', '/api/library?folder=Reports', undefined, other)).status).toBe(404);
  });

  it('hold the files created in them and the ones moved there', async () => {
    const inFolder = (await call<{ sheet: SheetMeta }>('POST', '/api/sheets', { title: 'Budget', folder: 'Reports' })).body.sheet;
    expect(inFolder.folder).toBe('Reports');
    const top = (await call<{ doc: SheetMeta }>('POST', '/api/markdown', { title: 'Notes' })).body.doc;
    expect(top.folder).toBeUndefined();
    expect((await library()).docs.map((d) => d.title)).toEqual(['Notes']);
    expect((await library('Reports')).docs.map((d) => d.title)).toEqual(['Budget']);
    // The lists of one kind still cover every folder.
    expect((await call<{ sheets: SheetMeta[] }>('GET', '/api/sheets')).body.sheets.map((s) => s.title)).toEqual(['Budget']);

    expect((await call('POST', '/api/library/move', { kind: 'markdown', id: top.id, folder: 'Reports/2026' })).status).toBe(200);
    expect((await library()).docs).toEqual([]);
    expect((await library('Reports/2026')).docs.map((d) => [d.title, d.folder])).toEqual([['Notes', 'Reports/2026']]);
    expect((await call('POST', '/api/library/move', { kind: 'markdown', id: top.id, folder: 'Nowhere' })).status).toBe(404);
    expect((await call('POST', '/api/library/move', { kind: 'markdown', id: top.id, folder: '' }, other)).status).toBe(404);

    const up = await app.inject({ method: 'POST', url: '/api/files?folder=Reports', headers: { cookie, 'content-type': 'application/pdf', 'x-filename': 'scan.pdf' }, payload: Buffer.from('%PDF-1.4') });
    expect((up.json() as { file: StoredFile }).file.folder).toBe('Reports');
    expect((await library('Reports')).files.map((f) => f.filename)).toEqual(['scan.pdf']);
  });

  it('are all covered by a search, which finds folders and files by name', async () => {
    const found = (await call<Library & { truncated: boolean }>('GET', '/api/library/search?q=' + encodeURIComponent('2026'))).body;
    expect(found.folders).toEqual([{ name: '2026', path: 'Reports/2026' }]);
    const byName = (await call<Library>('GET', '/api/library/search?q=NOTES')).body;
    expect(byName.docs.map((d) => [d.title, d.folder])).toEqual([['Notes', 'Reports/2026']]);
    const pdf = (await call<Library>('GET', '/api/library/search?q=scan')).body;
    expect(pdf.files.map((f) => [f.filename, f.folder])).toEqual([['scan.pdf', 'Reports']]);
    // Text with a slash is the end of a path: the folder's name (or its end) and then the file's.
    const byPath = async (q: string) => (await call<Library>('GET', '/api/library/search?q=' + encodeURIComponent(q))).body;
    expect((await byPath('reports/SCAN')).files.map((f) => f.filename)).toEqual(['scan.pdf']);
    expect((await byPath('2026/notes')).docs.map((d) => d.title)).toEqual(['Notes']);
    expect((await byPath('ports/scan')).files.map((f) => f.filename)).toEqual(['scan.pdf']);
    expect((await byPath('/ports/scan')).files).toEqual([]);
    expect((await byPath('2026/scan')).files).toEqual([]);
    expect((await byPath('Reports/20')).folders).toEqual([{ name: '2026', path: 'Reports/2026' }]);
    // Text is matched as written, not as a pattern, and only in the account's own files.
    expect((await call<Library>('GET', '/api/library/search?q=%25')).body.docs).toEqual([]);
    expect((await call<Library>('GET', '/api/library/search?q=notes', undefined, other)).body.docs).toEqual([]);
    expect((await call('GET', '/api/library/search?q=')).status).toBe(400);
  });

  it('can only be deleted when empty', async () => {
    expect((await call('DELETE', '/api/folders?folder=Reports')).status).toBe(409);
    expect((await call('DELETE', '/api/folders?folder=Reports/2026')).status).toBe(409);
    const [notes] = (await library('Reports/2026')).docs;
    await call('POST', '/api/library/move', { kind: 'markdown', id: notes.id, folder: '' });
    expect((await call('DELETE', '/api/folders?folder=Reports/2026')).status).toBe(200);
    expect((await library('Reports')).folders).toEqual([]);
    expect((await call('DELETE', '/api/folders?folder=Reports/2026')).status).toBe(404);
    expect((await call('DELETE', '/api/folders')).status).toBe(404);
  });
});

describe('favorites', () => {
  interface Favs {
    files: { id: string; kind: string; name: string; folder: string }[];
    folders: { name: string; path: string; where: string }[];
    keys: string[];
  }
  const favs = async (as = cookie) => (await call<Favs>('GET', '/api/favorites', undefined, as)).body;

  it('are the folders and files the user marks, newest first, and forget what is deleted', async () => {
    await call('POST', '/api/folders', { name: 'Kept' });
    await call('POST', '/api/folders', { name: 'Inner', folder: 'Kept' });
    const doc = (await call<{ doc: SheetMeta }>('POST', '/api/markdown', { title: 'Pinned', text: '# Pinned', folder: 'Kept' })).body.doc;
    expect((await call('POST', '/api/favorites', { folder: 'Kept/Inner', on: true })).status).toBe(200);
    expect((await call('POST', '/api/favorites', { kind: 'markdown', id: doc.id, on: true })).status).toBe(200);
    // Only what is there, and only the account's own.
    expect((await call('POST', '/api/favorites', { folder: 'Nowhere', on: true })).status).toBe(404);
    expect((await call('POST', '/api/favorites', { kind: 'markdown', id: doc.id, on: true }, other)).status).toBe(404);

    const mine = await favs();
    expect(mine.files.map((f) => [f.kind, f.id, f.name, f.folder])).toEqual([['markdown', doc.id, 'Pinned', 'Kept']]);
    expect(mine.folders).toEqual([{ name: 'Inner', path: 'Kept/Inner', where: 'Kept' }]);
    expect(mine.keys).toEqual([`markdown:${doc.id}`, 'folder:Kept/Inner']);
    expect((await favs(other)).keys).toEqual([]);
    // An editor's star asks after one file.
    const one = async (as = cookie) => (await call<{ on: boolean }>('GET', `/api/favorites/one?kind=markdown&id=${doc.id}`, undefined, as)).body.on;
    expect(await one()).toBe(true);
    expect((await call('GET', `/api/favorites/one?kind=markdown&id=${doc.id}`, undefined, other)).status).toBe(404);

    // Taken off the list, or deleted: gone from it.
    await call('POST', '/api/favorites', { folder: 'Kept/Inner', on: false });
    expect((await favs()).folders).toEqual([]);
    await call('POST', '/api/favorites', { kind: 'markdown', id: doc.id, on: false });
    expect(await one()).toBe(false);
    await call('POST', '/api/favorites', { kind: 'markdown', id: doc.id, on: true });
    await call('DELETE', `/api/markdown/${doc.id}`);
    expect(await favs()).toEqual({ files: [], folders: [], keys: [] });
  });
});
