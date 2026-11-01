import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.ts';
import type { PdfRenderer } from './pdf.ts';
import { mailbox, signUp } from './testing.ts';
import type { Web } from './webCopy.ts';

// A 1×1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

const pdf: PdfRenderer = { page: async () => Buffer.from('%PDF-made'), html: async () => Buffer.from('%PDF-html'), close: async () => {} };

describe('copying between the desktop folder and the web', () => {
  let webDir: string;
  let localData: string;
  let dir: string;
  let hosted: Awaited<ReturnType<typeof buildApp>>;
  let local: Awaited<ReturnType<typeof buildApp>>;
  let cookie = '';
  const box = mailbox();

  // The Web tab's session: requests go to the hosted app as the person signed in there.
  const web: Web = {
    async fetch(method, url, body) {
      const res = await hosted.inject({ method: method as 'GET', url, headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': body.type, ...body.headers } : {}) }, payload: body?.data });
      return { status: res.statusCode, type: String(res.headers['content-type'] ?? '').split(';')[0], disposition: String(res.headers['content-disposition'] ?? ''), body: res.rawPayload };
    },
  };

  beforeAll(async () => {
    webDir = mkdtempSync(path.join(tmpdir(), 'webcopy-web-'));
    localData = mkdtempSync(path.join(tmpdir(), 'webcopy-data-'));
    dir = mkdtempSync(path.join(tmpdir(), 'webcopy-folder-'));
    writeFileSync(path.join(dir, 'notes.md'), '# Notes\n\nFrom the folder.\n');
    writeFileSync(path.join(dir, 'dot.png'), PNG);
    mkdirSync(path.join(dir, 'Inbox'));
    hosted = await buildApp({ dataDir: webDir, sendMail: box.send, pdf });
    local = await buildApp({ dataDir: localData, local: { dir, web }, pdf: null });
  });

  afterAll(async () => {
    await local.close();
    await hosted.close();
    for (const d of [webDir, localData, dir]) rmSync(d, { recursive: true, force: true });
  });

  const get = async (url: string) => (await local.inject({ method: 'GET', url })).json();
  const post = (url: string, payload: Record<string, unknown>) => local.inject({ method: 'POST', url, payload });

  it('says when the person is not signed in to the web', async () => {
    expect(await get('/api/web/status')).toEqual({ signedIn: false });
    const res = await local.inject({ method: 'GET', url: '/api/web/folders?path=' });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: 'web-signed-out' });
    cookie = (await signUp(hosted, box, 'copy@x.com')).cookie;
    expect(await get('/api/web/status')).toEqual({ signedIn: true, email: 'copy@x.com' });
  });

  it('uploads files of the folder to a web folder, pictures and all', async () => {
    await hosted.inject({ method: 'POST', url: '/api/folders', headers: { cookie }, payload: { name: 'Shared' } });
    expect((await get('/api/web/folders?path=')).folders).toEqual([{ name: 'Shared', path: 'Shared' }]);

    // A document with a picture, made in the folder.
    const img = (await local.inject({ method: 'POST', url: '/api/images', headers: { 'content-type': 'image/png' }, payload: PNG })).json().url as string;
    const doc = { version: 1, content: { type: 'doc', content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Plan' }] }, { type: 'image', attrs: { src: img } }] } };
    const made = (await post('/api/docs', { title: 'Plan', doc })).json().doc;
    expect(made).toBeTruthy();
    const lib = await get('/api/library');
    const notes = lib.docs.find((d: { kind: string }) => d.kind === 'markdown');
    const picture = lib.files.find((f: { filename: string }) => f.filename === 'dot.png');

    let res = await post('/api/web/upload', { id: made.id, webFolder: 'Shared' });
    expect(res.statusCode).toBe(200);
    const up = res.json();
    expect(up).toMatchObject({ kind: 'doc', title: 'Plan', warnings: [] });
    const onWeb = (await hosted.inject({ method: 'GET', url: `/api/docs/${up.id}`, headers: { cookie } })).json();
    expect(onWeb.meta.folder).toBe('Shared');
    const src = JSON.stringify(onWeb.doc).match(/\/api\/images\/[0-9a-f-]{36}/)![0];
    expect(src).not.toBe(img);
    expect((await hosted.inject({ method: 'GET', url: src, headers: { cookie } })).statusCode).toBe(200);

    res = await post('/api/web/upload', { id: notes.id, webFolder: 'Shared' });
    // The web's titles have no extension: notes.md is notes there.
    expect(res.json()).toMatchObject({ kind: 'markdown', title: 'notes' });
    res = await post('/api/web/upload', { id: picture.id, webFolder: '' });
    expect(res.json()).toMatchObject({ kind: 'file', title: 'dot.png' });
    const webLib = (await hosted.inject({ method: 'GET', url: '/api/library?folder=Shared', headers: { cookie } })).json();
    expect(webLib.docs.map((d: { title: string }) => d.title).sort()).toEqual(['Plan', 'notes'].sort());
  });

  it('downloads a web file into a folder as Office, the app’s own format or a PDF', async () => {
    const img = (await hosted.inject({ method: 'POST', url: '/api/images', headers: { cookie, 'content-type': 'image/png' }, payload: PNG })).json().url as string;
    const doc = { version: 1, content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'From the web' }] }, { type: 'image', attrs: { src: img } }] } };
    const webDoc = (await hosted.inject({ method: 'POST', url: '/api/docs', headers: { cookie }, payload: { title: 'Proposal', doc } })).json().doc;

    const preview = await get(`/api/web/preview?kind=doc&id=${webDoc.id}`);
    expect(preview).toEqual({ formats: ['office', 'native', 'pdf'], officeLosses: [] });

    // As Word, into Inbox: the picture is in the file.
    let res = await post('/api/web/download', { kind: 'doc', id: webDoc.id, title: 'Proposal', format: 'office', folder: 'Inbox' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ kind: 'doc', title: 'Proposal.docx', warnings: [] });
    const zip = await JSZip.loadAsync(readFileSync(path.join(dir, 'Inbox', 'Proposal.docx')));
    expect(Object.keys(zip.files).some((f) => f.startsWith('word/media/'))).toBe(true);

    // Again in the app's own format, and as a PDF: names do not clash.
    res = await post('/api/web/download', { kind: 'doc', id: webDoc.id, title: 'Proposal', format: 'native', folder: 'Inbox' });
    const native = JSON.parse(readFileSync(path.join(dir, 'Inbox', 'Proposal.ffdoc'), 'utf8'));
    const localSrc = JSON.stringify(native).match(/\/api\/images\/[0-9a-f-]{36}/)![0];
    expect((await local.inject({ method: 'GET', url: localSrc })).statusCode).toBe(200);
    res = await post('/api/web/download', { kind: 'doc', id: webDoc.id, title: 'Proposal', format: 'pdf', folder: 'Inbox' });
    expect(res.json()).toMatchObject({ kind: 'file', title: 'Proposal.pdf' });
    expect(readFileSync(path.join(dir, 'Inbox', 'Proposal.pdf'), 'utf8')).toBe('%PDF-made');
    res = await post('/api/web/download', { kind: 'doc', id: webDoc.id, title: 'Proposal', format: 'office', folder: 'Inbox' });
    expect(res.json().title).toBe('Proposal 2.docx');
    expect(existsSync(path.join(dir, 'Inbox', 'Proposal 2.docx'))).toBe(true);

    // A spreadsheet as CSV, Markdown and a stored file as they are.
    const sheet = (await hosted.inject({ method: 'POST', url: '/api/sheets', headers: { cookie }, payload: { title: 'Prices', csv: 'a,b\n1,2\n' } })).json().sheet;
    res = await post('/api/web/download', { kind: 'sheet', id: sheet.id, title: 'Prices', format: 'csv', folder: '' });
    expect(readFileSync(path.join(dir, 'Prices.csv'), 'utf8')).toContain('1,2');
    const md = (await hosted.inject({ method: 'POST', url: '/api/markdown', headers: { cookie }, payload: { title: 'Readme', text: '# Readme\n' } })).json().doc;
    res = await post('/api/web/download', { kind: 'markdown', id: md.id, title: 'Readme', format: 'as-is', folder: '' });
    expect(readFileSync(path.join(dir, 'Readme.md'), 'utf8')).toBe('# Readme\n');
    const file = (await hosted.inject({ method: 'POST', url: '/api/files', headers: { cookie, 'content-type': 'application/octet-stream', 'x-filename': 'page.html' }, payload: Buffer.from('<p>hi</p>') })).json().file;
    res = await post('/api/web/download', { kind: 'file', id: file.id, format: 'as-is', folder: '' });
    expect(res.json()).toMatchObject({ kind: 'file', title: 'page.html' });
    expect(readFileSync(path.join(dir, 'page.html'), 'utf8')).toBe('<p>hi</p>');

    // The folder must exist here.
    res = await post('/api/web/download', { kind: 'doc', id: webDoc.id, format: 'office', folder: 'Nope' });
    expect(res.statusCode).toBe(404);
  });
});
