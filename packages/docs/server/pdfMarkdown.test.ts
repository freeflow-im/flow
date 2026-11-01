import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.ts';
import { closePdfReaders, joinPages, PdfError, pdfToMarkdown } from './pdfMarkdown.ts';
import { mailbox, signUp } from './testing.ts';

const fixture = (name: string) => readFileSync(path.join(import.meta.dirname, 'fixtures', name));

describe('pdfToMarkdown', () => {
  afterAll(closePdfReaders);

  it('reads every page of a text PDF, with its headings', async () => {
    const made = await pdfToMarkdown(fixture('report.pdf'));
    expect(made.pageCount).toBe(2);
    expect(made.ocrPages).toEqual([]);
    expect(made.warnings).toEqual([]);
    expect(made.markdown).toMatch(/^# Quarterly Report\n\nThe office filed every expense on time this quarter, and travel costs fell by 0\.5 percent/);
    expect(made.markdown).toContain('## Highlights');
    expect(made.markdown).toContain('## Next Steps\n\nHire two engineers');
  });

  it('reads a scanned page with OCR, and says so', async () => {
    const made = await pdfToMarkdown(fixture('scan.pdf'));
    expect(made.ocrPages).toEqual([1]);
    expect(made.markdown).toMatch(/Scanned Receipt/);
    expect(made.markdown).toMatch(/Coffee beans and filters/);
    expect(made.warnings.join(' ')).toMatch(/Page 1 is a scan and was read with OCR/);
  }, 60_000);

  it('refuses a locked PDF, a damaged one and anything else', async () => {
    await expect(pdfToMarkdown(fixture('locked.pdf'))).rejects.toThrow(/password-protected/);
    await expect(pdfToMarkdown(Buffer.from('%PDF-1.4 nothing here'))).rejects.toThrow(/could not be read/);
    await expect(pdfToMarkdown(Buffer.from('hello'))).rejects.toThrow(PdfError);
  });

  it('puts a paragraph cut by a page break back together', () => {
    expect(joinPages(['# Title\n\nThe model was trained for', 'three days on eight machines.'])).toBe('# Title\n\nThe model was trained for three days on eight machines.');
    expect(joinPages(['Ends a sentence.', 'next starts lower case'])).toBe('Ends a sentence.\n\nnext starts lower case');
    expect(joinPages(['| a | b |', 'lower'])).toBe('| a | b |\n\nlower');
    expect(joinPages(['One', '', '  ', 'Two'])).toBe('One\n\nTwo');
  });
});

describe('POST /api/files/:id/markdown', () => {
  let dir: string;
  let app: Awaited<ReturnType<typeof buildApp>>;
  const box = mailbox();
  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'sheetsweb-pdfmd-'));
    app = await buildApp({ dataDir: dir, sendMail: box.send, appUrl: 'https://sheets.test' });
  });
  afterAll(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('makes a Markdown file of the PDF beside it', async () => {
    const { cookie } = await signUp(app, box, 'pdf@example.com');
    const upload = (name: string, body: Buffer, folder = '') => app.inject({ method: 'POST', url: `/api/import/pdf?filename=${encodeURIComponent(name)}${folder ? `&folder=${folder}` : ''}`, headers: { cookie, 'content-type': 'application/octet-stream' }, payload: body });
    expect((await app.inject({ method: 'POST', url: '/api/folders', headers: { cookie }, payload: { name: 'Reports' } })).statusCode).toBe(200);
    const pdf = (await upload('Q3 Report.pdf', fixture('report.pdf'), 'Reports')).json().file;
    let res = await app.inject({ method: 'POST', url: `/api/files/${pdf.id}/markdown`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ doc: { kind: 'markdown', title: 'Q3 Report', folder: 'Reports' }, pages: 2, ocrPages: [], warnings: [] });
    res = await app.inject({ method: 'GET', url: `/api/markdown/${res.json().doc.id}`, headers: { cookie } });
    expect(res.json().doc.text).toMatch(/^# Quarterly Report\n/);

    // Only the owner's PDFs, and only PDFs.
    const other = await signUp(app, box, 'other@example.com');
    expect((await app.inject({ method: 'POST', url: `/api/files/${pdf.id}/markdown`, headers: { cookie: other.cookie } })).statusCode).toBe(404);
    const page = (await app.inject({ method: 'POST', url: '/api/files', headers: { cookie, 'content-type': 'application/octet-stream', 'x-filename': 'page.html' }, payload: Buffer.from('<p>hi</p>') })).json().file;
    res = await app.inject({ method: 'POST', url: `/api/files/${page.id}/markdown`, headers: { cookie } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/not a PDF/);
    const locked = (await upload('Locked.pdf', fixture('locked.pdf'))).json().file;
    res = await app.inject({ method: 'POST', url: `/api/files/${locked.id}/markdown`, headers: { cookie } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/password-protected/);
  });
});
