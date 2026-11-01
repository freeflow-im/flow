import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb } from '../../server/db.ts';
import type { Workbook } from '../../shared/types.ts';
import { ConflictError, FileHub, type FileService } from './files.ts';

let dir: string;
let svc: FileService;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'docs-plugin-'));
  const db = openDb(path.join(dir, 'app.db'));
  db.prepare('INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)').run('u1', 'a@example.com', 'x', new Date().toISOString());
  const hub = new FileHub({ db, dataDir: dir, publicUrl: 'https://plugin.example.com' });
  await hub.init();
  svc = hub.forUser('u1');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('documents', () => {
  it('creates, lists and opens documents', async () => {
    const doc = await svc.createDoc('Plan', '# Plan {.title}\n\nFirst.\n');
    expect(svc.list('doc').map((d) => d.title)).toEqual(['Plan']);
    expect(svc.list(undefined, 'nothing')).toEqual([]);
    svc.setOpen({ kind: 'doc', id: doc.id });
    expect(svc.state().open).toMatchObject({ kind: 'doc', id: doc.id, title: 'Plan' });
    const outline = await svc.editDoc(doc.id, 'read_doc', {});
    expect(outline.block_count).toBe(2);
    expect((outline.blocks as { markdown: string }[])[1].markdown).toBe('First.');
  });

  it('edits headlessly with the app tools and saves a new revision', async () => {
    const doc = await svc.createDoc('Plan', 'One.\n\nTwo.\n');
    const before = (await svc.get('doc', doc.id)).rev;
    await tick();
    const r = await svc.editDoc(doc.id, 'insert_content', { markdown: 'Between **them**.', after: 1 });
    expect(r.inserted_blocks).toEqual([2]);
    expect(r.rev).not.toBe(before);
    const read = await svc.editDoc(doc.id, 'read_doc', {});
    expect((read.blocks as { markdown: string }[]).map((b) => b.markdown)).toEqual(['One.', 'Between **them**.', 'Two.']);
    expect(read.rev).toBe(r.rev);
  });

  it('reports the cursor the app told it about', async () => {
    const doc = await svc.createDoc('Plan', 'One.\n\nTwo.\n');
    svc.setOpen({ kind: 'doc', id: doc.id }, { cursor_block: 2, selected_text: 'Two' });
    const read = await svc.editDoc(doc.id, 'read_doc', {});
    expect(read.cursor_block).toBe(2);
    expect(read.selected_text).toBe('Two');
  });

  it('refuses a save with a stale revision', async () => {
    const doc = await svc.createDoc('Plan', 'One.\n');
    const { rev, data } = await svc.get('doc', doc.id);
    await tick();
    await svc.editDoc(doc.id, 'replace_text', { find: 'One', replace: 'Uno' });
    await expect(svc.save('doc', doc.id, data, rev)).rejects.toBeInstanceOf(ConflictError);
    const fresh = await svc.get('doc', doc.id);
    expect(await svc.save('doc', doc.id, fresh.data, fresh.rev)).toHaveProperty('rev');
  });

  it('rewrites image addresses for the iframe and back', async () => {
    const doc = await svc.createDoc('Pics');
    const image = { type: 'image', attrs: { src: '/api/images/0f4e2d8a-1b2c-4d3e-9f80-123456789abc', alt: '', width: null, align: null } };
    await svc.sheets.saveDoc('u1', doc.id, { version: 1, content: { type: 'doc', attrs: { page: null, style: null }, content: [image] } });
    const pub = await svc.get('doc', doc.id);
    expect(JSON.stringify(pub.data)).toContain('https://plugin.example.com/plugin/img/0f4e2d8a-1b2c-4d3e-9f80-123456789abc');
    await svc.save('doc', doc.id, pub.data, pub.rev);
    const stored = await svc.sheets.loadDoc('u1', doc.id);
    expect(JSON.stringify(stored!.doc)).toContain('"/api/images/0f4e2d8a-1b2c-4d3e-9f80-123456789abc"');
  });

  it('rejects tool errors the model should fix', async () => {
    const doc = await svc.createDoc('Plan', 'One.\n');
    await expect(svc.editDoc(doc.id, 'replace_blocks', { from: 5, markdown: 'x' })).rejects.toThrow(/no block 5/);
    await expect(svc.editDoc('nope', 'read_doc', {})).rejects.toThrow(/no document/);
  });
});

describe('presentations', () => {
  it('creates a deck from slide specs and lists both kinds together', async () => {
    await svc.createDoc('Notes');
    await tick();
    const deck = await svc.createDeck('Pitch', 'dark', [{ title: 'Pitch', subtitle: 'Q4' }, { title: 'Problem', body: ['Slow', 'Costly'] }]);
    expect(svc.list().map((f) => `${f.kind}:${f.title}`)).toEqual(['deck:Pitch', 'doc:Notes']);
    expect(svc.list('deck')).toHaveLength(1);
    const { data } = await svc.get('deck', deck.id);
    const d = data as { theme: string; slides: { layout: string }[] };
    expect(d.theme).toBe('dark');
    expect(d.slides.map((s) => s.layout)).toEqual(['title', 'title-body']);
  });

  it('edits a deck headlessly with the app tools, from the slide the user is on', async () => {
    const deck = await svc.createDeck('Pitch', undefined, [{ title: 'One' }, { title: 'Two' }]);
    svc.setOpen({ kind: 'deck', id: deck.id }, { slide: 2 });
    const outline = await svc.editDeck(deck.id, 'read_deck', {});
    expect(outline.slide_count).toBe(2);
    expect(outline.current_slide).toBe(2);
    const before = outline.rev;
    await tick();
    const added = await svc.editDeck(deck.id, 'add_slides', { slides: [{ layout: 'title-body', title: 'Three', body: ['a', 'b'] }] });
    expect(added.rev).not.toBe(before);
    const after = await svc.editDeck(deck.id, 'read_deck', {});
    expect(after.slide_count).toBe(3);
    const state = svc.state();
    expect(state.open?.rev).toBe(added.rev);
  });

  it('targets the open file only when it is of the right kind', async () => {
    const doc = await svc.createDoc('Notes');
    svc.setOpen({ kind: 'doc', id: doc.id });
    expect(svc.target('doc', undefined)).toBe(doc.id);
    expect(svc.target('deck', undefined)).toBeNull();
    expect(svc.target('deck', 'x')).toBe('x');
  });

  it('rewrites image elements for the iframe and back', async () => {
    const deck = await svc.createDeck('Pics');
    const loaded = await svc.sheets.loadDeck('u1', deck.id);
    const d = loaded!.deck;
    d.slides[0].elements.push({ id: 'img1', type: 'image', x: 10, y: 10, w: 100, h: 100, src: '/api/images/0f4e2d8a-1b2c-4d3e-9f80-123456789abc' } as (typeof d.slides)[0]['elements'][0]);
    await svc.sheets.saveDeck('u1', deck.id, d);
    const pub = await svc.get('deck', deck.id);
    expect(JSON.stringify(pub.data)).toContain('https://plugin.example.com/plugin/img/');
    await svc.save('deck', deck.id, pub.data, pub.rev);
    const stored = await svc.sheets.loadDeck('u1', deck.id);
    expect(JSON.stringify(stored!.deck)).toContain('"/api/images/0f4e2d8a-1b2c-4d3e-9f80-123456789abc"');
  });
});

describe('spreadsheets', () => {
  it('creates a spreadsheet, reads and writes it headlessly from the tab the user is on, and lists all kinds', async () => {
    await svc.createDoc('Notes');
    await tick();
    const sheet = await svc.createSheet('Budget');
    expect(svc.list().map((f) => `${f.kind}:${f.title}`)).toEqual(['sheet:Budget', 'doc:Notes']);
    const before = (await svc.get('sheet', sheet.id)).rev;
    await tick();
    const wrote = await svc.editSheet(sheet.id, 'write_range', { start: 'A1', rows: [['Item', 'Cost'], ['Rent', 1200], ['Food', 400], ['Total', '=SUM(B2:B3)']] });
    expect(wrote.rev).not.toBe(before);
    expect(svc.state().open).toBeNull();
    const read = await svc.editSheet(sheet.id, 'read_range', { range: 'A1:B4' });
    expect((read.values as unknown[][])[3]).toEqual(['Total', '1600']);
    expect(read.rev).toBe(wrote.rev);

    await svc.editSheet(sheet.id, 'add_tab', { name: 'Q2' });
    svc.setOpen({ kind: 'sheet', id: sheet.id }, { tab: 'Q2', selection: ['A1:B2'] });
    const onQ2 = await svc.editSheet(sheet.id, 'write_range', { start: 'A1', rows: [['on q2']] });
    expect(onQ2.wrote).toBe('Q2!A1');
    const overview = await svc.editSheet(sheet.id, 'get_sheet_overview', {});
    expect((overview.tabs as { name: string }[]).map((t) => t.name)).toEqual(['Sheet1', 'Q2']);
    expect(overview.selection).toEqual(['A1:B2']);
    expect(svc.state().open?.rev).toBe(onQ2.rev);
  });

  it('refuses a stale save and rewrites cell images for the iframe and back', async () => {
    const sheet = await svc.createSheet('Pics');
    const { rev, data } = await svc.get('sheet', sheet.id);
    const wb = data as Workbook;
    wb.tabs[0].cells.A1 = { v: '', img: 'https://plugin.example.com/plugin/img/0f4e2d8a-1b2c-4d3e-9f80-123456789abc' };
    await tick();
    await svc.save('sheet', sheet.id, wb, rev);
    const stored = await svc.sheets.load('u1', sheet.id);
    expect(stored!.workbook.tabs[0].cells.A1.img).toBe('/api/images/0f4e2d8a-1b2c-4d3e-9f80-123456789abc');
    const pub = await svc.get('sheet', sheet.id);
    expect((pub.data as Workbook).tabs[0].cells.A1.img).toBe('https://plugin.example.com/plugin/img/0f4e2d8a-1b2c-4d3e-9f80-123456789abc');
    await expect(svc.save('sheet', sheet.id, wb, rev)).rejects.toBeInstanceOf(ConflictError);
  });

  it('stores an inline image given to set_cell_image and keeps a short address in the cell', async () => {
    const sheet = await svc.createSheet('Pics');
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const r = await svc.editSheet(sheet.id, 'set_cell_image', { range: 'A1', url: `data:image/png;base64,${png}` });
    expect(r.image_in).toBe('Sheet1!A1');
    const stored = await svc.sheets.load('u1', sheet.id);
    expect(stored!.workbook.tabs[0].cells.A1.img).toMatch(/^\/api\/images\//);
    expect(svc.imageFile(stored!.workbook.tabs[0].cells.A1.img!.slice('/api/images/'.length))?.type).toBe('image/png');
  });

  it('imports an Excel workbook as a new spreadsheet, or as tabs for an open one', async () => {
    const x = new ExcelJS.Workbook();
    const ws = x.addWorksheet('Sales');
    ws.addRow(['Region', 'Total']);
    ws.addRow(['North', 10]);
    const bytes = Buffer.from(await x.xlsx.writeBuffer());
    const { file } = await svc.importFile(bytes, 'sales.xlsx', 'Sales');
    expect(file.kind).toBe('sheet');
    const read = await svc.editSheet(file.id, 'read_range', { range: 'A1:B2' });
    expect(read.values).toEqual([['Region', 'Total'], ['North', '10']]);
    const converted = await svc.convertExcel(bytes, 'sales.xlsx');
    expect(converted.workbook.tabs.map((t) => t.name)).toEqual(['Sales']);
    await expect(svc.convertExcel(Buffer.from('nope'), 'notes.txt')).rejects.toThrow(/Excel/);
  });
});

describe('pictures edited by the app', () => {
  const png = (n: number) => Buffer.concat([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64'), Buffer.alloc(n, 0)]);

  it('hands an edit to the app with its state, once, and takes its answer', async () => {
    const waiting = svc.runImageJob('f1', [{ op: 'rotate', degrees: 90 }], 'copy');
    const [job] = svc.takeImageJobs();
    expect(job).toMatchObject({ file_id: 'f1', operations: [{ op: 'rotate', degrees: 90 }], save: 'copy' });
    // Another app (or the next poll) is not given the same job.
    expect(svc.takeImageJobs()).toEqual([]);
    expect(svc.finishImageJob(job.id, { ok: true, applied: ['Rotated 90°'], file_id: 'f2', saved: true })).toBe(true);
    expect(await waiting).toMatchObject({ ok: true, applied: ['Rotated 90°'], file_id: 'f2' });
    // An answer that comes twice, or for a job nobody is waiting on, is dropped.
    expect(svc.finishImageJob(job.id, { ok: true })).toBe(false);
    expect(svc.finishImageJob('nope', { ok: true })).toBe(false);
  });

  it('gives up on an edit no app takes, and on one an app took and never answered', async () => {
    vi.useFakeTimers();
    try {
      // No app has asked for its state lately: nothing will take the job, so the wait is short.
      const unseen = svc.runImageJob('f1', [], 'copy');
      await vi.advanceTimersByTimeAsync(26_000);
      expect(await unseen).toMatchObject({ ok: false, error: expect.stringContaining('Call open_file with this picture') });
      expect(svc.takeImageJobs()).toEqual([]);
      // An app is there (it just asked) and takes the job, but does not answer.
      const stuck = svc.runImageJob('f1', [], 'copy');
      expect(svc.takeImageJobs()).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(60_000);
      let settled = false;
      void stuck.then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(31_000);
      expect(await stuck).toMatchObject({ ok: false, error: expect.stringContaining('took too long') });
    } finally {
      vi.useRealTimers();
    }
  });

  it('saves an edited picture over a stored one, as the type it is, and tells a picture’s size', async () => {
    const { file } = await svc.importFile(png(0), 'logo.png', undefined);
    expect(await svc.editableImage(file.id)).toMatchObject({ meta: { filename: 'logo.png', type: 'image/png' }, pixels: { width: 1, height: 1 } });
    expect(await svc.saveImage(file.id, png(40))).toMatchObject({ id: file.id, kind: 'file', size: png(40).length });
    await expect(svc.saveImage(file.id, Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).rejects.toThrow(/must be saved as image\/png/);
    await expect(svc.saveImage('nope', png(1))).rejects.toThrow(/no file/);
    const { file: pdf } = await svc.importFile(Buffer.from('%PDF-1.7\n'), 'a.pdf', undefined);
    await expect(svc.saveImage(pdf.id, png(1))).rejects.toThrow(/Only PNG, JPEG and WebP/);
    await expect(svc.editableImage(pdf.id)).rejects.toThrow(/not a picture/);
  });
});
