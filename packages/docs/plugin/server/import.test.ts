import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../../server/db.ts';
import { buildDocx } from '../../server/testing.ts';
import { FileHub } from './files.ts';
import { createPluginServer } from './http.ts';
import { createMcpServer } from './mcp.ts';

let dir: string;
let base: string;
let hub: FileHub;
let close: () => Promise<void>;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'docs-import-'));
  const db = openDb(path.join(dir, 'app.db'));
  db.prepare('INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)').run('u1', 'a@example.com', 'x', new Date().toISOString());
  hub = new FileHub({ db, dataDir: dir, publicUrl: null });
  await hub.init();
  const server = createPluginServer({ hub, oauth: null, devUserId: 'u1', publicUrl: null, webDir: dir, production: true });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => new Promise((r) => server.close(() => r()));
});

afterEach(async () => {
  await close();
  await rm(dir, { recursive: true, force: true });
});

describe('upload from an agent', () => {
  it('gives version 2 an address to post a local file to, once, into a folder', async () => {
    const server = createMcpServer(hub.forUser('u1'), { bundle: () => ({ js: '', css: '', hash: 'x' }), publicUrl: base, version: 2 });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(b);
    const call = async (name: string, args: Record<string, unknown>) => {
      const r = await client.callTool({ name, arguments: args });
      return { isError: r.isError === true, data: r.structuredContent as Record<string, string> };
    };
    // The folder has to be there first.
    expect((await call('upload_file', { file_name: 'report.pdf', folder: 'Inbox/Scans' })).isError).toBe(true);
    await call('create_folder', { path: 'Inbox/Scans' });
    const { data } = await call('upload_file', { file_name: 'report.pdf', folder: 'Inbox/Scans' });
    expect(data.upload_url).toMatch(new RegExp(`^${base}/plugin/import\\?ticket=[\\w-]+&name=report\\.pdf$`));
    expect(data.example).toContain('curl -sS -X POST --data-binary @"/path/to/report.pdf"');

    const pdf = new Uint8Array(Buffer.from('%PDF-1.7\n%%EOF'));
    const up = await fetch(data.upload_url, { method: 'POST', body: pdf });
    expect(up.status).toBe(200);
    expect(((await up.json()) as { file: unknown }).file).toMatchObject({ kind: 'file', title: 'report.pdf', folder: 'Inbox/Scans' });
    expect((await fetch(data.upload_url, { method: 'POST', body: pdf })).status).toBe(401);
    expect(hub.files.list('u1').map((f) => [f.filename, f.folder])).toEqual([['report.pdf', 'Inbox/Scans']]);

    // An editable file lands in the folder too; without a folder it goes to the top.
    const docx = await buildDocx('<w:p><w:r><w:t>Hello</w:t></w:r></w:p>');
    const word = await call('upload_file', { file_name: 'brief.docx', folder: 'Inbox', title: 'The brief' });
    expect(((await (await fetch(word.data.upload_url, { method: 'POST', body: new Uint8Array(docx) })).json()) as { file: unknown }).file).toMatchObject({ kind: 'doc', title: 'The brief', folder: 'Inbox' });
    const top = await call('upload_file', { file_name: 'notes.md' });
    expect(((await (await fetch(top.data.upload_url, { method: 'POST', body: '# Notes' })).json()) as { file: Record<string, unknown> }).file).not.toHaveProperty('folder');
    await client.close();
  });
});

describe('import from the app', () => {
  it('accepts a Word file with a fresh ticket, once, and opens the result', async () => {
    const docx = await buildDocx('<w:p><w:r><w:t>Hello from Word</w:t></w:r></w:p>');
    const ticket = hub.issueTicket('u1');
    const post = (t: string, body: Buffer) => fetch(`${base}/plugin/import?ticket=${t}&name=brief.docx`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: new Uint8Array(body) });
    const ok = await post(ticket, docx);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('access-control-allow-origin')).toBe('*');
    const r = (await ok.json()) as { file: { kind: string; title: string; id: string } };
    expect(r.file).toMatchObject({ kind: 'doc', title: 'brief' });
    expect(hub.forUser('u1').open).toEqual({ kind: 'doc', id: r.file.id });
    expect((await post(ticket, docx)).status).toBe(401);
    expect((await post('bogus', docx)).status).toBe(401);
    const text = await post(hub.issueTicket('u1'), Buffer.from([0, 1, 2, 0xff]));
    expect(text.status).toBe(400);
    expect(((await text.json()) as { error: string }).error).toMatch(/Only Word documents/);
    // An edited picture from the image editor is saved over the stored one, with a ticket of the same account.
    const png = (n: number) => Buffer.concat([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64'), Buffer.alloc(n, 0)]);
    const pic = (await hub.forUser('u1').importFile(png(0), 'logo.png', undefined)).file;
    const over = await fetch(`${base}/plugin/import?ticket=${hub.issueTicket('u1')}&name=logo.png&replace=${pic.id}`, { method: 'POST', headers: { 'content-type': 'image/png' }, body: new Uint8Array(png(25)) });
    expect(over.status).toBe(200);
    expect(await over.json()).toMatchObject({ file: { id: pic.id, kind: 'file', size: png(25).length } });
    const wrong = await fetch(`${base}/plugin/import?ticket=${hub.issueTicket('u1')}&name=logo.png&replace=${pic.id}`, { method: 'POST', headers: { 'content-type': 'image/png' }, body: 'not a picture' });
    expect(wrong.status).toBe(400);
    expect(hub.files.get('u1', pic.id)?.meta.size).toBe(png(25).length);

    // An edited picture for a document or slide is stored as a picture, and can be read back by the app's
    // opaque origin (the image editor reads a picture with fetch).
    const stored = await fetch(`${base}/plugin/import?ticket=${hub.issueTicket('u1')}&image=1`, { method: 'POST', headers: { 'content-type': 'image/png' }, body: new Uint8Array(png(7)) });
    expect(stored.status).toBe(200);
    const { src } = (await stored.json()) as { src: string };
    expect(src).toMatch(/\/(plugin\/img|api\/images)\/[0-9a-f-]{36}$/);
    const back = await fetch(`${base}/plugin/img/${src.split('/').pop()}`);
    expect(back.status).toBe(200);
    expect(back.headers.get('access-control-allow-origin')).toBe('*');
    expect((await back.arrayBuffer()).byteLength).toBe(png(7).length);
    const notPicture = await fetch(`${base}/plugin/import?ticket=${hub.issueTicket('u1')}&image=1`, { method: 'POST', headers: { 'content-type': 'application/pdf' }, body: '%PDF-1.7' });
    expect(notPicture.status).toBe(400);

    const pre = await fetch(`${base}/plugin/import`, { method: 'OPTIONS' });
    expect(pre.status).toBe(204);
  });

  it('stores a video and a PDF as they are, and serves them to the viewer by a link with a token, in ranges', async () => {
    const bytes = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));
    const up = await fetch(`${base}/plugin/import?ticket=${hub.issueTicket('u1')}&name=clip.mov`, { method: 'POST', headers: { 'content-type': 'video/quicktime' }, body: new Uint8Array(bytes) });
    expect(up.status).toBe(200);
    const { file } = (await up.json()) as { file: { kind: string; id: string; title: string; type: string; size: number } };
    expect(file).toMatchObject({ kind: 'file', title: 'clip.mov', type: 'video/quicktime', size: 1000 });
    const svc = hub.forUser('u1');
    expect(svc.open).toEqual({ kind: 'file', id: file.id });
    expect(svc.state().open).toMatchObject({ kind: 'file', title: 'clip.mov' });
    expect(svc.list().map((f) => [f.kind, f.title])).toEqual([['file', 'clip.mov']]);

    // The link works without any other credential, for that file only; QuickTime is served as MP4 so browsers play it.
    const { url } = svc.fileLink(file.id);
    expect(url).toMatch(new RegExp(`^/plugin/file/${file.id}\\?t=`));
    const whole = await fetch(`${base}${url}`);
    expect(whole.status).toBe(200);
    expect(whole.headers.get('content-type')).toBe('video/mp4');
    expect(whole.headers.get('accept-ranges')).toBe('bytes');
    expect(whole.headers.get('access-control-allow-origin')).toBe('*');
    expect(Buffer.from(await whole.arrayBuffer()).equals(bytes)).toBe(true);
    const part = await fetch(`${base}${url}`, { headers: { range: 'bytes=10-19' } });
    expect(part.status).toBe(206);
    expect(part.headers.get('content-range')).toBe('bytes 10-19/1000');
    expect(Buffer.from(await part.arrayBuffer()).equals(bytes.subarray(10, 20))).toBe(true);
    expect((await fetch(`${base}${url}`, { headers: { range: 'bytes=5000-' } })).status).toBe(416);
    expect((await fetch(`${base}/plugin/file/${file.id}`)).status).toBe(404);
    expect((await fetch(`${base}/plugin/file/${file.id}?t=bogus`)).status).toBe(404);

    // A PDF is told by its content, and a second file's link does not open the first.
    const pdf = await fetch(`${base}/plugin/import?ticket=${hub.issueTicket('u1')}&name=report`, { method: 'POST', headers: { 'content-type': 'application/pdf' }, body: new Uint8Array(Buffer.from('%PDF-1.7\n%%EOF')) });
    const report = ((await pdf.json()) as { file: { kind: string; id: string; title: string; type: string } }).file;
    expect(report).toMatchObject({ kind: 'file', title: 'report.pdf', type: 'application/pdf' });
    const other = svc.fileLink(report.id).url;
    expect((await fetch(`${base}${other}`)).headers.get('content-type')).toBe('application/pdf');
    expect((await fetch(`${base}${other.replace(report.id, file.id)}`)).status).toBe(404);

    // A web page is never served as a page: the viewer reads its text and shows it in a sandboxed frame.
    const page = await fetch(`${base}/plugin/import?ticket=${hub.issueTicket('u1')}&name=chart.html`, { method: 'POST', headers: { 'content-type': 'text/html' }, body: '<script>alert(1)</script>' });
    const chart = ((await page.json()) as { file: { id: string; type: string } }).file;
    expect(chart.type).toBe('text/html');
    const served = await fetch(`${base}${svc.fileLink(chart.id).url}`);
    expect(served.headers.get('content-type')).toBe('application/octet-stream');
    expect(served.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await served.text()).toBe('<script>alert(1)</script>');
    await svc.delete('file', chart.id);
    svc.setOpen({ kind: 'file', id: report.id });

    // Stored files are renamed and deleted like anything else; a rename keeps the extension.
    expect(svc.rename('file', file.id, 'x').title).toBe(`x${path.extname(file.title)}`);
    await svc.delete('file', file.id);
    expect(svc.open).toEqual({ kind: 'file', id: report.id });
    await svc.delete('file', report.id);
    expect(svc.open).toBeNull();
    expect((await fetch(`${base}${url}`)).status).toBe(404);
  });
});
