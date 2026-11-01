import ExcelJS from 'exceljs';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SheetMeta, StoredFile, Workbook } from '../shared/types.ts';
import { buildApp, LOCAL_COOKIE, SCRATCH_DIR, scratchPadName } from './app.ts';
import { DatabaseSync } from 'node:sqlite';
import { LISTED_EXTS } from './localStore.ts';
import { APP_RECENTS, listable, openedFiles, parseRecents, recentFiles, RecentOpens } from './recents.ts';
import { onOwnWrite } from './sheets.ts';
import { importXlsx } from './xlsxImport.ts';
import { importPptx } from './pptxImport.ts';
import { newId, type Deck, type TextElement } from '../shared/deck.ts';
import { docText, docNode, type Doc } from '../shared/doc.ts';
import { markdownToDoc } from '../shared/docMarkdown.ts';
import JSZip from 'jszip';
import { docDocx } from './docxExport.ts';
import { importDocx } from './docxImport.ts';

// The desktop app's storage: a folder of real files instead of the data directory (server/localStore.ts).
let folder: string;
let dataDir: string;
let app: Awaited<ReturnType<typeof buildApp>>;

const at = (...parts: string[]) => path.join(folder, ...parts);
const call = async <T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown) => {
  const res = await app.inject({ method, url, payload: payload as object | undefined });
  return { status: res.statusCode, body: res.json() as T };
};
const sheets = async () => (await call<{ sheets: SheetMeta[] }>('GET', '/api/sheets')).body.sheets;
interface Library {
  folders: { name: string; path: string }[];
  docs: SheetMeta[];
  files: StoredFile[];
}
const library = async (folder = '') => (await call<Library>('GET', `/api/library${folder ? `?folder=${encodeURIComponent(folder)}` : ''}`)).body;
const markdown = async () => (await call<{ docs: SheetMeta[] }>('GET', '/api/markdown')).body.docs;

beforeAll(async () => {
  folder = mkdtempSync(path.join(tmpdir(), 'sheetsweb-folder-'));
  dataDir = mkdtempSync(path.join(tmpdir(), 'sheetsweb-localdata-'));
  mkdirSync(at('reports'));
  mkdirSync(at('.git'));
  mkdirSync(at('node_modules', 'pkg'), { recursive: true });
  writeFileSync(at('notes.md'), '# Notes\n\nHello\n');
  writeFileSync(at('reports', 'stock.csv'), 'name,qty\r\napple,3\r\n');
  writeFileSync(at('scan.pdf'), '%PDF-1.4 test');
  writeFileSync(at('.git', 'hidden.md'), 'hidden');
  writeFileSync(at('node_modules', 'pkg', 'README.md'), 'dependency');
  writeFileSync(at('script.py'), 'print(1)');
  writeFileSync(at('.env'), 'KEY=1\n');
  mkdirSync(at('.config'));
  writeFileSync(at('.config', 'settings.yaml'), 'a: 1\n');
  writeFileSync(at('.DS_Store'), 'finder');
  app = await buildApp({ dataDir, local: { dir: folder } });
});

afterAll(async () => {
  await app.close();
  rmSync(folder, { recursive: true, force: true });
  rmSync(dataDir, { recursive: true, force: true });
});

describe('a mounted folder', () => {
  it('needs no sign-in and reports the folder', async () => {
    const me = await call<{ user: { id: string } | null; local?: { dir: string } }>('GET', '/api/auth/me');
    expect(me.body.user?.id).toBe('local');
    expect(me.body.local?.dir).toBe(path.resolve(folder));
  });

  it('shows one folder at a time: its folders and every file in it, hidden ones too, without node_modules', async () => {
    const top = await library();
    expect(top.folders).toEqual([
      { name: '.config', path: '.config' },
      { name: '.git', path: '.git' },
      { name: 'reports', path: 'reports' },
    ]);
    expect(top.docs.map((d) => [d.title, d.kind])).toEqual([['notes.md', 'markdown']]);
    // A file the app cannot show is listed too, as a stored file of a type it does not know.
    expect(top.files.map((f) => [f.filename, f.type]).sort()).toEqual([
      ['.env', 'application/octet-stream'],
      ['scan.pdf', 'application/pdf'],
      ['script.py', 'application/octet-stream'],
    ]);
    const reports = await library('reports');
    expect(reports.folders).toEqual([]);
    expect(reports.docs.map((d) => [d.title, d.format, d.folder])).toEqual([['stock.csv', 'csv', 'reports']]);
    // A hidden folder opens like any other. (The assistant's list, below, does not look through .git, a repository's history.)
    // Both are plain text, so they open in the text editor.
    expect((await library('.config')).files.map((f) => [f.filename, f.text])).toEqual([['settings.yaml', true]]);
    expect(top.files.find((f) => f.filename === '.env')?.text).toBe(true);
    expect((await call('GET', '/api/library?folder=missing')).status).toBe(404);
    expect((await call('GET', '/api/library?folder=..')).status).toBe(404);
  });

  // Windows has no modes that make a folder unreadable.
  it.skipIf(process.platform === 'win32')('says so when a folder cannot be read, rather than showing it empty', async () => {
    mkdirSync(at('locked'));
    chmodSync(at('locked'), 0o000);
    try {
      const res = await call<{ error: string }>('GET', '/api/library?folder=locked');
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/permission to read “locked”/);
    } finally {
      chmodSync(at('locked'), 0o755);
      rmSync(at('locked'), { recursive: true });
    }
  });

  it('lists every file of a kind for the assistant, wherever it is', async () => {
    expect((await markdown()).map((d) => d.title)).toEqual(['notes.md']);
    expect((await sheets()).map((s) => [s.title, s.folder, s.format])).toEqual([['stock.csv', 'reports', 'csv']]);
  });

  it('reads and writes Markdown files as plain text', async () => {
    const [meta] = await markdown();
    const loaded = await call<{ meta: SheetMeta; doc: { text: string } }>('GET', `/api/markdown/${meta.id}`);
    expect(loaded.body.doc.text).toBe('# Notes\n\nHello\n');
    const saved = await call<{ meta: SheetMeta }>('PUT', `/api/markdown/${meta.id}`, { doc: { version: 1, text: '# Notes\n\nChanged\n' }, rev: loaded.body.meta.updatedAt });
    expect(saved.status).toBe(200);
    expect(readFileSync(at('notes.md'), 'utf8')).toBe('# Notes\n\nChanged\n');
    // No temp files are left next to it.
    expect(readdirSync(folder).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });

  it('refuses a save over a file that was edited outside the app', async () => {
    const [meta] = await markdown();
    writeFileSync(at('notes.md'), 'edited in another program');
    utimesSync(at('notes.md'), new Date(), new Date(Date.now() + 5000));
    const saved = await call('PUT', `/api/markdown/${meta.id}`, { doc: { version: 1, text: 'mine' }, rev: meta.updatedAt });
    expect(saved.status).toBe(409);
    expect(readFileSync(at('notes.md'), 'utf8')).toBe('edited in another program');
  });

  it('keeps a CSV file as CSV, and makes it an Excel file when it becomes a spreadsheet', async () => {
    const [meta] = await sheets();
    const { workbook } = (await call<{ workbook: Workbook }>('GET', `/api/sheets/${meta.id}`)).body;
    workbook.tabs[0].cells.B2 = { v: '4' };
    await call('PUT', `/api/sheets/${meta.id}`, { workbook });
    expect(readFileSync(at('reports', 'stock.csv'), 'utf8')).toBe('name,qty\r\napple,4\r\n');

    const converted = await call<{ sheet: SheetMeta }>('POST', `/api/sheets/${meta.id}/convert`, {});
    expect(converted.body.sheet.format).toBe('xlsx');
    expect(existsSync(at('reports', 'stock.csv'))).toBe(false);
    expect((await importXlsx(readFileSync(at('reports', 'stock.xlsx')))).workbook.tabs[0].cells.B2.v).toBe('4');
    // Same document, same place in the list.
    expect((await sheets()).map((s) => [s.id, s.title, s.folder, s.format])).toEqual([[meta.id, 'stock.xlsx', 'reports', 'xlsx']]);
    // Nothing of the CSV file was kept as an Excel file's original.
    expect(existsSync(path.join(dataDir, 'trash'))).toBe(false);
  });

  it('creates new documents as files named by their title, without overwriting', async () => {
    const a = await call<{ doc: SheetMeta }>('POST', '/api/markdown', { title: 'notes', text: 'second' });
    expect(a.body.doc.title).toBe('notes 2.md');
    expect(readFileSync(at('notes 2.md'), 'utf8')).toBe('second');
    const deck = await call<{ deck: SheetMeta }>('POST', '/api/decks', { title: 'Q3: kickoff', folder: 'reports' });
    expect([deck.body.deck.title, deck.body.deck.folder]).toEqual(['Q3 kickoff.pptx', 'reports']);
    expect(existsSync(at('reports', 'Q3 kickoff.pptx'))).toBe(true);
    // Neither a title nor a folder can reach outside the mounted folder.
    const out = await call<{ doc: SheetMeta }>('POST', '/api/markdown', { title: '../../escape' });
    expect(out.body.doc.title).toBe('-..-escape.md');
    expect(existsSync(at('-..-escape.md'))).toBe(true);
    expect((await call('POST', '/api/markdown', { title: 'x', folder: '../outside' })).status).toBe(404);
  });

  it('makes folders as directories, moves files between them and deletes only empty ones', async () => {
    expect((await call('POST', '/api/folders', { name: 'archive' })).status).toBe(200);
    expect((await call('POST', '/api/folders', { name: 'archive' })).status).toBe(409);
    expect((await call('POST', '/api/folders', { name: '../up' })).status).toBe(400);
    expect((await call('POST', '/api/folders', { name: '2026', folder: 'archive' })).status).toBe(200);
    expect(existsSync(at('archive', '2026'))).toBe(true);

    const doc = (await library()).docs.find((d) => d.title === 'notes 2.md')!;
    expect((await call('POST', '/api/library/move', { kind: 'markdown', id: doc.id, folder: 'archive/2026' })).status).toBe(200);
    expect(existsSync(at('notes 2.md'))).toBe(false);
    expect(readFileSync(at('archive', '2026', 'notes 2.md'), 'utf8')).toBe('second');
    expect((await library('archive/2026')).docs.map((d) => [d.id, d.title])).toEqual([[doc.id, 'notes 2.md']]);

    const pdf = (await library()).files.find((f) => f.filename === 'scan.pdf')!;
    expect((await call('POST', '/api/library/move', { kind: 'file', id: pdf.id, folder: 'archive' })).status).toBe(200);
    expect(existsSync(at('archive', 'scan.pdf'))).toBe(true);
    expect((await app.inject({ method: 'GET', url: pdf.url })).body).toBe('%PDF-1.4 test');
    await call('POST', '/api/library/move', { kind: 'file', id: pdf.id, folder: '' });

    expect((await call('DELETE', '/api/folders?folder=archive')).status).toBe(409);
    // A directory holding files the library does not list is not empty either.
    mkdirSync(at('code'));
    writeFileSync(at('code', 'main.py'), 'print(1)');
    expect((await call('DELETE', '/api/folders?folder=code')).status).toBe(409);
    expect(existsSync(at('code', 'main.py'))).toBe(true);
    mkdirSync(at('empty'));
    expect((await call('DELETE', '/api/folders?folder=empty')).status).toBe(200);
    expect(existsSync(at('empty'))).toBe(false);
  });

  it('renames the file with the document and moves a deleted one out of the folder', async () => {
    const doc = (await markdown()).find((d) => d.title === 'notes 2.md')!;
    const renamed = await call<{ meta: SheetMeta }>('PATCH', `/api/markdown/${doc.id}`, { title: 'old notes' });
    expect([renamed.body.meta.title, renamed.body.meta.folder]).toEqual(['old notes.md', 'archive/2026']);
    // Typed with the extension, it is not doubled; the extension stays whatever is typed.
    const again = await call<{ meta: SheetMeta }>('PATCH', `/api/markdown/${doc.id}`, { title: 'older notes.md' });
    expect(again.body.meta.title).toBe('older notes.md');
    expect(existsSync(at('archive', '2026', 'older notes.md'))).toBe(true);
    const back = await call<{ meta: SheetMeta }>('PATCH', `/api/markdown/${doc.id}`, { title: 'old notes' });
    expect(back.body.meta.title).toBe('old notes.md');
    expect(existsSync(at('archive', '2026', 'notes 2.md'))).toBe(false);
    expect(readFileSync(at('archive', '2026', 'old notes.md'), 'utf8')).toBe('second');

    expect((await call('DELETE', `/api/markdown/${doc.id}`)).status).toBe(200);
    expect(existsSync(at('archive', '2026', 'old notes.md'))).toBe(false);
    const trashed = readdirSync(path.join(dataDir, 'trash'));
    expect(trashed).toHaveLength(1);
    expect(readFileSync(path.join(dataDir, 'trash', trashed[0]), 'utf8')).toBe('second');
    expect((await markdown()).some((d) => d.id === doc.id)).toBe(false);
  });

  it('searches the whole folder by name, including files it has not listed yet', async () => {
    mkdirSync(at('deep', 'er', 'still'), { recursive: true });
    writeFileSync(at('deep', 'er', 'still', 'Quarterly plan.md'), 'plan');
    writeFileSync(at('deep', 'er', 'quarterly.pdf'), '%PDF');
    writeFileSync(at('deep', 'quarterly.py'), 'any file');
    writeFileSync(at('node_modules', 'pkg', 'quarterly.md'), 'dependency');
    const found = (await call<Library & { truncated: boolean }>('GET', '/api/library/search?q=QUARTER')).body;
    expect(found.docs.map((d) => [d.title, d.folder])).toEqual([['Quarterly plan.md', 'deep/er/still']]);
    expect(found.files.map((f) => [f.filename, f.folder])).toEqual([
      ['quarterly.py', 'deep'],
      ['quarterly.pdf', 'deep/er'],
    ]);
    expect(found.truncated).toBe(false);
    // A result opens like any other file.
    expect((await call<{ doc: { text: string } }>('GET', `/api/markdown/${found.docs[0].id}`)).body.doc.text).toBe('plan');
    expect((await call<Library>('GET', '/api/library/search?q=still')).body.folders).toEqual([{ name: 'still', path: 'deep/er/still' }]);
    // Text with a slash is the end of a path.
    const byPath = async (q: string) => (await call<Library>('GET', '/api/library/search?q=' + encodeURIComponent(q))).body;
    expect((await byPath('er/quarterly')).files.map((f) => [f.filename, f.folder])).toEqual([['quarterly.pdf', 'deep/er']]);
    expect((await byPath('still/QUARTER')).docs.map((d) => d.title)).toEqual(['Quarterly plan.md']);
    expect((await byPath('eep/quarterly')).files.map((f) => f.filename)).toEqual(['quarterly.py']);
    expect((await byPath('/eep/quarterly')).files).toEqual([]);
    // Finding some files did not make the app forget the others.
    expect((await library('reports')).docs.length).toBeGreaterThan(0);
  });

  it('asks an index (Spotlight) before walking the folder, and walks when it has no answer', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sheetsweb-folder-'));
    const data = mkdtempSync(path.join(tmpdir(), 'sheetsweb-localdata-'));
    const inDir = (...parts: string[]) => path.join(dir, ...parts);
    mkdirSync(inDir('a', 'Budget stuff'), { recursive: true });
    mkdirSync(inDir('node_modules'));
    mkdirSync(inDir('.git'));
    for (const f of [['a', 'Budget stuff', 'budget 2026.md'], ['budget.pdf'], ['node_modules', 'budget.md'], ['.git', 'budget'], ['unindexed budget.md']]) writeFileSync(inDir(...f), 'x');
    const asked: string[] = [];
    let answer: (root: string) => string[] | null = (root) => [
      ...['a/Budget stuff/budget 2026.md', 'a/Budget stuff', 'budget.pdf', 'node_modules/budget.md', '.git/budget', 'gone budget.md', 'notes.md'].map((p) => path.join(root, p)),
      path.join(path.dirname(root), 'outside budget.md'),
    ];
    const indexed = await buildApp({ dataDir: data, local: { dir, recents: null, findByName: async (root, text) => (asked.push(text), answer(root)) } });
    const search = async (q: string) => (await indexed.inject({ method: 'GET', url: `/api/library/search?q=${q}` })).json() as Library & { truncated: boolean };
    try {
      // What the index found, held to what a walk would: matching names only, none under skipped or outside folders, nearest first.
      const found = await search('BUDGET');
      expect(asked).toEqual(['BUDGET']);
      expect(found.docs.map((d) => [d.title, d.folder])).toEqual([['budget 2026.md', 'a/Budget stuff']]);
      expect(found.files.map((f) => f.filename)).toEqual(['budget.pdf']);
      expect(found.folders).toEqual([{ name: 'Budget stuff', path: 'a/Budget stuff' }]);
      expect(found.truncated).toBe(false);
      // A folder the index does not cover, or an index that fails, is walked.
      answer = () => null;
      expect((await search('unindexed')).docs.map((d) => d.title)).toEqual(['unindexed budget.md']);
      // The end of a path: the index is asked for the name, and its answer held to the path.
      answer = (root) => ['a/Budget stuff/budget 2026.md', 'budget.pdf'].map((p) => path.join(root, p));
      asked.length = 0;
      const byPath = await search(encodeURIComponent('stuff/budget'));
      expect(asked).toEqual(['budget']);
      expect(byPath.docs.map((d) => d.title)).toEqual(['budget 2026.md']);
      expect(byPath.files).toEqual([]);
      answer = () => {
        throw new Error('mdfind failed');
      };
      expect((await search('2026')).docs.map((d) => d.title)).toEqual(['budget 2026.md']);
    } finally {
      await indexed.close();
      rmSync(dir, { recursive: true, force: true });
      rmSync(data, { recursive: true, force: true });
    }
  });

  it('finds files elsewhere in the home folder by name or the end of their path, outside the open folder', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'sheetsweb-home-'));
    const data = mkdtempSync(path.join(tmpdir(), 'sheetsweb-localdata-'));
    const inHome = (...parts: string[]) => path.join(home, ...parts);
    for (const d of [['src', 'btdash'], ['src', 'site'], ['Downloads'], ['Library', 'Caches'], ['open']]) mkdirSync(inHome(...d), { recursive: true });
    for (const f of [['src', 'btdash', 'docker-compose.yaml'], ['src', 'site', 'docker-compose.yaml'], ['Downloads', 'docker-compose.yaml'], ['Library', 'Caches', 'docker-compose.yaml'], ['open', 'docker-compose.yaml']]) writeFileSync(inHome(...f), 'x');
    const realHome = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = process.env.USERPROFILE = home; // os.homedir(), USERPROFILE on Windows
    const app = await buildApp({ dataDir: data, local: { dir: inHome('open'), recents: null, findByName: null } });
    const search = async (q: string) => (await app.inject({ method: 'GET', url: `/api/local/search?q=${encodeURIComponent(q)}` })).json() as { files: { path: string; name: string; where: string; kind: string }[] };
    const where = (f: { where: string }) => f.where.replace(/\\/g, '/');
    try {
      // The open folder's own file is the library search's; the system's Library is left out.
      expect((await search('docker-compose')).files.map(where).sort()).toEqual(['~/Downloads', '~/src/btdash', '~/src/site']);
      const one = (await search('btdash/docker-compose.yaml')).files;
      expect(one.map((f) => [f.path, f.name, where(f), f.kind])).toEqual([[inHome('src', 'btdash', 'docker-compose.yaml'), 'docker-compose.yaml', '~/src/btdash', 'file']]);
    } finally {
      await app.close();
      for (const [k, v] of Object.entries(realHome)) if (v === undefined) delete process.env[k];
      else process.env[k] = v;
      rmSync(home, { recursive: true, force: true });
      rmSync(data, { recursive: true, force: true });
    }
  });

  it('keeps favorites by their paths: in the open folder, named as its list names them, and anywhere else', async () => {
    const outside = mkdtempSync(path.join(tmpdir(), 'sheetsweb-favorite-'));
    try {
      const notes = (await library()).docs.find((d) => d.title === 'notes.md')!;
      expect((await call('POST', '/api/favorites', { kind: 'markdown', id: notes.id, on: true })).status).toBe(200);
      expect((await call('POST', '/api/favorites', { folder: 'reports', on: true })).status).toBe(200);
      expect((await call('POST', '/api/favorites', { path: outside, on: true })).status).toBe(200);
      type Favs = { files: { path: string; name: string; kind: string }[]; folders: { name: string; path: string }[]; keys: string[] };
      let favs = (await call<Favs>('GET', '/api/favorites')).body;
      expect(favs.files.map((f) => [f.path, f.name, f.kind])).toEqual([[at('notes.md'), 'notes.md', 'markdown']]);
      expect(favs.folders.map((f) => f.path)).toEqual([path.resolve(outside), at('reports')]);
      // The ones in the open folder are named as its list names them; the one outside it is not in it.
      expect(favs.keys.sort()).toEqual(['folder:reports', `markdown:${notes.id}`]);
      // A folder that is gone is not listed, but can still be taken off.
      rmSync(outside, { recursive: true, force: true });
      expect((await call<Favs>('GET', '/api/favorites')).body.folders.map((f) => f.path)).toEqual([at('reports')]);
      expect((await call('POST', '/api/favorites', { path: outside, on: false })).status).toBe(200);
      for (const what of [{ path: at('notes.md') }, { folder: 'reports' }]) await call('POST', '/api/favorites', { ...what, on: false });
      favs = (await call<Favs>('GET', '/api/favorites')).body;
      expect(favs).toEqual({ files: [], folders: [], keys: [] });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it('notices files added and removed outside the app', async () => {
    writeFileSync(at('fresh.md'), 'new');
    rmSync(at('-..-escape.md'));
    const titles = (await library()).docs.map((d) => d.title);
    expect(titles).toContain('fresh.md');
    expect(titles).not.toContain('-..-escape.md');
  });

  it('serves and stores other files in the folder', async () => {
    const pdf = (await library()).files.find((f) => f.filename === 'scan.pdf')!;
    const res = await app.inject({ method: 'GET', url: pdf.url });
    expect(res.body).toBe('%PDF-1.4 test');
    const up = await app.inject({ method: 'POST', url: '/api/files', headers: { 'content-type': 'application/pdf', 'x-filename': 'scan.pdf' }, payload: Buffer.from('%PDF-1.4 other') });
    expect((up.json() as { file: StoredFile }).file.filename).toBe('scan 2.pdf');
    expect(readFileSync(at('scan 2.pdf'), 'utf8')).toBe('%PDF-1.4 other');
  });

  it('finds a file by its path for a Markdown preview, even one not listed yet', async () => {
    mkdirSync(at('docs', 'images'), { recursive: true });
    writeFileSync(at('docs', 'images', 'shot.png'), 'png bytes');
    const res = await app.inject({ method: 'GET', url: '/api/files/at?folder=docs/images&name=shot.png' });
    expect(res.statusCode).toBe(302);
    expect((await app.inject({ method: 'GET', url: res.headers.location as string })).body).toBe('png bytes');
    expect((await app.inject({ method: 'GET', url: '/api/files/at?folder=docs&name=shot.png' })).statusCode).toBe(404);
  });

  it('opens an Excel file as a spreadsheet and saves it as one, keeping the original the first time', async () => {
    const book = new ExcelJS.Workbook();
    const ws = book.addWorksheet('Budget');
    ws.getCell('A1').value = 'Item';
    ws.getCell('A2').value = 'Rent';
    ws.getCell('B2').value = 1200;
    ws.getCell('B3').value = { formula: 'SUM(B2:B2)', result: 1200 };
    ws.getCell('A1').border = { bottom: { style: 'thin' } };
    ws.getCell('B2').note = 'Monthly';
    writeFileSync(at('budget.xlsx'), Buffer.from(await book.xlsx.writeBuffer()));

    const top = await library();
    const meta = top.docs.find((d) => d.title === 'budget.xlsx')!;
    expect([meta.kind, meta.format]).toEqual(['sheet', 'xlsx']);
    expect(top.files.some((f) => f.filename === 'budget.xlsx')).toBe(false);
    type Loaded = { sheet: SheetMeta; workbook: Workbook; notKept?: string[] };
    const loaded = (await call<Loaded>('GET', `/api/sheets/${meta.id}`)).body;
    expect(loaded.workbook.tabs[0].cells.B2.v).toBe('1200');
    // What saving would remove is said before anything is saved.
    expect(loaded.notKept?.sort()).toEqual(['Cell borders', 'Comments']);

    const trash = () => (existsSync(path.join(dataDir, 'trash')) ? readdirSync(path.join(dataDir, 'trash')) : []);
    const before = trash();
    loaded.workbook.tabs[0].cells.B2 = { v: '1300' };
    expect((await call('PUT', `/api/sheets/${meta.id}`, { workbook: loaded.workbook, rev: loaded.sheet.updatedAt })).status).toBe(200);
    const saved = (await importXlsx(readFileSync(at('budget.xlsx')))).workbook.tabs[0];
    expect([saved.name, saved.cells.B2.v, saved.cells.B3.v]).toEqual(['Budget', '1300', '=SUM(B2:B2)']);
    // The file as it was is in the trash, once.
    const kept = trash().filter((f) => !before.includes(f));
    expect(kept).toHaveLength(1);
    expect((await importXlsx(readFileSync(path.join(dataDir, 'trash', kept[0])))).workbook.tabs[0].cells.B2.v).toBe('1200');

    // The app's own writing lost nothing, so nothing is said when it opens again, and no other copy is kept.
    const again = (await call<Loaded>('GET', `/api/sheets/${meta.id}`)).body;
    expect(again.notKept).toBeUndefined();
    again.workbook.tabs[0].cells.B2 = { v: '1400' };
    await call('PUT', `/api/sheets/${meta.id}`, { workbook: again.workbook, rev: again.sheet.updatedAt });
    expect(trash().filter((f) => !before.includes(f))).toHaveLength(1);
  });

  it('makes new spreadsheets Excel files, and one with a picture in a cell a spreadsheet of its own', async () => {
    const created = (await call<{ sheet: SheetMeta }>('POST', '/api/sheets', { title: 'Plan' })).body.sheet;
    expect(created.format).toBe('xlsx');
    expect(existsSync(at('Plan.xlsx'))).toBe(true);
    const { workbook } = (await call<{ workbook: Workbook }>('GET', `/api/sheets/${created.id}`)).body;
    workbook.tabs[0].cells.A1 = { v: '', img: 'https://example.com/logo.png' };
    const saved = (await call<{ sheet: SheetMeta }>('PUT', `/api/sheets/${created.id}`, { workbook })).body.sheet;
    expect(saved.format).toBeUndefined();
    expect(existsSync(at('Plan.xlsx'))).toBe(false);
    expect((JSON.parse(readFileSync(at('Plan.ffsheet'), 'utf8')) as Workbook).tabs[0].cells.A1.img).toBe('https://example.com/logo.png');
  });

  it('opens a PowerPoint file as a presentation and saves it as one, storing its pictures once', async () => {
    const { default: PptxGen } = await import('pptxgenjs');
    const pres = new PptxGen();
    pres.layout = 'LAYOUT_16x9';
    const slide = pres.addSlide();
    slide.addText('Quarterly review', { x: 1, y: 1, w: 8, h: 1, fontSize: 32 });
    // A 1×1 PNG.
    slide.addImage({ data: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', x: 1, y: 2.5, w: 1, h: 1 });
    slide.addChart(pres.ChartType.bar, [{ name: 'Sales', labels: ['Q1', 'Q2'], values: [1, 2] }], { x: 4, y: 2.5, w: 4, h: 2 });
    writeFileSync(at('review.pptx'), (await pres.write({ outputType: 'nodebuffer' })) as Buffer);

    const meta = (await library()).docs.find((d) => d.title === 'review.pptx')!;
    expect([meta.kind, meta.format]).toEqual(['deck', 'pptx']);
    type Loaded = { meta: SheetMeta; deck: Deck; notKept?: string[] };
    const loaded = (await call<Loaded>('GET', `/api/decks/${meta.id}`)).body;
    // The chart comes in as a chart, with the data the file keeps for it: nothing is lost by saving.
    expect(loaded.notKept).toBeUndefined();
    const chart = loaded.deck.slides[0].elements.find((e) => e.type === 'chart');
    expect(chart).toMatchObject({ type: 'chart', chart: { type: 'column' }, data: { categories: ['Q1', 'Q2'], series: [{ name: 'Sales', points: [{ y: 1 }, { y: 2 }] }] } });
    const picture = loaded.deck.slides[0].elements.find((e) => e.type === 'image');
    expect(picture && 'src' in picture && picture.src).toMatch(/^\/api\/images\//);
    // Opening it again stores no picture again.
    const images = () => readdirSync(path.join(dataDir, 'images')).length;
    const stored = images();
    await call('GET', `/api/decks/${meta.id}`);
    expect(images()).toBe(stored);

    const text = loaded.deck.slides[0].elements.find((e): e is TextElement => e.type === 'text')!;
    text.paragraphs = [{ text: 'Annual review' }];
    expect((await call('PUT', `/api/decks/${meta.id}`, { deck: loaded.deck, rev: loaded.meta.updatedAt })).status).toBe(200);
    const saved = (await importPptx(readFileSync(at('review.pptx')), async () => '/api/images/00000000-0000-0000-0000-000000000000')).deck;
    expect(saved.slides[0].elements.some((e) => e.type === 'text' && e.paragraphs.some((p) => p.text === 'Annual review'))).toBe(true);
    expect(saved.slides[0].elements.some((e) => e.type === 'image')).toBe(true);
    // The original, chart and all, was kept; opened again, the app's own file holds nothing it drops.
    expect(readdirSync(path.join(dataDir, 'trash')).some((f) => f.endsWith(' review.pptx'))).toBe(true);
    expect((await call<Loaded>('GET', `/api/decks/${meta.id}`)).body.notKept).toBeUndefined();
  });

  it('makes new presentations PowerPoint files, unless they have what PowerPoint files only approximate', async () => {
    const plain = (await call<{ deck: SheetMeta }>('POST', '/api/decks', { title: 'Pitch' })).body.deck;
    expect(plain.format).toBe('pptx');
    expect(existsSync(at('Pitch.pptx'))).toBe(true);
    const deck: Deck = { version: 1, theme: 'light', slides: [{ id: newId(), bg: 'linear-gradient(90deg, #ff0000, #0000ff)', elements: [] }] };
    const fancy = (await call<{ deck: SheetMeta }>('POST', '/api/decks', { title: 'Fancy', deck })).body.deck;
    expect(fancy.format).toBeUndefined();
    expect(existsSync(at('Fancy.ffslides'))).toBe(true);
  });

  it('opens a Word file as a document and saves it as one, saying first what it would remove', async () => {
    // A file made elsewhere: the app's own writing, with a table added, which the import flattens.
    const zip = await JSZip.loadAsync(await docDocx(markdownToDoc('Dear team,\n\nSee below.'), 'letter', async () => null));
    const xml = await zip.file('word/document.xml')!.async('string');
    const table = '<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Cell</w:t></w:r></w:p></w:tc></w:tr></w:tbl>';
    zip.file('word/document.xml', xml.replace('<w:sectPr', `${table}<w:sectPr`));
    writeFileSync(at('letter.docx'), await zip.generateAsync({ type: 'nodebuffer' }));

    const meta = (await library()).docs.find((d) => d.title === 'letter.docx')!;
    expect([meta.kind, meta.format]).toEqual(['doc', 'docx']);
    type Loaded = { meta: SheetMeta; doc: Doc; notKept?: string[] };
    const loaded = (await call<Loaded>('GET', `/api/docs/${meta.id}`)).body;
    expect(loaded.notKept).toEqual([expect.stringMatching(/^Tables were converted/)]);

    const edited = markdownToDoc('Dear all,\n\nSee below.');
    expect((await call('PUT', `/api/docs/${meta.id}`, { doc: edited, rev: loaded.meta.updatedAt })).status).toBe(200);
    const saved = (await importDocx(readFileSync(at('letter.docx')), async () => '/api/images/00000000-0000-0000-0000-000000000000')).doc;
    expect(docText(docNode(saved))).toContain('Dear all,');
    expect((await call<Loaded>('GET', `/api/docs/${meta.id}`)).body.notKept).toBeUndefined();
  });

  it('makes new documents Word files, and one with a video a document of its own', async () => {
    const plain = (await call<{ doc: SheetMeta }>('POST', '/api/docs', { title: 'Memo' })).body.doc;
    expect(plain.format).toBe('docx');
    expect(existsSync(at('Memo.docx'))).toBe(true);
    const video = (await call<{ doc: SheetMeta }>('POST', '/api/docs', { title: 'Demo', doc: markdownToDoc('![Demo](https://www.youtube.com/watch?v=dQw4w9WgXcQ)') })).body.doc;
    expect(video.format).toBeUndefined();
    expect(existsSync(at('Demo.ffdoc'))).toBe(true);
  });

  it('renames a stored file on disk, keeping its extension and never taking a name in use', async () => {
    writeFileSync(at('photo.png'), 'png');
    writeFileSync(at('taken.png'), 'other');
    const photo = (await library()).files.find((f) => f.filename === 'photo.png')!;
    const rename = async (name: string) => (await call<{ file: StoredFile }>('PATCH', `/api/files/${photo.id}`, { name })).body.file.filename;
    expect(await rename('Team offsite')).toBe('Team offsite.png');
    expect(existsSync(at('photo.png'))).toBe(false);
    expect(readFileSync(at('Team offsite.png'), 'utf8')).toBe('png');
    expect(await rename('taken.PNG')).toBe('taken 2.png');
    expect(readFileSync(at('taken.png'), 'utf8')).toBe('other');
    expect((await library()).files.filter((f) => f.id === photo.id).map((f) => f.filename)).toEqual(['taken 2.png']);
  });
});

describe('a folder opened before it had folders', () => {
  it('puts each file listed at the top with its whole path back in its own folder', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sheetsweb-folder-'));
    const data = mkdtempSync(path.join(tmpdir(), 'sheetsweb-localdata-'));
    mkdirSync(path.join(dir, 'vault', 'people'), { recursive: true });
    writeFileSync(path.join(dir, 'vault', 'people', 'Kate.md'), '# Kate\n');
    writeFileSync(path.join(dir, 'top.md'), '# Top\n');
    let first = await buildApp({ dataDir: data, local: { dir } });
    const id = ((await first.inject({ method: 'GET', url: '/api/library?folder=vault/people' })).json() as Library).docs[0].id;
    await first.close();
    // How such a folder's rows were left: at the top, named by their path.
    const db = new DatabaseSync(path.join(data, 'app.db'));
    db.prepare("UPDATE sheets SET folder = '', title = 'vault/people/Kate' WHERE id = ?").run(id);
    db.close();
    first = await buildApp({ dataDir: data, local: { dir } });
    try {
      const top = (await first.inject({ method: 'GET', url: '/api/library' })).json() as Library;
      expect(top.docs.map((d) => d.title)).toEqual(['top.md']);
      const people = (await first.inject({ method: 'GET', url: '/api/library?folder=vault/people' })).json() as Library;
      expect(people.docs.map((d) => [d.id, d.title])).toEqual([[id, 'Kate.md']]);
    } finally {
      await first.close();
      rmSync(dir, { recursive: true, force: true });
      rmSync(data, { recursive: true, force: true });
    }
  });
});

describe('the desktop token', () => {
  it('keeps out requests that do not carry it', async () => {
    const data = mkdtempSync(path.join(tmpdir(), 'sheetsweb-localdata-'));
    const guarded = await buildApp({ dataDir: data, local: { dir: folder, token: 'secret' } });
    try {
      expect((await guarded.inject({ method: 'GET', url: '/api/markdown' })).statusCode).toBe(401);
      expect((await guarded.inject({ method: 'GET', url: '/api/markdown', cookies: { [LOCAL_COOKIE]: 'wrong' } })).statusCode).toBe(401);
      expect((await guarded.inject({ method: 'GET', url: '/api/markdown', cookies: { [LOCAL_COOKIE]: 'secret' } })).statusCode).toBe(200);
    } finally {
      await guarded.close();
      rmSync(data, { recursive: true, force: true });
    }
  });
});

describe("changes to the app's own code", () => {
  it('are not available in the desktop app', async () => {
    const spec = { title: 'Add a tool', spec: 'A tool that sets the filter criteria of a column.' };
    expect((await call<{ error: string }>('POST', '/api/agent/jobs', spec)).body.error).toMatch(/not available in the desktop app/);
  });
});

describe('recents: the files last opened on the machine', () => {
  it('reads the files and their dates from Spotlight, newest first, and keeps the ones to list', () => {
    const out = [
      '/Users/me/Downloads/b report.pdf   kMDItemLastUsedDate = 2026-10-13 21:04:18 +0000',
      '/Users/me/Documents/a.md   kMDItemLastUsedDate = 2026-10-14 02:00:00 +0200',
      '/Users/me/Applications/Thing.app   kMDItemLastUsedDate = (null)',
      'garbage',
      '',
      '/Users/me/Downloads/new.xlsx   kMDItemDateAdded = 2026-10-15 09:00:00 +0000',
      '/Users/me/Downloads/b report.pdf   kMDItemDateAdded = 2026-10-01 08:00:00 +0000',
    ].join('\n');
    expect(parseRecents(out)).toEqual([
      { path: '/Users/me/Downloads/new.xlsx', lastUsed: '2026-10-15T09:00:00.000Z' },
      { path: '/Users/me/Documents/a.md', lastUsed: '2026-10-14T00:00:00.000Z' },
      { path: '/Users/me/Downloads/b report.pdf', lastUsed: '2026-10-13T21:04:18.000Z' },
    ]);
    const exts = new Set(['.md', '.pdf']);
    expect(listable('/Users/me/Documents/a.md', exts, '/Users/me')).toBe(true);
    expect(listable('/Volumes/Disk/a.PDF', exts, '/Users/me')).toBe(true);
    expect(listable('/Users/me/Documents/a.txt', exts, '/Users/me')).toBe(false);
    expect(listable('/Users/me/Library/Caches/a.md', exts, '/Users/me')).toBe(false);
    expect(listable('/Users/me/.config/a.md', exts, '/Users/me')).toBe(false);
    expect(listable('/Users/me/src/app/node_modules/pkg/README.md', exts, '/Users/me')).toBe(false);
    expect(listable('a.md', exts, '/Users/me')).toBe(false);
  });

  it('lists them, opens one in the folder by its path there, and hands one outside it to the app', async () => {
    const elsewhere = mkdtempSync(path.join(tmpdir(), 'sheetsweb-elsewhere-'));
    const data = mkdtempSync(path.join(tmpdir(), 'sheetsweb-localdata-'));
    writeFileSync(path.join(elsewhere, 'plan.md'), '# Plan\n');
    mkdirSync(at('recent'), { recursive: true });
    writeFileSync(at('recent', 'costs.csv'), 'a,b\n1,2\n');
    writeFileSync(at('recent', 'paper.pdf'), '%PDF-1.4 test');
    writeFileSync(path.join(elsewhere, 'tool.py'), 'print(1)');
    const spotlight = async () =>
      [
        `${at('recent', 'costs.csv')}   kMDItemLastUsedDate = 2026-10-13 10:00:00 +0000`,
        `${path.join(elsewhere, 'plan.md')}   kMDItemLastUsedDate = 2026-10-13 12:00:00 +0000`,
        `${path.join(elsewhere, 'tool.py')}   kMDItemLastUsedDate = 2026-10-13 13:00:00 +0000`,
        `${path.join(elsewhere, 'gone.pdf')}   kMDItemLastUsedDate = 2026-10-13 14:00:00 +0000`,
      ].join('\n');
    const asked: string[] = [];
    const recent = await buildApp({ dataDir: data, local: { dir: folder, openFile: (f) => asked.push(f), recents: () => recentFiles(LISTED_EXTS, spotlight, elsewhere) } });
    const req = async <T>(method: 'GET' | 'POST', url: string, payload?: object) => {
      const res = await recent.inject({ method, url, payload });
      return { status: res.statusCode, body: res.json() as T };
    };
    try {
      const list = await req<{ files: { path: string; name: string; kind: string; lastUsed: string }[]; blocked: string[] }>('GET', '/api/recents/system');
      expect(list.body.blocked).toEqual([]);
      // Newest first; what the app cannot show and what is gone are left out.
      expect(list.body.files.map((f) => [f.name, f.kind])).toEqual([
        ['plan.md', 'markdown'],
        ['costs.csv', 'sheet'],
      ]);

      // In the open folder: its path there, which resolves to the library's file.
      const here = await req<{ file?: string; switching?: boolean }>('POST', '/api/local/open', { path: at('recent', 'costs.csv') });
      expect(here.body).toEqual({ file: 'recent/costs.csv' });
      const found = await req<{ kind: string; id: string }>('GET', `/api/local/resolve?file=${encodeURIComponent('recent/costs.csv')}`);
      expect(found.body.kind).toBe('sheet');
      expect((await recent.inject({ method: 'GET', url: `/api/sheets/${found.body.id}` })).statusCode).toBe(200);
      const pdf = await req<{ kind: string; id: string }>('GET', `/api/local/resolve?file=${encodeURIComponent('recent/paper.pdf')}`);
      expect(pdf.body.kind).toBe('file');
      expect((await recent.inject({ method: 'GET', url: `/api/files/${pdf.body.id}` })).statusCode).toBe(200);
      expect(asked).toEqual([]);

      // Outside it: the app is asked to open the file's folder.
      const out = await req<{ switching?: boolean }>('POST', '/api/local/open', { path: path.join(elsewhere, 'plan.md') });
      expect(out.body).toEqual({ switching: true });
      expect(asked).toEqual([path.join(elsewhere, 'plan.md')]);

      // Not a file the app shows, not there, not a path inside the folder.
      expect((await req('POST', '/api/local/open', { path: path.join(elsewhere, 'tool.py') })).status).toBe(400);
      expect((await req('POST', '/api/local/open', { path: path.join(elsewhere, 'gone.pdf') })).status).toBe(404);
      expect((await req('POST', '/api/local/open', { path: 'plan.md' })).status).toBe(400);
      expect((await req('GET', `/api/local/resolve?file=${encodeURIComponent('../plan.md')}`)).status).toBe(404);
      expect((await req('GET', `/api/local/resolve?file=${encodeURIComponent('.git/hidden.md')}`)).status).toBe(200);
      expect((await req('GET', '/api/local/resolve?file=nope.md')).status).toBe(404);
      expect(asked).toHaveLength(1);
    } finally {
      await recent.close();
      rmSync(data, { recursive: true, force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('opens a file or folder by its path: here when it is in the folder, else by the app', async () => {
    const elsewhere = mkdtempSync(path.join(tmpdir(), 'sheetsweb-elsewhere-'));
    const data = mkdtempSync(path.join(tmpdir(), 'sheetsweb-localdata-'));
    writeFileSync(path.join(elsewhere, 'plan.md'), '# Plan\n');
    writeFileSync(path.join(elsewhere, 'tool.py'), 'print(1)');
    mkdirSync(at('bypath', 'inner'), { recursive: true });
    writeFileSync(at('bypath', 'notes.md'), '# Notes\n');
    const files: [string, boolean | undefined][] = [];
    const dirs: string[] = [];
    const inTabs: string[] = [];
    const chosen: (boolean | undefined)[] = [];
    let agents = [{ id: 'c1', name: 'Claude Code (mcp-docs)', approved: '2026-10-01T00:00:00.000Z' }];
    const app = await buildApp({
      dataDir: data,
      local: { dir: folder, recents: null, openFile: (f, r) => files.push([f, r]), openFileInTab: (f) => inTabs.push(f), openFolder: (d, t) => dirs.push(t ? `tab:${d}` : d), chooseFolder: (t) => chosen.push(t),
        agents: { list: async () => ({ url: 'http://127.0.0.1:39217/mcp', running: true, agents }), disconnect: async (id) => agents.length !== (agents = agents.filter((a) => a.id !== id)).length },
      },
    });
    const open = async (p: unknown, tab?: boolean) => {
      const res = await app.inject({ method: 'POST', url: '/api/local/open-path', payload: { path: p, ...(tab ? { tab } : {}) } });
      return { status: res.statusCode, body: res.json() as { file?: string; folder?: string; switching?: true; opened?: true } };
    };
    try {
      // In the open folder, absolute or relative to it.
      expect((await open(at('bypath', 'notes.md'))).body).toEqual({ file: 'bypath/notes.md' });
      expect((await open('bypath/inner/')).body).toEqual({ folder: 'bypath/inner' });
      expect((await open(folder)).body).toEqual({ folder: '' });
      expect(files).toEqual([]);
      expect(dirs).toEqual([]);

      // Outside it: the app opens the folder, or the file's own folder (not from Recents).
      expect((await open(path.join(elsewhere, 'plan.md'))).body).toEqual({ switching: true });
      expect(files).toEqual([[path.join(elsewhere, 'plan.md'), false]]);
      expect((await open(`  ${elsewhere}  `)).body).toEqual({ switching: true });
      expect(dirs).toEqual([elsewhere]);

      // Any file, hidden ones too: a script outside it opens in its folder, a hidden file in it is shown here.
      expect((await open(path.join(elsewhere, 'tool.py'))).body).toEqual({ switching: true });
      writeFileSync(at('bypath', '.env'), 'KEY=1\n');
      expect((await open('bypath/.env')).body).toEqual({ file: 'bypath/.env' });

      // In a new tab (an editor's File menu): one inside is named for the page to open, one outside opens in a tab.
      expect((await open('bypath/notes.md', true)).body).toEqual({ file: 'bypath/notes.md' });
      expect((await open('bypath/inner', true)).body).toEqual({ folder: 'bypath/inner' });
      expect((await open(path.join(elsewhere, 'plan.md'), true)).body).toEqual({ opened: true });
      expect(inTabs).toEqual([path.join(elsewhere, 'plan.md')]);
      expect((await open(elsewhere, true)).body).toEqual({ opened: true });
      expect(dirs).toEqual([elsewhere, `tab:${elsewhere}`]);
      expect(files).toHaveLength(2);

      // Not there, nothing given.
      expect((await open(path.join(elsewhere, 'gone.md'))).status).toBe(404);
      expect((await open('  ')).status).toBe(400);

      // The folder menu's folders: the usual ones in the home folder.
      const { places } = (await app.inject({ method: 'GET', url: '/api/local/places' })).json() as { places: { name: string; path: string }[] };
      expect(places[0]).toEqual({ name: 'HOME', path: homedir() });
      expect(places.slice(1).every((p) => path.dirname(p.path) === homedir())).toBe(true);

      expect((await app.inject({ method: 'POST', url: '/api/local/choose-folder' })).statusCode).toBe(200);
      expect((await app.inject({ method: 'POST', url: '/api/local/choose-folder', payload: { tab: true } })).statusCode).toBe(200);
      expect(chosen).toEqual([false, true]);
      // Settings shows the agents connected to the app's own MCP server, at its address, and disconnects one.
      expect((await app.inject({ method: 'GET', url: '/api/settings/agents' })).json()).toEqual({
        enabled: true,
        local: true,
        running: true,
        mcpUrl: 'http://127.0.0.1:39217/mcp',
        agents: [{ id: 'c1', name: 'Claude Code (mcp-docs)', origin: 'This computer', endpoint: 'http://127.0.0.1:39217/mcp', connectedAt: '2026-10-01T00:00:00.000Z' }],
      });
      expect((await app.inject({ method: 'DELETE', url: '/api/settings/agents/c1' })).statusCode).toBe(200);
      expect((await app.inject({ method: 'DELETE', url: '/api/settings/agents/c1' })).statusCode).toBe(404);
      expect(agents).toEqual([]);
    } finally {
      await app.close();
      rmSync(data, { recursive: true, force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('asks the app whether new files open, and tells it the files it writes', async () => {
    const data = mkdtempSync(path.join(tmpdir(), 'sheetsweb-localdata-'));
    let open = true;
    let kinds = ['pdf'];
    const now = () => ({ open, folders: ['/Users/me/Downloads'], kinds: [{ id: 'pdf', label: 'PDFs', on: kinds.includes('pdf') }] });
    const newFiles = { get: async () => now(), set: async (u: { open?: boolean; kinds?: string[] }) => ((open = u.open ?? open), (kinds = u.kinds ?? kinds), now()) };
    const local = await buildApp({ dataDir: data, local: { dir: folder, recents: null, newFiles } });
    const written: string[] = [];
    onOwnWrite((file) => written.push(file));
    try {
      expect((await local.inject({ method: 'GET', url: '/api/settings/new-files' })).json()).toEqual(now());
      expect((await local.inject({ method: 'PUT', url: '/api/settings/new-files', payload: { open: 'no' } })).statusCode).toBe(400);
      expect((await local.inject({ method: 'PUT', url: '/api/settings/new-files', payload: { kinds: 'pdf' } })).statusCode).toBe(400);
      expect((await local.inject({ method: 'PUT', url: '/api/settings/new-files', payload: { open: false } })).json()).toMatchObject({ open: false, kinds: [{ id: 'pdf', on: true }] });
      expect((await local.inject({ method: 'PUT', url: '/api/settings/new-files', payload: { kinds: [] } })).json()).toMatchObject({ open: false, kinds: [{ id: 'pdf', on: false }] });
      // Without the desktop app's main process (the web app, a server on its own) nothing watches.
      expect((await app.inject({ method: 'GET', url: '/api/settings/new-files' })).statusCode).toBe(404);
      const doc = (await local.inject({ method: 'POST', url: '/api/docs', payload: { title: 'Mine' } })).json() as { doc: SheetMeta };
      expect(written).toContain(at(doc.doc.title));
    } finally {
      onOwnWrite(null);
      await local.close();
      rmSync(data, { recursive: true, force: true });
    }
  });

  it('shows a file or folder in the file browser and drags a file out, only of the folder', async () => {
    const data = mkdtempSync(path.join(tmpdir(), 'sheetsweb-localdata-'));
    mkdirSync(at('shown'), { recursive: true });
    writeFileSync(at('shown', 'clip.mp4'), 'video');
    writeFileSync(at('shown', 'notes.md'), '# Notes\n');
    const revealed: string[] = [];
    const dragged: string[] = [];
    const app = await buildApp({ dataDir: data, local: { dir: folder, recents: null, reveal: (t) => revealed.push(t), startDrag: (f) => dragged.push(f) } });
    const post = async (url: string, payload: object) => (await app.inject({ method: 'POST', url, payload })).statusCode;
    try {
      const resolve = async (rel: string) => (await app.inject({ method: 'GET', url: `/api/local/resolve?file=${encodeURIComponent(rel)}` })).json() as { kind: string; id: string };
      const clip = await resolve('shown/clip.mp4');
      const notes = await resolve('shown/notes.md');
      expect(await post('/api/local/reveal', clip)).toBe(200);
      expect(await post('/api/local/reveal', { folder: 'shown' })).toBe(200);
      expect(await post('/api/local/reveal', {})).toBe(200);
      expect(revealed).toEqual([at('shown', 'clip.mp4'), at('shown'), folder]);
      expect(await post('/api/local/drag', notes)).toBe(200);
      expect(dragged).toEqual([at('shown', 'notes.md')]);
      // Only a file, of this folder.
      expect(await post('/api/local/drag', { folder: 'shown' })).toBe(400);
      expect(await post('/api/local/drag', { kind: 'file', id: 'nope' })).toBe(404);
      expect(await post('/api/local/reveal', { kind: 'other', id: clip.id })).toBe(404);
      expect(await post('/api/local/reveal', { folder: '../..' })).not.toBe(200);
      expect(revealed).toHaveLength(3);
    } finally {
      await app.close();
      rmSync(data, { recursive: true, force: true });
    }
  });

  it('names a new scratch pad for the day it was made', () => {
    const taken = new Set<string>();
    const day = new Date(2026, 8, 5);
    const next = () => {
      const n = scratchPadName((x) => taken.has(x), day);
      taken.add(n);
      return n;
    };
    expect([next(), next(), next()]).toEqual(['Scratch pad.md', 'Scratch pad-sep05.md', 'Scratch pad-sep05-2.md']);
  });

  it('lists scratch pads, makes a new one in ~/.config/mcp-docs and opens one by its name', async () => {
    const home = mkdtempSync(path.join(tmpdir(), 'sheetsweb-home-'));
    const data = mkdtempSync(path.join(tmpdir(), 'sheetsweb-localdata-'));
    const before = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    process.env.HOME = home;
    process.env.USERPROFILE = home; // the home folder on Windows
    const files: [string, string | undefined][] = [];
    const returned: [string, boolean | undefined, string | undefined][] = [];
    const app = await buildApp({ dataDir: data, local: { dir: folder, recents: null, openFile: (f, _r, back) => files.push([f, back]), openFolder: (d, t, f) => returned.push([d, t, f]) } });
    const dir = path.join(home, SCRATCH_DIR);
    const atPads = await buildApp({ dataDir: mkdtempSync(path.join(tmpdir(), 'sheetsweb-localdata-')), local: { dir, recents: null } });
    const list = async () => ((await app.inject({ method: 'GET', url: '/api/local/scratch-pads' })).json() as { pads: { name: string }[] }).pads.map((p) => p.name);
    const make = async (on = app, name?: string, at = '') => (await on.inject({ method: 'POST', url: '/api/local/scratch-pad', payload: name ? { name, folder: at } : { folder: at } })).json();
    try {
      // None yet, and no folder.
      expect(await list()).toEqual([]);
      // From another folder: made, folder and all, then the app opens it in its folder, leading back to the one shown.
      mkdirSync(at('Reports', '2026'), { recursive: true });
      expect(await make(app, undefined, 'Reports/2026')).toEqual({ switching: true });
      expect(files).toEqual([[path.join(dir, 'Scratch pad.md'), `?${new URLSearchParams({ backDir: folder, backFolder: 'Reports/2026' })}`]]);
      expect(readFileSync(path.join(dir, 'Scratch pad.md'), 'utf8')).toBe('');
      expect(await list()).toEqual(['Scratch pad.md']);

      // With its folder open: a new one is named for the day, and shown here.
      const second = (await make(atPads)) as { file: string };
      expect(second.file).toMatch(/^Scratch pad-[a-z]{3}\d{2}\.md$/);
      utimesSync(path.join(dir, second.file), new Date(), new Date(Date.now() + 60_000));
      expect(await list()).toEqual([second.file, 'Scratch pad.md']);

      // One by its name, as it was left.
      writeFileSync(path.join(dir, 'Scratch pad.md'), 'Call Sam\n');
      expect(await make(atPads, 'Scratch pad.md')).toEqual({ file: 'Scratch pad.md' });
      expect(readFileSync(path.join(dir, 'Scratch pad.md'), 'utf8')).toBe('Call Sam\n');
      expect((await app.inject({ method: 'POST', url: '/api/local/scratch-pad', payload: { name: '../notes.md' } })).statusCode).toBe(400);
      expect((await app.inject({ method: 'POST', url: '/api/local/scratch-pad', payload: { name: 'gone.md' } })).statusCode).toBe(404);

      // Back from a scratch pad: the window returns to the folder it came from, at the folder it showed.
      expect((await atPads.inject({ method: 'POST', url: '/api/local/return', payload: { dir: folder, at: 'Reports' } })).statusCode).toBe(400); // atPads cannot move windows
      expect((await app.inject({ method: 'POST', url: '/api/local/return', payload: { dir: folder, at: 'Reports' } })).json()).toEqual({ switching: true });
      expect(returned).toEqual([[folder, false, 'Reports']]);
      expect((await app.inject({ method: 'POST', url: '/api/local/return', payload: { dir: 'relative' } })).statusCode).toBe(400);
      expect((await app.inject({ method: 'POST', url: '/api/local/return', payload: { dir: path.join(home, 'gone') } })).statusCode).toBe(404);
    } finally {
      for (const [k, v] of Object.entries(before)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      await app.close();
      await atPads.close();
      rmSync(data, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('lists the files opened in the app at once, and the ones Spotlight knows when asked', async () => {
    const elsewhere = mkdtempSync(path.join(tmpdir(), 'sheetsweb-elsewhere-'));
    const data = mkdtempSync(path.join(tmpdir(), 'sheetsweb-localdata-'));
    mkdirSync(at('opened'), { recursive: true });
    writeFileSync(at('opened', 'notes.md'), '# Notes\n');
    writeFileSync(at('opened', 'scan.pdf'), '%PDF-1.4 test');
    writeFileSync(path.join(elsewhere, 'plan.md'), '# Plan\n');
    const spotlight = async () =>
      [`${path.join(elsewhere, 'plan.md')}   kMDItemLastUsedDate = 2099-01-01 00:00:00 +0000`, `${at('opened', 'notes.md')}   kMDItemLastUsedDate = 2099-01-01 00:00:00 +0000`].join('\n');
    const recent = await buildApp({ dataDir: data, local: { dir: folder, recents: () => recentFiles(LISTED_EXTS, spotlight, elsewhere) } });
    const req = async <T>(method: 'GET' | 'POST', url: string, payload?: object) => (await recent.inject({ method, url, payload })).json() as T;
    try {
      for (const rel of ['opened/notes.md', 'opened/scan.pdf']) {
        const { kind, id } = await req<{ kind: string; id: string }>('GET', `/api/local/resolve?file=${encodeURIComponent(rel)}`);
        await req('POST', '/api/recents', { kind, id });
      }
      // The app's own come at once; Spotlight's are asked for after, and the page leaves out the ones already listed.
      const mine = await req<{ files: { name: string; kind: string; app?: boolean }[]; system: boolean; cached?: unknown }>('GET', '/api/recents');
      expect(mine.system).toBe(true);
      expect(mine.cached).toBeUndefined();
      expect(mine.files.map((f) => [f.name, f.kind, !!f.app])).toEqual([
        ['scan.pdf', 'file', true],
        ['notes.md', 'markdown', true],
      ]);
      const system = await req<{ files: { name: string; app?: boolean }[] }>('GET', '/api/recents/system');
      expect(system.files.map((f) => [f.name, !!f.app])).toEqual([
        ['plan.md', false],
        ['notes.md', false],
      ]);
      // Its answer is kept, to be shown at once next time while Spotlight is asked again.
      const again = await req<{ cached?: { files: { name: string; kind: string }[]; blocked: string[] } }>('GET', '/api/recents');
      expect(again.cached?.files.map((f) => [f.name, f.kind])).toEqual([
        ['plan.md', 'markdown'],
        ['notes.md', 'markdown'],
      ]);
      expect(again.cached?.blocked).toEqual([]);
    } finally {
      await recent.close();
      rmSync(data, { recursive: true, force: true });
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it('keeps the last files opened in the app, and lists only the ones still there', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sheetsweb-opened-'));
    try {
      const db = new DatabaseSync(':memory:');
      db.exec('CREATE TABLE users (id TEXT PRIMARY KEY)');
      db.exec("INSERT INTO users VALUES ('local'), ('other')");
      const kept = new RecentOpens(db);
      const files = Array.from({ length: APP_RECENTS + 2 }, (_, i) => path.join(dir, `f${i}.md`));
      files.forEach((f, i) => (writeFileSync(f, ''), kept.record('local', f, new Date(Date.UTC(2026, 0, 1, 0, i)))));
      kept.record('other', files[0]);
      // Opened again: back to the top.
      kept.record('local', files[5], new Date(Date.UTC(2026, 1, 1)));
      rmSync(files[APP_RECENTS + 1]);
      const listed = (await openedFiles(kept.list('local'), new Set(['.md']), dir)).map((f) => path.basename(f.path));
      expect(listed[0]).toBe('f5.md');
      expect(listed).toHaveLength(APP_RECENTS - 1);
      expect(listed).not.toContain('f0.md');
      expect(listed).not.toContain('f1.md');
      // Each user has their own.
      expect(kept.list('other').map((r) => r.ref)).toEqual([files[0]]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lists only what the app opened without Spotlight', async () => {
    const data = mkdtempSync(path.join(tmpdir(), 'sheetsweb-localdata-'));
    const none = await buildApp({ dataDir: data, local: { dir: folder, recents: null } });
    try {
      expect((await none.inject({ method: 'GET', url: '/api/recents' })).json()).toEqual({ files: [], system: false });
      expect((await none.inject({ method: 'GET', url: '/api/recents/system' })).statusCode).toBe(404);
    } finally {
      await none.close();
      rmSync(data, { recursive: true, force: true });
    }
  });
});
