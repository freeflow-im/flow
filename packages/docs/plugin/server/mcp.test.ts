import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb } from '../../server/db.ts';
import { FileHub, type FileService } from './files.ts';
import { buildSlide, newId } from '../../shared/deck.ts';
import { buildPptx } from '../../shared/pptxExport.ts';
import { buildDocx } from '../../server/testing.ts';
import { appHtml, appUri, createMcpServer, instructionsFor, serverInfo, type McpVersion } from './mcp.ts';
import { readFileSync } from 'node:fs';
import { resolver } from '../../server/webFetch.ts';
import { closePdfReaders } from '../../server/pdfMarkdown.ts';

afterAll(closePdfReaders);

const APP_URI = appUri('abc');

/** Serves the test's Word and PowerPoint files at pretend ChatGPT download URLs. */
const attachments = new Map<string, Buffer>();
const fakeFetch: typeof fetch = async (input) => {
  const url = typeof input === 'string' ? input : (input as URL).toString();
  const bytes = attachments.get(url);
  return bytes ? new Response(new Uint8Array(bytes), { headers: { 'content-length': String(bytes.length) } }) : new Response('nope', { status: 404 });
};

const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

let dir: string;
let client: Client;
let svc: FileService;

const realLookup = resolver.lookup;

beforeEach(async () => {
  // The pretend download hosts are on the public internet; nothing is looked up for real.
  resolver.lookup = async (host) => (host === 'intranet.example' ? ['10.0.0.8'] : ['93.184.216.34']);
  dir = await mkdtemp(path.join(tmpdir(), 'docs-mcp-'));
  const db = openDb(path.join(dir, 'app.db'));
  db.prepare('INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)').run('u1', 'a@example.com', 'x', new Date().toISOString());
  const hub = new FileHub({ db, dataDir: dir, publicUrl: null });
  await hub.init();
  svc = hub.forUser('u1');
  client = await connect(1);
});

/** A client of the given version of the tools, on the same account. */
async function connect(version: McpVersion): Promise<Client> {
  const server = createMcpServer(svc, { bundle: () => ({ js: 'console.log(1)', css: '', hash: 'abc' }), publicUrl: null, fetchFn: fakeFetch, version });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const c = new Client({ name: 'test', version: '0' });
  await c.connect(b);
  return c;
}

afterEach(async () => {
  resolver.lookup = realLookup;
  await client.close();
  await rm(dir, { recursive: true, force: true });
});

const call = async (name: string, args: Record<string, unknown> = {}, on: Client = client) => {
  const r = await on.callTool({ name, arguments: args });
  return { isError: r.isError === true, data: r.structuredContent as Record<string, unknown> | undefined, text: (r.content as { text?: string }[]).map((c) => c.text ?? '').join('') };
};

const PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

describe('MCP server', () => {
  it('keeps version 1 exactly as submitted, and version 2 adds to it', async () => {
    // mcp-v1.json is version 1 as ChatGPT reviewed it. A change here needs a new version, not an edit to version 1.
    const submitted = JSON.parse(readFileSync(new URL('./mcp-v1.json', import.meta.url), 'utf8'));
    const { tools } = await client.listTools();
    expect({ server: client.getServerVersion(), instructions: client.getInstructions(), tools: JSON.parse(JSON.stringify(tools)) }).toEqual(submitted);
    const v2 = await connect(2);
    const newer = (await v2.listTools()).tools;
    expect(v2.getServerVersion()?.version).toBe('0.3.0');
    expect(v2.getInstructions()).toContain('read_file');
    const added = ['search_files', 'create_folder', 'move_file', 'upload_file', 'read_file', 'edit_file', 'convert_pdf_to_markdown', 'add_chart', 'edit_chart', 'delete_chart'];
    expect(newer.map((t) => t.name).filter((n) => !tools.some((t) => t.name === n))).toEqual(added);
    // Besides those, three tools differ: list_files knows about folders, transform_image puts pictures on top, and edit_elements places an arc by its own box or its center and radius.
    expect(newer.filter((t) => !added.includes(t.name) && JSON.stringify(t) !== JSON.stringify(tools.find((o) => o.name === t.name))).map((t) => t.name)).toEqual(['list_files', 'import_file', 'transform_image', 'edit_elements']);
    expect(newer.find((t) => t.name === 'transform_image')?.inputSchema.properties).toHaveProperty('overlays');
    expect(tools.find((t) => t.name === 'transform_image')?.inputSchema.properties).not.toHaveProperty('overlays');
    await v2.close();
  });

  it('keeps files in folders in version 2: makes them, moves files into them and lists one', async () => {
    const v2 = await connect(2);
    const doc = (await call('create_doc', { title: 'Plan' }, v2)).data!.file as { id: string };
    await call('create_sheet', { title: 'Budget' }, v2);
    expect((await call('create_folder', { path: 'Reports/2026' }, v2)).data).toEqual({ folder: { path: 'Reports/2026', created: true } });
    expect((await call('create_folder', { path: 'Reports' }, v2)).data).toEqual({ folder: { path: 'Reports', created: false } });
    expect((await call('create_folder', { path: 'a/../b' }, v2)).isError).toBe(true);

    expect((await call('move_file', { kind: 'doc', id: doc.id, folder: 'Reports/2026' }, v2)).data!.file).toMatchObject({ id: doc.id, folder: 'Reports/2026' });
    const missing = await call('move_file', { kind: 'doc', id: doc.id, folder: 'Nowhere' }, v2);
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain('create_folder');

    const all = (await call('list_files', {}, v2)).data!;
    // The folders listed are those directly in the one asked about (the top, here), not every folder.
    expect(all.folders).toEqual(['Reports']);
    expect((await call('list_files', { folder: 'Reports' }, v2)).data!.folders).toEqual(['Reports/2026']);
    expect((all.files as { title: string; folder: string }[]).map((f) => [f.title, f.folder]).sort()).toEqual([['Budget', ''], ['Plan', 'Reports/2026']]);
    const titles = async (folder: string) => ((await call('list_files', { folder }, v2)).data!.files as { title: string }[]).map((f) => f.title);
    expect(await titles('Reports/2026')).toEqual(['Plan']);
    expect(await titles('')).toEqual(['Budget']);
    expect(await titles('Reports')).toEqual([]);
    // Back to the top level.
    await call('move_file', { kind: 'doc', id: doc.id, folder: '' }, v2);
    expect((await titles('')).sort()).toEqual(['Budget', 'Plan']);
    // search_files finds by name in any folder, or under one folder.
    await call('move_file', { kind: 'doc', id: doc.id, folder: 'Reports/2026' }, v2);
    const found = (await call('search_files', { query: 'PLA' }, v2)).data!;
    expect((found.files as { title: string; folder: string }[]).map((f) => [f.title, f.folder])).toEqual([['Plan', 'Reports/2026']]);
    expect((await call('search_files', { query: 'report' }, v2)).data!.folders).toEqual(['Reports']);
    expect((await call('search_files', { query: 'Plan', folder: 'Reports' }, v2)).data!.files).toHaveLength(1);
    expect((await call('search_files', { query: 'Budget', folder: 'Reports' }, v2)).data!.files).toHaveLength(0);
    expect((await call('search_files', { query: 'Plan', kind: 'sheet' }, v2)).data!.files).toHaveLength(0);
    // Version 1 says nothing of folders, and this server has no public address to upload to.
    expect((await call('list_files')).data).not.toHaveProperty('folders');
    expect((await call('upload_file', { file_name: 'a.pdf' }, v2)).text).toContain('no public address');
    await v2.close();
  });

  it('places an arc by the box of its whole ellipse in version 1, and by its own box in version 2', async () => {
    await call('create_deck', { title: 'Arcs', slides: [{ title: 'Arcs' }] });
    const v2 = await connect(2);
    const arc = { type: 'shape', shape: 'arc', x: 100, y: 100, w: 200, h: 200, start_angle: 270, end_angle: 0, stroke_width: 2 };
    await call('edit_elements', { slide: 1, set: [arc] });
    await call('edit_elements', { slide: 1, set: [arc] }, v2);
    const arcs = ((await call('read_deck', { slides: [1] })).data?.slides as { elements: { shape?: string; x: number; y: number; w: number; h: number }[] }[])[0].elements.filter((e) => e.shape === 'arc');
    // The top-right quarter of a 200-wide circle, stroke included; in version 2 the box given is that box.
    expect(arcs.map(({ x, y, w, h }) => [x, y, w, h].map(Math.round))).toEqual([
      [199, 99, 102, 102],
      [100, 100, 200, 200],
    ]);
    await v2.close();
  });

  it('lists tools with the app entrypoint and hides app-only tools from the model', async () => {
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    expect(byName.docs_app._meta).toMatchObject({ ui: { resourceUri: APP_URI, visibility: ['app'] }, 'openai/ui': { entrypoints: [{ type: 'global' }, { type: 'thread' }] } });
    expect(byName.open_file._meta).toMatchObject({ ui: { resourceUri: APP_URI } });
    expect(byName.save_file._meta).toMatchObject({ ui: { visibility: ['app'] } });
    expect(byName.read_doc.annotations?.readOnlyHint).toBe(true);
    expect(byName.delete_blocks.annotations?.destructiveHint).toBe(true);
    expect(byName.delete_slides.annotations?.destructiveHint).toBe(true);
    expect(byName.read_doc.inputSchema.properties).toHaveProperty('doc_id');
    expect(byName.add_slides.inputSchema.properties).toHaveProperty('deck_id');
    expect(byName.write_range.inputSchema.properties).toHaveProperty('sheet_id');
    expect(byName.delete_rows.annotations?.destructiveHint).toBe(true);
    expect(byName).not.toHaveProperty('render_slide');
    expect(byName).not.toHaveProperty('select_range');
    // ChatGPT checks that every tool has annotations and typed properties.
    for (const t of tools) {
      expect(t.annotations, t.name).toMatchObject({ readOnlyHint: expect.any(Boolean), destructiveHint: expect.any(Boolean), openWorldHint: expect.any(Boolean) });
      for (const [k, v] of Object.entries((t.inputSchema.properties ?? {}) as Record<string, { type?: unknown }>)) expect(typeof v.type, `${t.name}.${k}`).toBe('string');
    }
  });

  it('references hosted assets when a public origin is set', () => {
    const html = appHtml({ js: 'x', css: 'y', hash: 'h1' }, 'https://docs.example.com');
    expect(html).toContain('src="https://docs.example.com/plugin/app.js?v=h1"');
    expect(html).toContain('href="https://docs.example.com/plugin/app.css?v=h1"');
    expect(html).not.toContain('<style>');
    expect(html).not.toContain('freeflow-url');
    const withApp = appHtml({ js: 'x', css: 'y', hash: 'h1' }, null, 'https://docs.example.com/');
    expect(withApp).toContain('<meta name="freeflow-url" content="https://docs.example.com/">');
    expect(withApp).toContain('<style>y</style>');
  });

  it('names the app resource after the bundle hash', () => {
    expect(appUri('h1')).toBe('ui://freeflow-docs/app-h1.html');
    // MCP Docs (id universal-docs) from version 2; version 1 keeps the name it was submitted under. The desktop app's is MCP Docs (mcp-docs).
    expect([serverInfo(1).name, serverInfo(2).name, serverInfo(2, true).name]).toEqual(['freeflow-docs', 'universal-docs', 'mcp-docs']);
    expect([serverInfo(2), serverInfo(2, true)].map((i) => ('title' in i ? i.title : null))).toEqual(['MCP Docs', 'MCP Docs']);
    expect([instructionsFor(1), instructionsFor(2), instructionsFor(2, true)].map((t) => t.split(':')[0])).toEqual(['Universal Docs', 'MCP Docs', 'MCP Docs']);
    expect(appUri('h2')).not.toBe(appUri('h1'));
  });

  it('serves the app as a UI resource', async () => {
    const r = await client.readResource({ uri: APP_URI });
    expect(r.contents[0].mimeType).toBe('text/html;profile=mcp-app');
    expect((r.contents[0] as { text: string }).text).toContain('console.log(1)');
    expect(r.contents[0]._meta).toMatchObject({ 'openai/ui': { preferredDisplayMode: 'inline' } });
  });

  it('serves the app under an earlier bundle hash, which a published app keeps', async () => {
    const earlier = appUri('4721026a6b');
    const r = await client.readResource({ uri: earlier });
    expect(r.contents[0].uri).toBe(earlier);
    expect((r.contents[0] as { text: string }).text).toContain('console.log(1)');
    expect((await client.listResources()).resources.map((x) => x.uri)).toEqual([APP_URI]);
  });

  it('edits the open document from the composer', async () => {
    const created = await call('create_doc', { title: 'Notes', markdown: 'Hello.\n' });
    expect((created.data?.open as { id: string }).id).toBe((created.data?.file as { id: string }).id);
    const ins = await call('insert_content', { markdown: 'World.' });
    expect(ins.data?.inserted_blocks).toEqual([2]);
    const read = await call('read_doc');
    expect((read.data?.blocks as { markdown: string }[]).map((b) => b.markdown)).toEqual(['Hello.', 'World.']);
    const state = await call('app_state');
    // The app keeps in step by the revision; the model's tools do not return revisions or dates.
    expect((state.data?.open as { rev: string }).rev).toMatch(/^\d{4}-/);
    expect(read.data).not.toHaveProperty('rev');
    expect(created.data?.open).not.toHaveProperty('rev');
    expect(created.data?.file).toEqual({ kind: 'doc', id: (created.data?.file as { id: string }).id, title: 'Notes' });
    expect(created.text).not.toMatch(/updated_at|"rev"/);
    const listed = (await call('list_files')).data?.files as Record<string, unknown>[];
    expect(Object.keys(listed[0]).sort()).toEqual(['id', 'kind', 'title']);
    const library = (await call('library_files')).data?.files as Record<string, unknown>[];
    expect(library[0]).toMatchObject({ id: listed[0].id, updated_at: expect.any(String), created_at: expect.any(String) });
  });

  it('creates a Markdown document and edits its text with the document tools', async () => {
    const text = '---\nname: universal-docs\ndescription: An overview.\n---\n\n# Universal Docs\n\nEdit **office** files.\n';
    const created = await call('create_doc', { title: 'SKILL.md', markdown: text, kind: 'markdown' });
    expect(created.data?.file).toMatchObject({ kind: 'markdown', title: 'SKILL.md' });
    expect(created.data?.open).toMatchObject({ kind: 'markdown' });
    const id = (created.data?.file as { id: string }).id;
    expect(((await call('list_files', { kind: 'markdown' })).data?.files as { id: string }[]).map((f) => f.id)).toEqual([id]);
    // Kept exactly as written, front matter included.
    const loaded = await call('get_file', { kind: 'markdown', id });
    expect((loaded.data?.data as { text: string }).text).toBe(text);

    // The cursor the app reported comes back with the outline, as for a document.
    await call('set_open_file', { kind: 'markdown', id, cursor_block: 2 });
    const read = await call('read_doc');
    expect(read.data).toMatchObject({ format: 'markdown', doc_id: id, cursor_block: 2 });
    expect((read.data?.blocks as { markdown: string }[]).map((b) => b.markdown)).toEqual(['---\nname: universal-docs\ndescription: An overview.\n---', '# Universal Docs', 'Edit **office** files.']);
    expect((await call('open_file', { kind: 'markdown', id })).data).toMatchObject({ format: 'markdown', block_count: 3 });

    expect((await call('replace_text', { find: 'office', replace: 'office and image' })).data?.replaced).toBe(1);
    expect((await call('insert_content', { doc_id: id, markdown: '- one\n- two' })).data?.block_count).toBe(4);
    const after = await call('get_file', { kind: 'markdown', id });
    expect((after.data?.data as { text: string }).text).toBe(`${text.replace('office', 'office and image')}\n- one\n- two\n`);
    expect((await call('app_state')).data?.open).toMatchObject({ kind: 'markdown', rev: after.data?.rev });

    // Formatting is the text: the tools for rich documents say so instead of acting.
    const refused = await call('format_text', { find: 'office', bold: true });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/Markdown document, whose formatting is its text/);

    // The app's editor saves the whole text, and a stale save is refused.
    const saved = await call('save_file', { kind: 'markdown', id, rev: after.data?.rev, data: { version: 1, text: '# Rewritten\n' } });
    expect(saved.isError).toBe(false);
    expect((await call('save_file', { kind: 'markdown', id, rev: after.data?.rev, data: { version: 1, text: 'stale' } })).data?.conflict).toBe(true);
    expect(((await call('read_doc')).data?.blocks as { markdown: string }[]).map((b) => b.markdown)).toEqual(['# Rewritten']);

    expect((await call('rename_file', { title: 'README.md' })).data?.file).toMatchObject({ kind: 'markdown', title: 'README.md' });
    expect((await call('delete_file', { kind: 'markdown', id })).isError).toBe(false);
    expect((await call('app_state')).data?.open).toBeNull();
  });

  it('edits a stored text file in version 2: find and replace, a whole new text, undo; not a picture', async () => {
    const v2 = await connect(2);
    const changed: string[] = [];
    svc.hub.onFileChanged = (_u, id) => changed.push(id);
    const notes = await svc.hub.files.create('u1', 'LICENSE', 'application/octet-stream', Buffer.from('MIT License\n\nCopyright (c) 2025 Someone\n'));
    expect((await call('read_doc', { doc_id: notes.id }, v2)).data).toMatchObject({ editable: true });

    const r = await call('edit_file', { file_id: notes.id, edits: [{ find: '2025 Someone', replace: '2026 Scott' }] }, v2);
    expect(r.data).toMatchObject({ edited: true, replacements: 1 });
    expect((await call('read_file', { file_id: notes.id }, v2)).data?.text).toBe('MIT License\n\nCopyright (c) 2026 Scott\n');
    expect(changed).toEqual([notes.id]);

    // All or nothing: one edit that does not match changes nothing.
    const missing = await call('edit_file', { file_id: notes.id, edits: [{ find: 'MIT', replace: 'BSD' }, { find: 'nowhere', replace: 'x' }] }, v2);
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain('read_doc');
    expect((await call('read_file', { file_id: notes.id }, v2)).data?.text).toContain('MIT License');
    expect((await call('edit_file', { file_id: notes.id, edits: [{ find: 'i', replace: 'I' }] }, v2)).text).toContain('occurs');

    await call('edit_file', { file_id: notes.id, content: 'Replaced.' }, v2);
    expect((await call('read_file', { file_id: notes.id }, v2)).data?.text).toBe('Replaced.');
    expect((await call('edit_file', { file_id: notes.id, undo: true }, v2)).data).toMatchObject({ undone: true });
    expect((await call('read_file', { file_id: notes.id }, v2)).data?.text).toContain('2026 Scott');
    expect((await call('edit_file', { file_id: notes.id }, v2)).text).toContain('exactly one');

    const picture = await svc.hub.files.create('u1', 'dot.png', 'image/png', Buffer.from(PNG_1X1, 'base64'));
    expect((await call('edit_file', { file_id: picture.id, content: 'x' }, v2)).text).toContain('not a text file');
    // Version 1 has no edit_file.
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain('edit_file');
    await v2.close();
  });

  it('makes a Markdown document of a PDF in version 2, beside it, and shows it', async () => {
    const v2 = await connect(2);
    const shown: string[] = [];
    svc.hub.onShow = (_u, page) => shown.push(page.id);
    svc.createFolder('Reports');
    const pdf = await svc.hub.files.create('u1', 'Q3 Report.pdf', 'application/pdf', readFileSync(path.join(import.meta.dirname, '../../server/fixtures/report.pdf')), 'Reports');
    const r = await call('convert_pdf_to_markdown', { file_id: pdf.id }, v2);
    expect(r.data).toMatchObject({ file: { kind: 'markdown', title: 'Q3 Report', folder: 'Reports' }, pdf: { id: pdf.id }, pages: 2, ocr_pages: [] });
    expect(r.data?.warnings).toBeUndefined();
    const doc = r.data?.file as { id: string };
    expect(shown).toEqual([doc.id]);
    expect(((await call('read_doc', { doc_id: doc.id }, v2)).data?.blocks as { markdown: string }[])[0].markdown).toBe('# Quarterly Report');
    // The open file when none is named; only PDFs.
    await call('open_file', { kind: 'file', id: pdf.id }, v2);
    const again = (await call('convert_pdf_to_markdown', {}, v2)).data?.file as { id: string; kind: string };
    expect(again.kind).toBe('markdown');
    expect(again.id).not.toBe(doc.id);
    const notes = await svc.hub.files.create('u1', 'notes.txt', 'text/plain', Buffer.from('hi'));
    expect((await call('convert_pdf_to_markdown', { file_id: notes.id }, v2)).text).toContain('not a PDF');
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain('convert_pdf_to_markdown');
    await v2.close();
  });

  it('reads stored files from version 2 on, and leaves version 1 as it was', async () => {
    const v2 = await connect(2);
    attachments.set('https://files.example/plan.html', Buffer.from('<html><head><title>Plan</title></head><body><p>Ship it.</p><script>x()</script></body></html>'));
    const imported = await call('import_file', { file: { download_url: 'https://files.example/plan.html', file_name: 'plan.html', file_id: 'f-plan' } });
    const id = (imported.data?.file as { id: string }).id;
    const opened = await call('open_file', { kind: 'file', id }, v2);
    expect(opened.data?.text_content).toMatchObject({ filename: 'plan.html', editable: true, block_count: 2, blocks: [{ n: 1, markdown: '# Plan' }, { n: 2, markdown: 'Ship it.' }] });
    // The open file, or one named by id.
    expect(((await call('read_doc', { from: 2 }, v2)).data?.blocks as { markdown: string }[]).map((b) => b.markdown)).toEqual(['Ship it.']);
    expect((await call('read_doc', { doc_id: id }, v2)).data?.block_count).toBe(2);
    expect((await call('insert_content', { markdown: 'More' }, v2)).text).toMatch(/changed with edit_file/);
    // read_file returns the file as it is: a web page's source, in parts when asked.
    const raw = await call('read_file', { file_id: id }, v2);
    const source = '<html><head><title>Plan</title></head><body><p>Ship it.</p><script>x()</script></body></html>';
    expect(raw.data).toMatchObject({ filename: 'plan.html', type: 'text/html', total_chars: source.length, offset: 0, text: source });
    expect((await call('read_file', { file_id: id, offset: 7, max_chars: 4 }, v2)).data).toMatchObject({ text: 'head', more: true, next_offset: 11 });
    expect((await call('read_file', { file_id: 'nope' }, v2)).isError).toBe(true);
    // A file with no text says why, and open_file still opens it.
    attachments.set('https://files.example/scan.pdf', Buffer.from('%PDF-1.7\n%%EOF'));
    const scan = (((await call('import_file', { file: { download_url: 'https://files.example/scan.pdf', file_name: 'scan.pdf', file_id: 'f-scan' } })).data?.file) as { id: string }).id;
    expect((await call('read_doc', { doc_id: scan }, v2)).text).toMatch(/could not be read/);
    // A PDF comes back whole, as an embedded resource with its bytes.
    const pdf = await v2.callTool({ name: 'read_file', arguments: { file_id: scan } });
    const parts = pdf.content as { type: string; resource?: { mimeType: string; blob: string; uri: string } }[];
    expect(parts.map((c) => c.type)).toEqual(['text', 'resource']);
    expect(parts[1].resource).toMatchObject({ mimeType: 'application/pdf', uri: expect.stringContaining(`/plugin/file/${scan}?t=`) });
    expect(Buffer.from(parts[1].resource!.blob, 'base64').toString()).toBe('%PDF-1.7\n%%EOF');
    const shown = await call('open_file', { kind: 'file', id: scan }, v2);
    expect(shown.isError).toBe(false);
    expect(shown.data?.text_content).toBeUndefined();
    // Version 1 (what ChatGPT reviewed): no read_file, and stored files are shown, not read.
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain('read_file');
    expect((await call('open_file', { kind: 'file', id })).data?.text_content).toBeUndefined();
    expect((await call('read_doc', { doc_id: id })).isError).toBe(true);
    await v2.close();
    await call('delete_file', { kind: 'file', id });
    await call('delete_file', { kind: 'file', id: scan });
  });

  it('creates and edits a presentation, and keeps the kinds apart', async () => {
    const created = await call('create_deck', { title: 'Pitch', slides: [{ title: 'Pitch' }, { title: 'Problem', body: ['Slow'] }] });
    expect(created.isError).toBe(false);
    expect((created.data?.open as { kind: string }).kind).toBe('deck');
    const noDoc = await call('read_doc');
    expect(noDoc.isError).toBe(true);
    const added = await call('add_slides', { slides: [{ title: 'Solution', body: ['Fast'] }] });
    expect(added.isError).toBe(false);
    const outline = await call('read_deck');
    expect(outline.data?.slide_count).toBe(3);
    const files = await call('list_files', { kind: 'deck' });
    expect((files.data?.files as { title: string }[]).map((f) => f.title)).toEqual(['Pitch']);
  });

  it('creates and edits a spreadsheet from the composer', async () => {
    const created = await call('create_sheet', { title: 'Budget' });
    expect(created.isError).toBe(false);
    expect((created.data?.open as { kind: string }).kind).toBe('sheet');
    const noDeck = await call('read_deck');
    expect(noDeck.isError).toBe(true);
    const wrote = await call('write_range', { start: 'A1', rows: [['a', 1], ['b', 2], ['sum', '=SUM(B1:B2)']] });
    expect(wrote.isError).toBe(false);
    const read = await call('read_range', { range: 'A1:B3' });
    expect((read.data?.values as string[][])[2]).toEqual(['sum', '3']);
    const opened = await call('open_file', { kind: 'sheet', id: (created.data?.file as { id: string }).id });
    expect((opened.data?.tabs as unknown[]).length).toBe(1);
    const files = await call('list_files', { kind: 'sheet' });
    expect((files.data?.files as { title: string }[]).map((f) => f.title)).toEqual(['Budget']);
  });

  it('imports Word, PowerPoint, CSV and Markdown files the user attached, and refuses other things', async () => {
    const { tools } = await client.listTools();
    expect(tools.find((t) => t.name === 'import_file')?._meta).toMatchObject({ 'openai/fileParams': ['file'] });
    attachments.set('https://files.example/brief.docx', await buildDocx('<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>From Word</w:t></w:r></w:p><w:p><w:r><w:t>Body.</w:t></w:r></w:p>'));
    const doc = await call('import_file', { file: { download_url: 'https://files.example/brief.docx', file_id: 'f1', file_name: 'brief.docx' } });
    expect(doc.isError).toBe(false);
    expect(doc.data?.file).toMatchObject({ kind: 'doc', title: 'brief' });
    const read = await call('read_doc');
    expect((read.data?.blocks as { markdown: string }[])[0].markdown).toMatch(/^# .*From Word/);
    const { pres } = await buildPptx({ version: 1, theme: 'light', slides: [buildSlide('title-body', { title: 'From PowerPoint', body: ['One', 'Two'] }, newId)] }, 'x', async () => null);
    attachments.set('https://files.example/deck.pptx', Buffer.from((await pres.write({ outputType: 'nodebuffer' })) as Buffer));
    const deck = await call('import_file', { file: { file_id: 'file_1', download_url: 'https://files.example/deck.pptx' }, title: 'Pitch' });
    expect(deck.data?.file).toMatchObject({ kind: 'deck', title: 'Pitch' });
    expect((deck.data?.open as { kind: string }).kind).toBe('deck');
    // A CSV file stays a CSV file (a spreadsheet), and a Markdown file becomes a document; both go by their name.
    attachments.set('https://files.example/sales.csv', Buffer.from('\uFEFFregion,total\nEMEA,12\n"APAC, south",7\n'));
    const csv = await call('import_file', { file: { file_id: 'file_1', download_url: 'https://files.example/sales.csv', file_name: 'sales.csv' } });
    expect(csv.isError).toBe(false);
    expect(csv.data?.file).toMatchObject({ kind: 'sheet', title: 'sales' });
    expect((await call('read_range', { range: 'A1:B3' })).data?.values).toEqual([['region', 'total'], ['EMEA', '12'], ['APAC, south', '7']]);
    attachments.set('https://files.example/notes.md', Buffer.from('# Notes\n\n- one\n- two\n'));
    const md = await call('import_file', { file: { file_id: 'file_1', download_url: 'https://files.example/notes.md', file_name: 'notes.md' } });
    // A Markdown file stays one, with its text as it was; the document tools read and change that text.
    expect(md.data?.file).toMatchObject({ kind: 'markdown', title: 'Notes' });
    expect(md.data?.open).toMatchObject({ kind: 'markdown' });
    const mdId = (md.data?.file as { id: string }).id;
    expect(((await call('get_file', { kind: 'markdown', id: mdId })).data?.data as { text: string }).text).toBe('# Notes\n\n- one\n- two\n');
    expect(((await call('read_doc')).data?.blocks as { markdown: string }[])[0].markdown).toBe('# Notes');
    attachments.set('https://files.example/binary.csv', Buffer.from([0x50, 0x00, 0x01, 0x02]));
    expect((await call('import_file', { file: { file_id: 'file_1', download_url: 'https://files.example/binary.csv', file_name: 'binary.csv' } })).text).toMatch(/not a text file/);
    // A PDF or a video is stored as it is: listed and opened as a file, with a link for the app's viewer.
    attachments.set('https://files.example/report.pdf', Buffer.from('%PDF-1.7\n%%EOF'));
    const pdf = await call('import_file', { file: { file_id: 'file_1', download_url: 'https://files.example/report.pdf', file_name: 'report.pdf' } });
    expect(pdf.data?.file).toMatchObject({ kind: 'file', title: 'report.pdf', type: 'application/pdf' });
    expect((pdf.data?.open as { kind: string }).kind).toBe('file');
    const pdfId = (pdf.data?.file as { id: string }).id;
    expect(((await call('list_files', { kind: 'file' })).data?.files as { title: string }[]).map((f) => f.title)).toEqual(['report.pdf']);
    expect((await call('open_file', { kind: 'file', id: pdfId })).data?.file).toMatchObject({ title: 'report.pdf' });
    expect((await call('file_link', { id: pdfId })).data?.url).toMatch(new RegExp(`/plugin/file/${pdfId}\\?t=`));
    expect((await call('rename_file', { title: 'New name' })).data?.file).toMatchObject({ kind: 'file', id: pdfId, title: 'New name.pdf' });
    expect((await call('read_doc')).isError).toBe(true);
    expect((await call('delete_file', { kind: 'file', id: pdfId })).isError).toBe(false);
    expect((await call('list_files', { kind: 'file' })).data?.files).toEqual([]);
    // An image is a file of its own too (told by its bytes), not a document with a picture in it.
    attachments.set('https://files.example/photo', Buffer.from(PNG_BASE64, 'base64'));
    const img = await call('import_file', { file: { file_id: 'file_1', download_url: 'https://files.example/photo', file_name: 'photo' } });
    expect(img.data?.file).toMatchObject({ kind: 'file', title: 'photo.png', type: 'image/png' });
    // A file at a web address is imported the same way, named by its address, and opened.
    attachments.set('https://dogs.example/pics/golden-retriever.png', Buffer.from(PNG_BASE64, 'base64'));
    const web = await call('import_file', { url: 'https://dogs.example/pics/golden-retriever.png' });
    expect(web.data?.file).toMatchObject({ kind: 'file', title: 'golden-retriever.png', type: 'image/png' });
    expect(web.data?.open).toMatchObject({ kind: 'file', title: 'golden-retriever.png' });
    expect((await call('import_file', { url: 'https://dogs.example/pics/golden-retriever.png', title: 'Rex' })).data?.file).toMatchObject({ title: 'Rex.png' });
    // Not from a private network, whatever the name; and one source at a time.
    expect((await call('import_file', { url: 'https://intranet.example/a.png' })).text).toMatch(/public https/);
    expect((await call('import_file', { url: 'http://dogs.example/pics/golden-retriever.png' })).text).toMatch(/public https/);
    expect((await call('import_file', {})).text).toMatch(/either file .* or url/);
    expect((await call('import_file', { url: 'https://dogs.example/x.png', file: { file_id: 'file_1', download_url: 'https://files.example/photo' } })).text).toMatch(/either file .* or url/);
    expect(((await call('list_files', { kind: 'doc' })).data?.files as unknown[]).length).toBe(1);
    expect(((await call('list_files', { kind: 'markdown' })).data?.files as unknown[]).length).toBe(1);
    // The model can look at a picture: its size in pixels, and the picture itself.
    const imgId = (img.data!.file as { id: string }).id;
    const seen = await client.callTool({ name: 'view_image', arguments: { file_id: imgId } });
    expect(seen.structuredContent).toMatchObject({ file_id: imgId, filename: 'photo.png', type: 'image/png', width: 1, height: 1 });
    expect((seen.content as { type: string; mimeType?: string }[]).map((c) => `${c.type}${c.mimeType ? `:${c.mimeType}` : ''}`)).toEqual(['text', 'image:image/png']);
    const v2 = await connect(2);
    const rawImage = await v2.callTool({ name: 'read_file', arguments: { file_id: imgId } });
    await v2.close();
    expect((rawImage.content as { type: string; mimeType?: string }[]).map((c) => `${c.type}${c.mimeType ? `:${c.mimeType}` : ''}`)).toEqual(['text', 'image:image/png']);
    // An exact edit is done by the app: it takes the job with its state, edits, saves, and answers.
    const editing = call('transform_image', { file_id: imgId, rotate: 90 });
    let jobs: { id: string; file_id: string; operations: unknown[]; save: string }[] | undefined;
    for (let i = 0; i < 50 && !jobs; i++) {
      await new Promise((r) => setTimeout(r, 10));
      jobs = (await call('app_state')).data?.jobs as typeof jobs;
    }
    expect(jobs).toMatchObject([{ file_id: imgId, operations: [{ op: 'rotate', degrees: 90 }], save: 'copy' }]);
    const copy = await svc.importFile(Buffer.from(PNG_BASE64, 'base64'), 'photo-edited.png', undefined);
    expect((await call('image_job_result', { job_id: jobs![0].id, ok: true, applied: ['Rotated 90° (now 1 × 1)'], width: 1, height: 1, file_id: copy.file.id, saved: true })).data).toEqual({ taken: true });
    const edited = await editing;
    expect(edited.data).toMatchObject({ edited: true, file_id: copy.file.id, filename: 'photo-edited.png', source_file_id: imgId, applied: ['Rotated 90° (now 1 × 1)'], size: { width: 1, height: 1 }, saved: true, note: expect.stringContaining('original is unchanged') });
    // What the app could not do comes back as an error the model can act on.
    const failing = call('transform_image', { file_id: imgId, crop: { x: 9, y: 9, width: 5, height: 5 }, save: 'replace' });
    let failed: typeof jobs;
    for (let i = 0; i < 50 && !failed; i++) {
      await new Promise((r) => setTimeout(r, 10));
      failed = (await call('app_state')).data?.jobs as typeof jobs;
    }
    expect(failed![0].save).toBe('replace');
    await call('image_job_result', { job_id: failed![0].id, ok: false, error: 'Operation 1 (crop): That rectangle is outside the picture, which is 1 × 1 pixels at this point.' });
    expect(await failing).toMatchObject({ isError: true, text: expect.stringContaining('outside the picture') });
    expect((await call('transform_image', { file_id: 'nope', flip: 'horizontal' })).text).toMatch(/no file nope/);
    // Version 2 puts pictures on top: an overlay operation for the app, with the picture by its file id.
    const v2edit = await connect(2);
    const overlaying = call('transform_image', { file_id: imgId, overlays: [{ file_id: imgId, x: 0, y: 0, width: 1 }] }, v2edit);
    let overlayJobs: typeof jobs;
    for (let i = 0; i < 50 && !overlayJobs; i++) {
      await new Promise((r) => setTimeout(r, 10));
      overlayJobs = (await call('app_state')).data?.jobs as typeof jobs;
    }
    expect(overlayJobs).toMatchObject([{ file_id: imgId, operations: [{ op: 'overlay', source: imgId, x: 0, y: 0, width: 1 }], save: 'copy' }]);
    await call('image_job_result', { job_id: overlayJobs![0].id, ok: true, applied: ['Put a picture on top at 0, 0, 1 × 1'], file_id: copy.file.id, saved: true });
    expect((await overlaying).data).toMatchObject({ edited: true, applied: ['Put a picture on top at 0, 0, 1 × 1'] });
    await v2edit.close();
    // Removing a background is for the full app: said at once, with nothing handed to the app and nothing changed.
    const noRemoval = await call('transform_image', { file_id: imgId, rotate: 90, remove_background: true });
    expect(noRemoval).toMatchObject({ isError: true, text: expect.stringMatching(/only available in the full MCP Docs app.*Nothing was changed/) });
    expect((await call('app_state')).data?.jobs).toBeUndefined();
    expect((await call('transform_image', { file_id: imgId })).text).toMatch(/at least one change/);
    // The app's own tools are not offered to the model.
    const offered = (await client.listTools()).tools;
    expect(offered.find((t) => t.name === 'image_job_result')?._meta).toMatchObject({ ui: { visibility: ['app'] } });
    expect(offered.find((t) => t.name === 'transform_image')?._meta?.ui).toBeUndefined();
    expect(offered.find((t) => t.name === 'transform_image')?.inputSchema.properties).not.toHaveProperty('operations');
    // A web page is stored as it is, by its name or by how it starts.
    attachments.set('https://files.example/chart.html', Buffer.from('<h1>Chart</h1><script>document.title = 1</script>'));
    const html = await call('import_file', { file: { file_id: 'file_1', download_url: 'https://files.example/chart.html', file_name: 'chart.html' } });
    expect(html.data?.file).toMatchObject({ kind: 'file', title: 'chart.html', type: 'text/html' });
    attachments.set('https://files.example/page', Buffer.from('\n<!DOCTYPE html><html><body>Hi</body></html>'));
    expect((await call('import_file', { file: { file_id: 'file_1', download_url: 'https://files.example/page' }, title: 'Report' })).data?.file).toMatchObject({ kind: 'file', title: 'Report.html', type: 'text/html' });
    // Any other plain text (a YAML file, say) is stored as it is, to edit as text; other bytes are refused.
    attachments.set('https://files.example/manifest.yaml', Buffer.from('name: app\n'));
    const yaml = await call('import_file', { file: { file_id: 'file_1', download_url: 'https://files.example/manifest.yaml', file_name: 'manifest.yaml' } });
    expect(yaml.data?.file).toMatchObject({ kind: 'file', title: 'manifest.yaml' });
    attachments.set('https://files.example/blob.bin', Buffer.from([0, 1, 2, 0xff]));
    const bin = await call('import_file', { file: { file_id: 'file_1', download_url: 'https://files.example/blob.bin', file_name: 'blob.bin' } });
    expect(bin.isError).toBe(true);
    expect(bin.text).toMatch(/Only Word documents/);
    const local = await call('import_file', { file: { file_id: 'file_1', download_url: 'http://127.0.0.1/secret' } });
    expect(local.text).toMatch(/public https/);
    const missing = await call('import_file', { file: { file_id: 'file_1', download_url: 'https://files.example/gone.docx' } });
    expect(missing.text).toMatch(/404/);
  });

  it('puts an attached image into a cell or a document', async () => {
    const { tools } = await client.listTools();
    const cell = tools.find((t) => t.name === 'set_cell_image')!;
    expect(cell._meta).toMatchObject({ 'openai/fileParams': ['file'] });
    expect(cell.inputSchema.required ?? []).not.toContain('url');
    attachments.set('https://files.example/cat.png', Buffer.from(PNG_1X1, 'base64'));
    await call('create_sheet', { title: 'Pics' });
    const put = await call('set_cell_image', { range: 'B2', file: { file_id: 'file_1', download_url: 'https://files.example/cat.png', mime_type: 'application/octet-stream' } });
    expect(put.isError, put.text).toBe(false);
    expect(put.data?.image_in).toBe('Sheet1!B2');
    const read = await call('read_range', { range: 'B2' });
    expect((read.data?.values as string[][])[0][0]).toBe('[image]');
    // A web address is fetched and stored too, so the cell points at this server, not the web.
    const fromWeb = await call('set_cell_image', { range: 'C2', url: 'https://files.example/cat.png' });
    expect(fromWeb.isError, fromWeb.text).toBe(false);
    const stored = await svc.sheets.load('u1', (fromWeb.data?.sheet_id as string));
    expect(stored!.workbook.tabs[0].cells.C2.img).toMatch(/^\/api\/images\//);
    attachments.set('https://files.example/page.html', Buffer.from('<html>not an image</html>'));
    const page = await call('set_cell_image', { range: 'C3', url: 'https://files.example/page.html' });
    expect(page.isError).toBe(true);
    expect(page.text).toMatch(/not of a page/);
    const neither = await call('set_cell_image', { range: 'B3' });
    expect(neither.isError).toBe(true);
    expect(neither.text).toMatch(/attach the image/);
    attachments.set('https://files.example/notes.txt', Buffer.from('plain text'));
    const notImage = await call('set_cell_image', { range: 'B3', file: { file_id: 'file_1', download_url: 'https://files.example/notes.txt' } });
    expect(notImage.text).toMatch(/PNG, JPEG, GIF or WebP/);

    await call('create_doc', { title: 'Album', markdown: 'Cats.\n' });
    const inserted = await call('insert_image', { after: 1, file: { file_id: 'file_1', download_url: 'https://files.example/cat.png' } });
    expect(inserted.isError, inserted.text).toBe(false);
    const doc = await call('read_doc');
    expect((doc.data?.blocks as { markdown: string }[])[1].markdown).toMatch(/^!\[.*\]\(\/api\/images\//);
  });

  it('returns an error result, not a crash, for bad input', async () => {
    const r = await call('read_doc', { doc_id: 'missing' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/no document/);
    const none = await call('insert_content', { markdown: 'x' });
    expect(none.isError).toBe(true);
    expect(none.text).toMatch(/No document is open/);
    const noDeck = await call('add_slides', { slides: [{ title: 'x' }] });
    expect(noDeck.text).toMatch(/No presentation is open/);
  });

  it('saves from the editor with revision checks', async () => {
    const created = await call('create_doc', { title: 'Notes', markdown: 'Hello.\n' });
    const id = (created.data?.file as { id: string }).id;
    const got = await call('get_file', { kind: 'doc', id });
    await new Promise((r) => setTimeout(r, 5));
    await call('replace_text', { find: 'Hello', replace: 'Hi' });
    const stale = await call('save_file', { kind: 'doc', id, rev: got.data?.rev, data: got.data?.data });
    expect(stale.isError).toBe(true);
    expect(stale.data).toMatchObject({ conflict: true });
    const fresh = await call('get_file', { kind: 'doc', id });
    const saved = await call('save_file', { kind: 'doc', id, rev: fresh.data?.rev, data: fresh.data?.data });
    expect(saved.isError).toBe(false);
  });
});
