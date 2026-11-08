// Docs' server tools over HTTP (docsTools.ts), as the Assistant object runs them, against a stand-in Docs API: each asks the
// route the Docs client would, in the chat's root, and answers what the in-process tool answered; a refusal Docs explains
// (4xx) is the model's to read, anything else fails the turn.
import { describe, expect, it } from 'vitest';
import { ToolFailure, type ServerToolEnv } from '../docs/server/agent/tools.ts';
import { docsToolContext, type DocsFetch, type DocsPlace } from './docsTools';

type Route = (req: Request, body: unknown) => Response | Promise<Response>;

function fake(routes: Record<string, Route>) {
  const calls: string[] = [];
  const fetch: DocsFetch = async (path, init) => {
    const req = new Request(`https://app.test${path}`, init);
    const url = new URL(req.url);
    calls.push(`${req.method} ${url.pathname}${url.search}`);
    const type = req.headers.get('content-type') ?? '';
    const body = req.method === 'GET' ? undefined : type.includes('json') ? await req.json() : new Uint8Array(await req.arrayBuffer());
    const route = routes[`${req.method} ${url.pathname}`];
    return route ? route(req, body) : Response.json({ error: 'Not found' }, { status: 404 });
  };
  return { calls, fetch };
}

const MY_FILES: DocsPlace = { workspace: 'org-1', shared: false };
const ORG_FILES: DocsPlace = { workspace: 'org-1', shared: true };
const env = (context: ServerToolEnv['context'] = { page: 'home' }) => ({ userId: 'user-1', context, sheets: undefined as never }) as ServerToolEnv;
const run = (f: ReturnType<typeof fake>, place: DocsPlace, name: string, input: Record<string, unknown>, context?: ServerToolEnv['context']) => {
  const e = env(context);
  e.docs = docsToolContext(f.fetch, place);
  return e.docs.run(name, input, e).then((s) => JSON.parse(s) as Record<string, any>);
};

describe('Docs tools over HTTP', () => {
  it('reads another spreadsheet with computed values, from its JSON', async () => {
    const workbook = { version: 1, tabs: [{ id: 't', name: 'Data', rows: 10, cols: 5, cells: { A1: { v: '2' }, A2: { v: '3' }, A3: { v: '=A1*A2' } }, colWidths: {}, rowHeights: {} }] };
    const f = fake({ 'GET /api/sheets/s1': () => Response.json({ sheet: { id: 's1', title: 'Numbers' }, workbook }) });
    expect(await run(f, MY_FILES, 'read_other_sheet', { sheet_id: 's1', range: 'Data!A1:A3' })).toMatchObject({ title: 'Numbers', values: [['2'], ['3'], ['6']] });
    await expect(run(f, MY_FILES, 'read_other_sheet', { sheet_id: 'nope' })).rejects.toThrow(new ToolFailure('No spreadsheet with id "nope". Use list_sheets to find ids.'));
    // The open one is read in the browser, where the unsaved edits are; nothing is asked of Docs.
    await expect(run(f, MY_FILES, 'read_other_sheet', { sheet_id: 's1' }, { page: 'sheet', sheetId: 's1' } as never)).rejects.toThrow(/open right now/);
    expect(f.calls).toEqual(['GET /api/sheets/s1', 'GET /api/sheets/nope']);
  });

  it('lists and makes files in the chat’s root, and reads a Markdown document when it is no rich one', async () => {
    const f = fake({
      'GET /api/sheets': () => Response.json({ sheets: [{ id: 's1', title: 'Budget', updatedAt: '2026-11-01' }] }),
      'POST /api/markdown': (_r, body) => Response.json({ doc: { id: 'm1', kind: 'markdown', title: (body as { title: string }).title } }),
      'GET /api/markdown/m1': () => Response.json({ meta: { title: 'Notes' }, doc: { text: '# Notes\n\nHello' } }),
    });
    expect(await run(f, ORG_FILES, 'list_sheets', { query: 'bud' })).toEqual({ total: 1, sheets: [{ id: 's1', title: 'Budget', updated_at: '2026-11-01' }] });
    expect(await run(f, ORG_FILES, 'create_doc', { title: ' Notes ', kind: 'markdown', markdown: '# Notes\n\nHello' })).toMatchObject({ id: 'm1', kind: 'markdown', title: 'Notes', block_count: 2 });
    expect(await run(f, ORG_FILES, 'read_other_doc', { doc_id: 'm1' })).toMatchObject({ title: 'Notes', format: 'markdown' });
    await expect(run(f, ORG_FILES, 'read_other_doc', { doc_id: 'gone' })).rejects.toThrow(new ToolFailure('No document with id "gone". Use list_docs to find ids.'));
    expect(f.calls).toEqual([
      'GET /api/sheets?workspace=org-1&shared=1',
      'POST /api/markdown?workspace=org-1&shared=1',
      'GET /api/docs/m1',
      'GET /api/markdown/m1',
      'GET /api/docs/gone',
      'GET /api/markdown/gone',
    ]);
  });

  it('imports a picture the user attached from where it is stored, into their files', async () => {
    const id = '0b6ad0c2-3d0e-4b4e-9a53-2b8c1f0e9a11';
    let got: Uint8Array | null = null;
    const f = fake({
      [`GET /api/images/${id}`]: () => new Response(new Uint8Array([137, 80, 78, 71])),
      'POST /api/import/bytes': (_r, body) => { got = body as Uint8Array; return Response.json({ file: { id: 'f1', filename: 'Logo.png', type: 'image/png', size: 4 }, warnings: [] }); },
    });
    expect(await run(f, MY_FILES, 'import_file', { url: `https://app.test/api/images/${id}`, title: 'Logo' })).toMatchObject({ imported: true, kind: 'file', file_id: 'f1', type: 'image/png' });
    expect([...got!]).toEqual([137, 80, 78, 71]);
    // The name is the title (webImportName), as in-process.
    expect(f.calls[1]).toBe('POST /api/import/bytes?workspace=org-1&filename=Logo&title=Logo');
  });

  it('turns Docs’ refusals into what the model reads, and anything else into a failed turn', async () => {
    const f = fake({
      'POST /api/files/f1/pdf': () => Response.json({ error: 'This file cannot be printed.' }, { status: 400 }),
      'POST /api/files/f2/markdown': () => Response.json({ error: 'Something went wrong on the server' }, { status: 500 }),
      'POST /api/connections/c1/fetch': () => Response.json({ error: 'That connection needs to be signed in again.' }, { status: 400 }),
      'GET /api/connections': () => Response.json({ connections: [{ id: 'c1', connector: 'stripe', name: 'Shop', status: 'connected', lastUsedAt: '2026-11-01' }] }),
      'GET /api/connectors': () => Response.json({ connectors: [{ id: 'stripe', name: 'Stripe', datasets: ['charges'], auth: 'x' }] }),
    });
    await expect(run(f, MY_FILES, 'export_pdf', { file_id: 'f1' })).rejects.toThrow(new ToolFailure('This file cannot be printed.'));
    await expect(run(f, MY_FILES, 'export_pdf', { file_id: 'f9' })).rejects.toThrow(new ToolFailure('There is no file f9.'));
    const failed = await run(f, MY_FILES, 'convert_pdf', {}, { page: 'file', fileId: 'f2' } as never).catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(Error);
    expect(failed).not.toBeInstanceOf(ToolFailure);
    await expect(run(f, MY_FILES, 'fetch_connector_data', { connection_id: 'c1', dataset: 'charges' })).rejects.toThrow(new ToolFailure('That connection needs to be signed in again.'));
    expect(await run(f, MY_FILES, 'list_connections', {})).toEqual({
      connections: [{ id: 'c1', connector: 'stripe', name: 'Shop', status: 'connected', last_used_at: '2026-11-01' }],
      connectors: [{ id: 'stripe', name: 'Stripe', datasets: ['charges'] }],
    });
  });
});
