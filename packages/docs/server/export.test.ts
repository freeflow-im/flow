import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { markdownToDoc } from '../shared/docMarkdown.ts';
import { newWorkbook } from '../shared/types.ts';
import { buildApp } from './app.ts';
import { MemoryObjectStore } from './blob.ts';
import { docMarkdown, safeName, tabCsv, workbookXlsx } from './export.ts';
import { mailbox, signUp } from './testing.ts';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

describe('export converters', () => {
  it('writes a tab as CSV with displayed values', () => {
    const wb = newWorkbook('t1');
    const t = wb.tabs[0];
    t.cells.A1 = { v: 'Item' };
    t.cells.B1 = { v: 'Price, each' };
    t.cells.A2 = { v: 'Pen' };
    t.cells.B2 = { v: '1.5', st: { fmt: 'currency', dp: 2 } };
    t.cells.A3 = { v: 'Total' };
    t.cells.B3 = { v: '=SUM(B2:B2)*2' };
    expect(tabCsv(wb, t)).toBe('Item,"Price, each"\nPen,$1.50\nTotal,3');
  });

  it('writes an Excel workbook with formulas, styles and layout', async () => {
    const wb = newWorkbook('t1');
    const t = wb.tabs[0];
    t.name = 'Data';
    t.cells.A1 = { v: 'Qty', st: { b: true, bg: '#ffff00', align: 'center' } };
    t.cells.A2 = { v: '2' };
    t.cells.A3 = { v: '=A2*3', st: { fmt: 'number', dp: 1 } };
    t.cells.B1 = { v: "'007" };
    t.colWidths['0'] = 103;
    t.rowHeights['0'] = 42;
    t.frozenRows = 1;
    wb.tabs.push({ ...newWorkbook('t2').tabs[0], name: 'Data' });
    const book = new ExcelJS.Workbook();
    await book.xlsx.load((await workbookXlsx(wb, 'Book')) as unknown as ArrayBuffer);
    expect(book.worksheets.map((w) => w.name)).toEqual(['Data', 'Data 2']);
    const ws = book.worksheets[0];
    expect(ws.getCell('A1').value).toBe('Qty');
    expect(ws.getCell('A1').font?.bold).toBe(true);
    expect(ws.getCell('A1').fill).toMatchObject({ type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFFF00' } });
    expect(ws.getCell('A1').alignment?.horizontal).toBe('center');
    expect(ws.getCell('A2').value).toBe(2);
    expect(ws.getCell('A3').value).toMatchObject({ formula: 'A2*3', result: 6 });
    expect(ws.getCell('A3').numFmt).toBe('#,##0.0');
    expect(ws.getCell('B1').value).toBe('007');
    expect(ws.getColumn(1).width).toBe(14);
    expect(ws.getRow(1).height).toBeCloseTo(31.5);
    expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
  });

  it('writes a document as Markdown with image paths rewritten', () => {
    const doc = markdownToDoc('# Title {.title}\n\nHello **world**\n\n![A picture](/api/images/00000000-0000-0000-0000-000000000001)\n');
    const md = docMarkdown(doc, (src) => `../images/${src.slice(-36)}.png`);
    expect(md).toContain('Hello **world**');
    expect(md).toContain('![A picture](../images/00000000-0000-0000-0000-000000000001.png)');
    expect(docMarkdown(doc)).toContain('(/api/images/00000000-0000-0000-0000-000000000001)');
  });

  it('makes safe file names', () => {
    expect(safeName('Q3: plan / "final"?', 'md')).toBe('Q3- plan - -final-.md');
    expect(safeName('   ', 'json')).toBe('Untitled.json');
  });
});

describe('export routes', () => {
  let dir: string;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let cookie: string;
  const box = mailbox();
  const blob = new MemoryObjectStore();

  beforeAll(async () => {
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    dir = mkdtempSync(path.join(tmpdir(), 'export-test-'));
    app = await buildApp({ dataDir: dir, sendMail: box.send, appUrl: 'https://sheets.test', blob });
    cookie = (await signUp(app, box, 'export@x.com')).cookie;
  });

  afterAll(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('exports one file in each format and everything as a zip', async () => {
    let res = await app.inject({ method: 'POST', url: '/api/images', headers: { cookie, 'content-type': 'image/png' }, payload: PNG });
    const { url: img } = res.json() as { url: string };

    res = await app.inject({ method: 'POST', url: '/api/docs', headers: { cookie }, payload: { title: 'Notes/2026', doc: markdownToDoc(`Hello\n\n![pic](${img})\n`) } });
    const docId = (res.json() as { doc: { id: string } }).doc.id;
    res = await app.inject({ method: 'POST', url: '/api/decks', headers: { cookie }, payload: { title: 'Pitch' } });
    const deckId = (res.json() as { deck: { id: string } }).deck.id;
    res = await app.inject({ method: 'POST', url: '/api/sheets', headers: { cookie }, payload: { title: 'Budget' } });
    const sheetId = (res.json() as { sheet: { id: string } }).sheet.id;
    const wb = newWorkbook('t1');
    wb.tabs[0].cells.A1 = { v: '=1+1' };
    await app.inject({ method: 'PUT', url: `/api/sheets/${sheetId}`, headers: { cookie }, payload: { workbook: wb } });

    res = await app.inject({ method: 'GET', url: `/api/files/${docId}/export`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/markdown/);
    expect(res.headers['content-disposition']).toContain('filename="Notes-2026.md"');
    expect(res.body).toContain('Hello');

    res = await app.inject({ method: 'GET', url: `/api/files/${docId}/export?format=json`, headers: { cookie } });
    expect(JSON.parse(res.body)).toMatchObject({ version: 1 });

    res = await app.inject({ method: 'GET', url: `/api/files/${deckId}/export`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/presentationml/);
    expect(res.rawPayload.length).toBeGreaterThan(1000);

    res = await app.inject({ method: 'GET', url: `/api/files/${sheetId}/export?format=csv`, headers: { cookie } });
    expect(res.body).toBe('2');
    res = await app.inject({ method: 'GET', url: `/api/files/${sheetId}/export`, headers: { cookie } });
    expect(res.headers['content-type']).toMatch(/spreadsheetml/);

    res = await app.inject({ method: 'GET', url: `/api/files/${sheetId}/export?format=md`, headers: { cookie } });
    expect(res.statusCode).toBe(400);
    res = await app.inject({ method: 'GET', url: `/api/files/nope/export`, headers: { cookie } });
    expect(res.statusCode).toBe(404);
    res = await app.inject({ method: 'GET', url: `/api/files/${docId}/export` });
    expect(res.statusCode).toBe(401);

    res = await app.inject({ method: 'GET', url: '/api/export.zip', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    const zip = await JSZip.loadAsync(res.rawPayload);
    const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir).sort();
    expect(names).toEqual([
      'Documents/Notes-2026.json',
      'Documents/Notes-2026.md',
      'Presentations/Pitch.json',
      'Presentations/Pitch.pptx',
      'Spreadsheets/Budget.json',
      'Spreadsheets/Budget.xlsx',
      `images/${img.slice(-36)}.png`,
    ]);
    expect(await zip.file('Documents/Notes-2026.md')!.async('string')).toContain(`![pic](../images/${img.slice(-36)}.png)`);
    expect(await zip.file(`images/${img.slice(-36)}.png`)!.async('nodebuffer')).toEqual(PNG);

    // Another account sees none of it.
    const other = await signUp(app, box, 'other@x.com');
    res = await app.inject({ method: 'GET', url: `/api/files/${docId}/export`, headers: { cookie: other.cookie } });
    expect(res.statusCode).toBe(404);
    res = await app.inject({ method: 'GET', url: '/api/export.zip', headers: { cookie: other.cookie } });
    const empty = await JSZip.loadAsync(res.rawPayload);
    expect(Object.keys(empty.files).filter((n) => !empty.files[n].dir)).toEqual([]);
  });

  it('downloads a folder as a zip laid out like the folder', async () => {
    const post = (url: string, payload: object) => app.inject({ method: 'POST', url, headers: { cookie }, payload });
    await post('/api/folders', { name: 'Trip' });
    await post('/api/folders', { name: 'Receipts', folder: 'Trip' });
    await post('/api/folders', { name: 'Empty', folder: 'Trip' });
    const img = ((await app.inject({ method: 'POST', url: '/api/images', headers: { cookie, 'content-type': 'image/png' }, payload: PNG })).json() as { url: string }).url;
    await post('/api/docs', { title: 'Plan', doc: markdownToDoc(`Go\n\n![pic](${img})\n`), folder: 'Trip/Receipts' });
    await post('/api/markdown', { title: 'Notes', text: '# Hi\n', folder: 'Trip' });
    await post('/api/sheets', { title: 'Costs', csv: 'a,b\n1,2', folder: 'Trip' });
    await post('/api/sheets', { title: 'Budget', folder: 'Trip' });
    await post('/api/docs', { title: 'Elsewhere', doc: markdownToDoc('No\n') });
    const upload = (folder: string) => app.inject({ method: 'POST', url: `/api/files?folder=${encodeURIComponent(folder)}`, headers: { cookie, 'content-type': 'application/pdf', 'x-filename': 'Notes.md' }, payload: Buffer.from('raw') });
    expect((await upload('Trip')).statusCode).toBe(200);

    const res = await app.inject({ method: 'GET', url: '/api/folders/download?folder=Trip', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/zip');
    expect(res.headers['content-disposition']).toContain('filename="Trip.zip"');
    const zip = await JSZip.loadAsync(res.rawPayload);
    expect(Object.keys(zip.files).map((n) => n.replace(/\/$/, '')).sort()).toEqual(
      ['Budget.xlsx', 'Costs.csv', 'Empty', 'Notes (2).md', 'Notes.md', 'Receipts', 'Receipts/Plan.md', 'images', `images/${img.slice(-36)}.png`].sort(),
    );
    expect(await zip.file('Costs.csv')!.async('string')).toBe('a,b\n1,2\n');
    expect(await zip.file('Receipts/Plan.md')!.async('string')).toContain(`![pic](../images/${img.slice(-36)}.png)`);

    expect((await app.inject({ method: 'GET', url: '/api/folders/download?folder=Nope', headers: { cookie } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/folders/download?folder=Trip' })).statusCode).toBe(401);
    const other = await signUp(app, box, 'zip@x.com');
    expect((await app.inject({ method: 'GET', url: '/api/folders/download?folder=Trip', headers: { cookie: other.cookie } })).statusCode).toBe(404);
  });

  it('lists deleted files in the trash and restores them', async () => {
    let res = await app.inject({ method: 'POST', url: '/api/docs', headers: { cookie }, payload: { title: 'Keep me', doc: markdownToDoc('Precious\n') } });
    const id = (res.json() as { doc: { id: string } }).doc.id;
    res = await app.inject({ method: 'DELETE', url: `/api/docs/${id}`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 20));

    res = await app.inject({ method: 'GET', url: '/api/trash', headers: { cookie } });
    expect(res.json()).toMatchObject({ available: true, files: [{ id, kind: 'doc', title: 'Keep me' }] });

    res = await app.inject({ method: 'POST', url: `/api/trash/${id}/restore`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ file: { id, kind: 'doc', title: 'Keep me' } });
    res = await app.inject({ method: 'GET', url: `/api/docs/${id}`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(JSON.stringify(res.json())).toContain('Precious');
    res = await app.inject({ method: 'GET', url: '/api/trash', headers: { cookie } });
    expect((res.json() as { files: unknown[] }).files).toEqual([]);
    res = await app.inject({ method: 'POST', url: `/api/trash/${id}/restore`, headers: { cookie } });
    expect(res.statusCode).toBe(404);
  });

  it('copies every save to the object store', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/docs', headers: { cookie }, payload: { title: 'Backed up' } });
    const id = (res.json() as { doc: { id: string } }).doc.id;
    await new Promise((r) => setTimeout(r, 20));
    expect([...blob.objects.keys()].some((k) => k.includes(`/doc/${id}/`))).toBe(true);
  });
});
