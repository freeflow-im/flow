import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from './app.ts';
import type { AgentContext } from '../shared/agent/protocol.ts';
import { runServerTool } from './agent/tools.ts';
import type { FileStore } from './files.ts';
import { paperFor, PdfMaker, pdfName, PlaywrightRenderer, PrintError, PrintTickets, type PdfOptions, type PdfRenderer } from './pdf.ts';
import type { SheetStore } from './sheets.ts';
import { mailbox, signUp } from './testing.ts';

describe('paperFor', () => {
  it('is Letter where Letter is the custom and A4 elsewhere', () => {
    expect(paperFor('en-US')).toBe('letter');
    expect(paperFor('fr-CA')).toBe('letter');
    expect(paperFor('en_PH')).toBe('letter');
    expect(paperFor('en-GB')).toBe('a4');
    expect(paperFor('de-DE')).toBe('a4');
    expect(paperFor('en')).toBe('a4');
    expect(paperFor(undefined)).toBe('a4');
  });
});

describe('pdfName', () => {
  it('names the PDF after the file, without a web page or Markdown extension', () => {
    expect(pdfName('Proposal')).toBe('Proposal.pdf');
    expect(pdfName('Report.html')).toBe('Report.pdf');
    expect(pdfName('README.md')).toBe('README.pdf');
    // The desktop app's titles are file names.
    expect(pdfName('Proposal.docx')).toBe('Proposal.pdf');
    expect(pdfName('Pitch.pptx')).toBe('Pitch.pdf');
    expect(pdfName('a/b')).toBe('a_b.pdf');
    expect(pdfName('  ')).toBe('document.pdf');
  });
});

describe('PrintTickets', () => {
  it('is a user for two minutes, until revoked', () => {
    vi.useFakeTimers();
    try {
      const tickets = new PrintTickets<{ id: string }>();
      const user = { id: 'u1' };
      const t = tickets.create(user);
      expect(tickets.userFor(t)).toBe(user);
      expect(tickets.userFor('nope')).toBeNull();
      expect(tickets.userFor(undefined)).toBeNull();
      vi.advanceTimersByTime(2 * 60 * 1000 + 1);
      expect(tickets.userFor(t)).toBeNull();
      const u = tickets.create(user);
      tickets.revoke(u);
      expect(tickets.userFor(u)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Download as PDF', () => {
  let dir: string;
  let app: Awaited<ReturnType<typeof buildApp>>;
  const box = mailbox();
  /** What the fake renderer was asked to print, and what the page could do with its ticket meanwhile. */
  const asked: { url?: string; html?: string; opts: PdfOptions; read?: number; wrote?: number; cookie?: string }[] = [];
  let fail: string | null = null;

  const renderer: PdfRenderer = {
    async page(url, ticket, opts) {
      if (fail) throw new PrintError(fail);
      const cookie = `${ticket.name}=${ticket.value}`;
      const m = /\/(doc|d|md)\/([^?]+)\?print=pdf$/.exec(url)!;
      const api = m[1] === 'doc' ? 'docs' : m[1] === 'd' ? 'decks' : 'markdown';
      // The page, as the headless browser loads it: it can read the file and not change it.
      const read = await app.inject({ method: 'GET', url: `/api/${api}/${m[2]}`, headers: { cookie } });
      const wrote = await app.inject({ method: 'POST', url: '/api/docs', headers: { cookie }, payload: { title: 'Sneaky' } });
      asked.push({ url, opts, read: read.statusCode, wrote: wrote.statusCode, cookie });
      return Buffer.from('%PDF-page');
    },
    async html(html, opts) {
      asked.push({ html, opts });
      return Buffer.from('%PDF-html');
    },
    async close() {},
  };

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'pdf-test-'));
    app = await buildApp({ dataDir: dir, sendMail: box.send, pdf: renderer });
  });

  afterAll(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('prints a document, presentation or Markdown file from its page in the app, with a read-only ticket', async () => {
    const { cookie } = await signUp(app, box, 'pdf@x.com');
    const doc = (await app.inject({ method: 'POST', url: '/api/docs', headers: { cookie }, payload: { title: 'Proposal' } })).json().doc;
    const deck = (await app.inject({ method: 'POST', url: '/api/decks', headers: { cookie }, payload: { title: 'Pitch' } })).json().deck;
    const md = (await app.inject({ method: 'POST', url: '/api/markdown', headers: { cookie }, payload: { title: 'README', text: '# Hi' } })).json().doc;

    let res = await app.inject({ method: 'GET', url: `/api/files/${doc.id}/export?format=pdf&locale=en-US`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toContain('Proposal.pdf');
    expect(res.headers['x-revision']).toBe(doc.updatedAt);
    expect(res.body).toBe('%PDF-page');
    let a = asked.at(-1)!;
    expect(a.url).toMatch(new RegExp(`/doc/${doc.id}\\?print=pdf$`));
    expect(a.opts).toMatchObject({ paper: 'letter', margin: 0.5 });
    expect(a.read).toBe(200);
    expect(a.wrote).toBe(403);
    // The ticket ends with the PDF.
    expect((await app.inject({ method: 'GET', url: `/api/docs/${doc.id}`, headers: { cookie: a.cookie! } })).statusCode).toBe(401);

    res = await app.inject({ method: 'GET', url: `/api/files/${deck.id}/export?format=pdf`, headers: { cookie, 'accept-language': 'de-DE,de;q=0.9' } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toContain('Pitch.pdf');
    a = asked.at(-1)!;
    expect(a.url).toMatch(new RegExp(`/d/${deck.id}\\?print=pdf$`));
    expect(a.opts).toMatchObject({ paper: 'a4', margin: 0 });
    expect(a.read).toBe(200);

    res = await app.inject({ method: 'GET', url: `/api/files/${md.id}/export?format=pdf&locale=en-GB`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toContain('README.pdf');
    expect(asked.at(-1)!.url).toMatch(new RegExp(`/md/${md.id}\\?print=pdf$`));
    expect(asked.at(-1)!.read).toBe(200);
  });

  it('prints a stored web page from its HTML, and refuses other files, spreadsheets and other users’ files', async () => {
    const { cookie } = await signUp(app, box, 'pdf2@x.com');
    const { cookie: other } = await signUp(app, box, 'pdf3@x.com');
    const upload = (name: string, type: string, body: string) => app.inject({ method: 'POST', url: '/api/files', headers: { cookie, 'content-type': type, 'x-filename': name }, payload: Buffer.from(body) });
    const page = (await upload('Report.html', 'application/octet-stream', '<h1>Report</h1>')).json().file;
    const text = (await upload('notes.txt', 'application/octet-stream', 'hello')).json().file;
    const sheet = (await app.inject({ method: 'POST', url: '/api/sheets', headers: { cookie }, payload: { title: 'Budget' } })).json().sheet;
    const doc = (await app.inject({ method: 'POST', url: '/api/docs', headers: { cookie }, payload: { title: 'Mine' } })).json().doc;

    let res = await app.inject({ method: 'GET', url: `/api/files/${page.id}/export?format=pdf&locale=en-US`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toContain('Report.pdf');
    expect(res.body).toBe('%PDF-html');
    expect(asked.at(-1)).toMatchObject({ html: '<h1>Report</h1>', opts: { paper: 'letter', margin: 0.5 } });

    res = await app.inject({ method: 'GET', url: `/api/files/${text.id}/export?format=pdf`, headers: { cookie } });
    expect(res.statusCode).toBe(400);
    res = await app.inject({ method: 'GET', url: `/api/files/${sheet.id}/export?format=pdf`, headers: { cookie } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/spreadsheet/);
    res = await app.inject({ method: 'GET', url: `/api/files/${doc.id}/export?format=pdf`, headers: { cookie: other } });
    expect(res.statusCode).toBe(404);
    res = await app.inject({ method: 'GET', url: `/api/files/${doc.id}/export?format=pdf` });
    expect(res.statusCode).toBe(401);
  });

  it('says why a PDF could not be made', async () => {
    const { cookie } = await signUp(app, box, 'pdf4@x.com');
    const doc = (await app.inject({ method: 'POST', url: '/api/docs', headers: { cookie }, payload: { title: 'Broken' } })).json().doc;
    fail = 'The PDF could not be made: timed out';
    try {
      const res = await app.inject({ method: 'GET', url: `/api/files/${doc.id}/export?format=pdf`, headers: { cookie } });
      expect(res.statusCode).toBe(500);
      expect(res.json().error).toBe('The PDF could not be made: timed out');
    } finally {
      fail = null;
    }
  });
});

/** A renderer that prints what it was asked for as the PDF's text. */
const echo: PdfRenderer = {
  page: async (url, _ticket, opts) => Buffer.from(`%PDF page ${url} ${opts.paper}`),
  html: async (html, opts) => Buffer.from(`%PDF html ${html} ${opts.paper}`),
  close: async () => {},
};

describe('export_pdf (the assistant)', () => {
  it('keeps the PDF of the open file beside it', async () => {
    const made: { owner: string; name: string; type: string; data: string; folder: string }[] = [];
    const files = {
      get: () => null,
      create: async (owner: string, name: string, type: string, data: Buffer, folder: string) => (made.push({ owner, name, type, data: data.toString(), folder }), { id: 'f1', filename: name, type, size: data.length, folder, createdAt: '', url: '', downloadUrl: '' }),
    } as unknown as FileStore;
    const meta = (id: string, kind: string, title: string) => ({ id, kind, title, folder: 'Plans', updatedAt: 'r1', createdAt: '' });
    const sheets = { get: (owner: string, id: string) => (owner !== 'u1' ? null : id === 'd1' ? meta('d1', 'doc', 'Plan') : id === 's1' ? meta('s1', 'sheet', 'Budget') : null) } as unknown as SheetStore;
    const pdf = new PdfMaker({ renderer: echo, sheets, files, origin: () => 'http://app.test' });
    const onDoc: AgentContext = { page: 'doc', docId: 'd1', title: 'Plan' } as AgentContext;
    const env = { userId: 'u1', sheets, files, pdf, context: onDoc };

    const out = JSON.parse(await runServerTool('export_pdf', { paper: 'a4' }, env));
    expect(out).toMatchObject({ made: true, file_id: 'f1', name: 'Plan.pdf', folder: 'Plans' });
    expect(made).toEqual([{ owner: 'u1', name: 'Plan.pdf', type: 'application/pdf', data: '%PDF page http://app.test/doc/d1?print=pdf a4', folder: 'Plans' }]);
    await expect(runServerTool('export_pdf', { file_id: 's1' }, env)).rejects.toThrow(/spreadsheet/);
    await expect(runServerTool('export_pdf', { file_id: 'nope' }, env)).rejects.toThrow(/no file nope/);
    await expect(runServerTool('export_pdf', {}, { ...env, context: { page: 'home' } })).rejects.toThrow(/Give file_id/);
    await expect(runServerTool('export_pdf', {}, { ...env, pdf: undefined })).rejects.toThrow(/cannot be made here/);
  });
});

describe('export_pdf (the desktop app’s MCP server)', () => {
  const TOKEN = 'pdf-token-0123456789';
  let dataDir: string;
  let folder: string;
  let app: Awaited<ReturnType<typeof buildApp>>;
  const shown: string[] = [];

  beforeAll(async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), 'pdf-mcp-data-'));
    folder = mkdtempSync(path.join(tmpdir(), 'pdf-mcp-folder-'));
    writeFileSync(path.join(folder, 'notes.md'), '# Notes\n');
    app = await buildApp({ dataDir, pdf: echo, local: { dir: folder, mcp: { token: TOKEN, show: (page) => shown.push(page) } } });
    await app.listen({ port: 0, host: '127.0.0.1' });
  });

  afterAll(async () => {
    await app.close();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(folder, { recursive: true, force: true });
  });

  it('makes the PDF of a file in the folder, beside it, and shows it', async () => {
    const address = app.server.address();
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/mcp`), { requestInit: { headers: { authorization: `Bearer ${TOKEN}` } } }));
    try {
      const text = (r: Awaited<ReturnType<Client['callTool']>>) => (r.content as { text?: string }[]).map((c) => c.text ?? '').join('');
      const list = JSON.parse(text(await client.callTool({ name: 'list_files', arguments: {} })));
      const notes = (list.files as { id: string; kind: string }[]).find((f) => f.kind === 'markdown')!;
      const r = await client.callTool({ name: 'export_pdf', arguments: { file_id: notes.id } });
      expect(r.isError).not.toBe(true);
      const { file } = JSON.parse(text(r));
      expect(file).toMatchObject({ kind: 'file', title: 'notes.pdf', type: 'application/pdf' });
      expect(existsSync(path.join(folder, 'notes.pdf'))).toBe(true);
      expect(readFileSync(path.join(folder, 'notes.pdf'), 'utf8')).toMatch(new RegExp(`^%PDF page http://[^/]+/md/${notes.id}\\?print=pdf letter$`));
      expect(shown.at(-1)).toBe(`/f/${file.id}`);
    } finally {
      await client.close();
    }
  });
});

// The real renderer, when this machine has a Chromium or Chrome for it (skipped otherwise).
const renderer = new PlaywrightRenderer();
const browserFound = await renderer
  .html('<p>x</p>', { paper: 'a4', margin: 0.5, timeoutMs: 20_000 })
  .then(() => true)
  .catch(() => false);

describe.skipIf(!browserFound)('PlaywrightRenderer', () => {
  let server: Server;
  let hits: string[];
  let local: string;

  beforeAll(async () => {
    hits = [];
    server = createServer((req, res) => {
      hits.push(req.url ?? '');
      res.end('secret');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    local = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await renderer.close();
  }, 30_000);

  it('prints a web page without letting it reach this machine or the private network', async () => {
    const html = `<h1>Hello</h1><img src="${local}/img"><script>fetch('${local}/fetch').catch(()=>{}); fetch('${local}/post', { method: 'POST' }).catch(()=>{})</script><link rel="stylesheet" href="http://10.0.0.1/x.css">`;
    const pdf = await renderer.html(html, { paper: 'letter', margin: 0.5, timeoutMs: 20_000 });
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(hits).toEqual([]);
  }, 30_000);
});
