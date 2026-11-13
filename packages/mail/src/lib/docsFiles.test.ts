import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachedAs, dispositionName, docsFiles, exportFormat, type DocsFile } from './docsFiles';

const file = (over: Partial<DocsFile>): DocsFile => ({ kind: 'file', id: 'f1', name: 'x', folder: '', shared: false, ...over });

afterEach(() => vi.unstubAllGlobals());

describe('docsFiles', () => {
  it('attaches documents as Office files, and stored files as they are', () => {
    expect(exportFormat({ kind: 'doc' })).toBe('docx');
    expect(exportFormat({ kind: 'sheet' })).toBe('xlsx');
    expect(exportFormat({ kind: 'sheet', format: 'csv' })).toBe('csv');
    expect(exportFormat({ kind: 'deck' })).toBe('pptx');
    expect(exportFormat({ kind: 'markdown' })).toBe('md');
    expect(exportFormat({ kind: 'file' })).toBeNull();
    expect(attachedAs(file({ kind: 'doc', name: 'Plan' })).name).toBe('Plan.docx');
    expect(attachedAs(file({ kind: 'markdown', name: 'notes.md' })).name).toBe('notes.md');
    expect(attachedAs(file({ name: 'scan.pdf', type: 'application/pdf' }))).toEqual({ name: 'scan.pdf', type: 'application/pdf' });
  });

  it('reads the name a download gives', () => {
    expect(dispositionName(`attachment; filename="Q_ plan.docx"; filename*=UTF-8''Q%E2%80%99%20plan.docx`)).toBe('Q’ plan.docx');
    expect(dispositionName('attachment; filename="a.pdf"')).toBe('a.pdf');
    expect(dispositionName(null)).toBeNull();
  });

  it('searches My files and the organization’s files, once each', async () => {
    const asked: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      asked.push(url);
      const shared = url.includes('shared=1');
      const body = shared
        ? { docs: [{ id: 'd2', kind: 'sheet', title: 'Budget', folder: 'Finance', shared: true }], files: [] }
        : { docs: [{ id: 'd1', kind: 'doc', title: 'Plan' }], files: [{ id: 'f1', filename: 'scan.pdf', type: 'application/pdf', size: 10 }] };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const found = await docsFiles.search('pl', 'org1');
    expect(asked).toEqual(['/api/library/search?q=pl&workspace=org1', '/api/library/search?q=pl&workspace=org1&shared=1']);
    expect(found.map((f) => [f.name, f.kind, f.shared, f.folder])).toEqual([
      ['Budget', 'sheet', true, 'Finance'],
      ['Plan', 'doc', false, ''],
      ['scan.pdf', 'file', false, ''],
    ]);
  });

  it('fetches a document as its export and a stored file as its download', async () => {
    const asked: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      asked.push(url);
      return new Response('bytes', { status: 200, headers: { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="scan.pdf"' } });
    });
    await docsFiles.fetch(file({ kind: 'doc', id: 'd1', name: 'Plan' }));
    const got = await docsFiles.fetch(file({ id: 'f1', name: 'scan.pdf' }));
    expect(asked).toEqual(['/api/files/d1/export?format=docx', '/api/files/f1/download']);
    expect(got).toMatchObject({ name: 'scan.pdf', type: 'application/pdf' });
  });
});
