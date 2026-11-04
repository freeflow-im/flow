// Previews (server/previews.ts): a file converted to be shown read-only for an hour, its owner's only, and saved to
// My files on request. The app is hosted as in the FreeFlow suite (organizations.test.ts), where Mail uses it.
import ExcelJS from 'exceljs';
import Fastify from 'fastify';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSlide, newId } from '../shared/deck.ts';
import { buildPptx } from '../shared/pptxExport.ts';
import { buildApp } from './app.ts';
import { MAX_PREVIEW_BYTES, PREVIEW_TTL_MS, PreviewError, previewKindOf, Previews } from './previews.ts';
import { buildDocx } from './testing.ts';

const PARAGRAPH = '<w:p><w:r><w:t>Hello from Word</w:t></w:r></w:p>';
const docx = () => buildDocx(PARAGRAPH);
async function xlsx(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Numbers');
  ws.getCell('A1').value = 'Region';
  ws.getCell('B1').value = 42;
  return Buffer.from(await wb.xlsx.writeBuffer());
}
async function pptx(): Promise<Buffer> {
  const { pres } = await buildPptx({ version: 1, theme: 'light', slides: [buildSlide('title-body', { title: 'From PowerPoint', body: ['One', 'Two'] }, newId)] }, 'x', async () => null);
  return Buffer.from((await pres.write({ outputType: 'nodebuffer' })) as Buffer);
}
const pdf = () => readFileSync(new URL('./fixtures/report.pdf', import.meta.url));
const csv = Buffer.from('name,amount\nann,3\nbo,4\n');

describe('the kind of preview', () => {
  it('goes by the bytes for a PDF, then the name, then the stated type', () => {
    const zip = Buffer.from('PK\u0003\u0004');
    expect(previewKindOf('report.bin', 'application/octet-stream', pdf())).toBe('pdf');
    expect(previewKindOf('Plan.DOCX', '', zip)).toBe('doc');
    expect(previewKindOf('deck.pptx', '', zip)).toBe('deck');
    expect(previewKindOf('q3.xlsx', '', zip)).toBe('sheet');
    expect(previewKindOf('old.xls', '', zip)).toBe('sheet');
    expect(previewKindOf('rows.csv', 'text/plain', csv)).toBe('sheet');
    expect(previewKindOf('README.md', '', Buffer.from('# Hi'))).toBe('markdown');
    expect(previewKindOf('photo.png', 'image/png', Buffer.from('x'))).toBe('file');
    expect(previewKindOf('attachment', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', zip)).toBe('doc');
    expect(previewKindOf('attachment', 'text/csv', csv)).toBe('sheet');
    expect(previewKindOf('attachment', 'application/zip', zip)).toBe('file');
  });
});

describe('the preview store', () => {
  let dir: string;
  let clock = 1_000_000;
  let store: Previews;
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'previews-'));
    store = new Previews(new DatabaseSync(':memory:'), path.join(dir, 'previews'), () => clock);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('converts Word, Excel, PowerPoint, CSV and Markdown with the importers, and keeps a PDF as it is', async () => {
    const made = async (filename: string, bytes: Buffer) => {
      const p = await store.create('ann', 'harbor', { filename, type: '', bytes });
      return { p, view: (await store.view('ann', p.id, '/file'))! };
    };
    let { p, view } = await made('Plan.docx', await docx());
    expect(p.kind).toBe('doc');
    expect(view.kind === 'doc' && JSON.stringify(view.doc)).toContain('Hello from Word');
    ({ p, view } = await made('Numbers.xlsx', await xlsx()));
    expect(view.kind === 'sheet' && view.workbook.tabs[0].name).toBe('Numbers');
    expect(view.kind === 'sheet' && view.workbook.tabs[0].cells.B1?.v).toBe('42');
    ({ p, view } = await made('Slides.pptx', await pptx()));
    expect(view.kind === 'deck' && view.deck.slides.length).toBe(1);
    expect(view.kind === 'deck' && JSON.stringify(view.deck)).toContain('From PowerPoint');
    ({ p, view } = await made('rows.csv', csv));
    expect(view.kind === 'sheet' && view.workbook.tabs[0].cells.A2?.v).toBe('ann');
    ({ p, view } = await made('notes.md', Buffer.from('# Notes\n\nSome *text*.')));
    expect(view).toEqual({ kind: 'markdown', text: '# Notes\n\nSome *text*.' });
    ({ p, view } = await made('Report.pdf', pdf()));
    expect(view).toEqual({ kind: 'pdf', url: '/file' });
    expect((await store.bytes('ann', p.id))!.equals(pdf())).toBe(true);
  });

  it('refuses a damaged file and one over the limits, saying why', async () => {
    await expect(store.create('ann', null, { filename: 'broken.docx', type: '', bytes: Buffer.from('PK not really') })).rejects.toThrow(PreviewError);
    const big = Buffer.alloc(MAX_PREVIEW_BYTES + 1);
    await expect(store.create('ann', null, { filename: 'huge.mp4', type: 'video/mp4', bytes: big })).rejects.toMatchObject({ status: 413, message: expect.stringMatching(/too large to preview \(25 MB maximum\)/) });
    await expect(store.create('ann', null, { filename: 'huge.docx', type: '', bytes: Buffer.concat([await docx(), Buffer.alloc(21 * 1024 * 1024)]) })).rejects.toMatchObject({ status: 413, message: expect.stringMatching(/document is too large to preview \(20 MB/) });
  });

  it('is its owner’s only', async () => {
    const p = await store.create('ann', 'harbor', { filename: 'rows.csv', type: 'text/csv', bytes: csv });
    expect(store.get('ann', p.id)?.filename).toBe('rows.csv');
    expect(store.get('bo', p.id)).toBeNull();
    expect(await store.view('bo', p.id, '/file')).toBeNull();
    expect(await store.bytes('bo', p.id)).toBeNull();
    expect(store.get('ann', 'not-an-id')).toBeNull();
  });

  it('is reused for the same source, and expires an hour after it was last reused, with its files', async () => {
    const p = await store.create('ann', 'harbor', { filename: 'rows.csv', type: 'text/csv', bytes: csv, sourceKey: 'mail:a:INBOX:7:0' });
    expect(store.reuse('ann', 'harbor', 'mail:a:INBOX:7:0')?.id).toBe(p.id);
    expect(store.reuse('bo', 'harbor', 'mail:a:INBOX:7:0')).toBeNull();
    expect(store.reuse('ann', 'juniper', 'mail:a:INBOX:7:0')).toBeNull();
    clock += PREVIEW_TTL_MS - 1000;
    expect(store.reuse('ann', 'harbor', 'mail:a:INBOX:7:0')?.expiresAt).toBe(clock + PREVIEW_TTL_MS);
    clock += PREVIEW_TTL_MS - 1000;
    expect(store.get('ann', p.id)).not.toBeNull();
    clock += 2000;
    expect(store.get('ann', p.id)).toBeNull();
    expect(store.reuse('ann', 'harbor', 'mail:a:INBOX:7:0')).toBeNull();
    expect(await store.sweep()).toBeNull();
    expect(() => readFileSync(path.join(dir, 'previews', p.id))).toThrow();
  });
});

describe('the preview routes in the hosted app', () => {
  const members: Record<string, string[]> = { alice: ['harbor'], bob: ['harbor'] };
  let dir: string;
  let host: ReturnType<typeof Fastify>;
  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'previews-app-'));
    host = Fastify();
    await buildApp({
      dataDir: dir,
      blob: null,
      pdf: null,
      agent: { jobs: false },
      host: {
        app: host,
        basePath: '/workspace',
        authenticate: async (req) => {
          const id = req.headers['x-user'];
          return typeof id === 'string' && id in members ? { id, email: `${id}@x.test` } : null;
        },
        signOut: async () => {},
        userForCookie: async () => null,
        isMember: async (userId, workspaceId) => members[userId]?.includes(workspaceId) ?? false,
        organizationsOf: async (userId) => (members[userId] ?? []).map((id) => ({ id, name: id })),
      },
    });
    await host.ready();
  });
  afterAll(async () => {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const upload = (who: string, url: string, bytes: Buffer) => host.inject({ method: 'POST', url, headers: { 'x-user': who, 'content-type': 'application/octet-stream' }, payload: bytes });
  const get = (who: string, url: string) => host.inject({ method: 'GET', url, headers: { 'x-user': who } });

  it('makes a preview, shows it only to its owner, and saves it once to the top of My files', async () => {
    let res = await upload('alice', `/api/previews?workspace=harbor&filename=${encodeURIComponent('Plan.docx')}&key=mail:a:INBOX:3:1`, await docx());
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const { preview } = res.json() as { preview: { id: string; kind: string } };
    expect(preview.kind).toBe('doc');

    res = await get('alice', `/api/previews/${preview.id}?workspace=harbor`);
    expect(res.statusCode).toBe(200);
    expect(res.json().view.kind).toBe('doc');
    expect((await get('bob', `/api/previews/${preview.id}?workspace=harbor`)).statusCode).toBe(404);
    expect((await get('bob', `/api/previews/${preview.id}/file?workspace=harbor`)).statusCode).toBe(404);
    expect((await host.inject({ method: 'POST', url: `/api/previews/${preview.id}/save?workspace=harbor`, headers: { 'x-user': 'bob' } })).statusCode).toBe(404);
    expect((await get('alice', `/api/previews/${preview.id}`)).statusCode).toBe(200);

    // The same attachment again: the same preview, not a new one; someone else's key finds nothing.
    expect((await get('alice', '/api/previews?workspace=harbor&key=mail:a:INBOX:3:1')).json().preview.id).toBe(preview.id);
    expect((await get('bob', '/api/previews?workspace=harbor&key=mail:a:INBOX:3:1')).json().preview).toBeNull();

    // Not in the library or Recents until saved.
    expect((await get('alice', '/api/library?workspace=harbor')).json().docs).toEqual([]);
    res = await host.inject({ method: 'POST', url: `/api/previews/${preview.id}/save?workspace=harbor`, headers: { 'x-user': 'alice' } });
    expect(res.statusCode).toBe(200);
    const { saved } = res.json() as { saved: { kind: string; id: string; title: string; url: string } };
    expect(saved).toMatchObject({ kind: 'doc', title: 'Plan', url: `/workspace/doc/${saved.id}` });
    const library = (await get('alice', '/api/library?workspace=harbor')).json();
    expect(library.docs.map((d: { id: string; folder?: string }) => [d.id, d.folder ?? ''])).toEqual([[saved.id, '']]);
    // Saving again gives the same file.
    res = await host.inject({ method: 'POST', url: `/api/previews/${preview.id}/save?workspace=harbor`, headers: { 'x-user': 'alice' } });
    expect(res.json().saved.id).toBe(saved.id);
    expect((await get('bob', `/api/docs/${saved.id}`)).statusCode).toBe(404);
  });

  it('serves a PDF preview’s bytes as a download that runs nothing, and refuses an organization the user is not in', async () => {
    let res = await upload('alice', '/api/previews?workspace=harbor&filename=Report.pdf', pdf());
    const id = res.json().preview.id as string;
    expect(res.json().preview.kind).toBe('pdf');
    res = await get('alice', `/api/previews/${id}`);
    expect(res.json().view).toEqual({ kind: 'pdf', url: `/api/previews/${id}/file` });
    res = await get('alice', `/api/previews/${id}/file`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-security-policy']).toContain('sandbox');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.rawPayload.equals(pdf())).toBe(true);
    expect((await upload('bob', '/api/previews?workspace=juniper&filename=Report.pdf', pdf())).statusCode).toBe(403);
    expect((await upload('alice', '/api/previews?workspace=harbor&filename=broken.pptx', Buffer.from('PK broken'))).statusCode).toBe(400);
  });
});
