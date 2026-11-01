import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from './app.ts';
import { pathOfFile } from './localMcp.ts';

const TOKEN = 'test-token-0123456789';
let dataDir: string;
let folder: string;
let app: Awaited<ReturnType<typeof buildApp>>;
let origin: string;
const shown: string[] = [];
const changed: string[] = [];
const inTab: string[] = [];
let elsewhere: string;

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'local-mcp-data-'));
  folder = mkdtempSync(path.join(tmpdir(), 'local-mcp-folder-'));
  writeFileSync(path.join(folder, 'notes.md'), '# Notes\n\nFirst line.\n');
  writeFileSync(path.join(folder, 'LICENSE'), 'MIT License\n\nCopyright (c) 2025 Someone\n');
  elsewhere = mkdtempSync(path.join(tmpdir(), 'local-mcp-elsewhere-'));
  writeFileSync(path.join(elsewhere, 'plan.md'), '# Plan\n');
  app = await buildApp({ dataDir, local: { dir: folder, openFileInTab: (file) => inTab.push(file), mcp: { token: TOKEN, show: (page) => shown.push(page), changed: (id) => changed.push(id) } } });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  origin = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(folder, { recursive: true, force: true });
  rmSync(elsewhere, { recursive: true, force: true });
});

async function connect(token = TOKEN): Promise<Client> {
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return client;
}

const text = (r: Awaited<ReturnType<Client['callTool']>>) => (r.content as { text?: string }[]).map((c) => c.text ?? '').join('');

describe("the desktop app's MCP server", () => {
  it('refuses a request without the token', async () => {
    const r = await fetch(`${origin}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    expect(r.status).toBe(401);
    await expect(connect('wrong-token')).rejects.toThrow();
  });

  it("works on the folder's files, and the window shows the file the model opens", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['list_files', 'open_file', 'read_doc', 'insert_content', 'write_range', 'create_folder', 'move_file', 'upload_file']));
    // And the tools only the window can run, here only.
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['render_slide', 'export_deck', 'select_range']));
    // Only the model's tools: none of the parts for ChatGPT's own app.
    expect(tools.map((t) => t.name)).not.toContain('app_state');

    // It is the desktop app's MCP Docs (mcp-docs), not the hosted one (universal-docs).
    expect(client.getServerVersion()).toMatchObject({ name: 'mcp-docs', title: 'MCP Docs' });
    expect(client.getInstructions()).toMatch(/^MCP Docs:/);
    const list = JSON.parse(text(await client.callTool({ name: 'list_files', arguments: {} })));
    const notes = (list.files as { id: string; kind: string; title: string }[]).find((f) => f.kind === 'markdown');
    expect(notes).toBeTruthy();

    await client.callTool({ name: 'open_file', arguments: { kind: 'markdown', id: notes!.id } });
    expect(shown.at(-1)).toBe(pathOfFile('markdown', notes!.id));

    // With no id, the tools act on the open file; the edit is the folder's file.
    const r = await client.callTool({ name: 'insert_content', arguments: { position: 'end', markdown: 'Added by an agent.' } });
    expect(r.isError).not.toBe(true);
    expect(readFileSync(path.join(folder, 'notes.md'), 'utf8')).toContain('Added by an agent.');
    await client.close();
  });

  it('opens a file by its path: in the folder as open_file does, anywhere else in a new tab on its folder', async () => {
    const client = await connect();
    for (const given of ['notes.md', path.join(folder, 'notes.md')]) {
      const r = await client.callTool({ name: 'open_path', arguments: { path: given } });
      expect(r.isError).not.toBe(true);
      expect(text(r)).toContain('Notes');
      expect(shown.at(-1)).toMatch(/^\/md\//);
    }
    // A stored file (plain text) too.
    const license = await client.callTool({ name: 'open_path', arguments: { path: 'LICENSE' } });
    expect(text(license)).toContain('MIT License');
    expect(shown.at(-1)).toMatch(/^\/f\//);

    const outside = await client.callTool({ name: 'open_path', arguments: { path: path.join(elsewhere, 'plan.md') } });
    expect(JSON.parse(text(outside))).toMatchObject({ opened_in_new_tab: true, folder: elsewhere });
    expect(inTab).toEqual([path.join(elsewhere, 'plan.md')]);

    const missing = await client.callTool({ name: 'open_path', arguments: { path: 'gone.md' } });
    expect(missing.isError).toBe(true);
    expect(text(missing)).toContain('There is no file at');
    await client.close();
  });

  it('acts on the file the window reports it shows', async () => {
    // Without a window token every request is the local user.
    const list = await app.inject({ method: 'GET', url: '/api/library' });
    const md = (list.json().docs as { id: string; kind: string }[]).find((d) => d.kind === 'markdown')!;
    await app.inject({ method: 'POST', url: '/api/local/showing', payload: {} });
    const client = await connect();
    const none = await client.callTool({ name: 'read_doc', arguments: {} });
    expect(none.isError).toBe(true);
    await app.inject({ method: 'POST', url: '/api/local/showing', payload: { kind: 'markdown', id: md.id } });
    const read = await client.callTool({ name: 'read_doc', arguments: {} });
    expect(read.isError).not.toBe(true);
    expect(text(read)).toContain('Notes');
    await client.close();
  });

  it('runs an edit on the file a window has open in that window, and answers with what the window did', async () => {
    const list = await app.inject({ method: 'GET', url: '/api/library' });
    const md = (list.json().docs as { id: string; kind: string }[]).find((d) => d.kind === 'markdown')!;
    const before = readFileSync(path.join(folder, 'notes.md'), 'utf8');

    // The window: takes calls as server-sent events.
    const stop = new AbortController();
    const res = await fetch(`${origin}/api/local/tool-calls?window=w1`, { signal: stop.signal });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const nextCall = async (): Promise<{ id: string; name: string; kind: string; fileId: string; input: Record<string, unknown> }> => {
      for (;;) {
        const end = buffer.indexOf('\n\n');
        if (end >= 0) {
          const event = /^data: (.*)$/m.exec(buffer.slice(0, end));
          buffer = buffer.slice(end + 2);
          if (event) return JSON.parse(event[1]);
          continue;
        }
        const { value, done } = await reader.read();
        if (done) throw new Error('The stream ended.');
        buffer += decoder.decode(value, { stream: true });
      }
    };
    await app.inject({ method: 'POST', url: '/api/local/showing', payload: { kind: 'markdown', id: md.id, window: 'w1' } });

    const client = await connect();
    try {
      const pending = client.callTool({ name: 'insert_content', arguments: { markdown: 'From the window.' } });
      const call = await nextCall();
      expect(call).toMatchObject({ name: 'insert_content', kind: 'markdown', fileId: md.id, input: { markdown: 'From the window.' } });
      const answered = await app.inject({ method: 'POST', url: `/api/local/tool-calls/${call.id}`, payload: { content: JSON.stringify({ inserted_blocks: 1 }), images: [{ mediaType: 'image/png', data: 'iVBORw0KGgo=' }] } });
      expect(answered.statusCode).toBe(200);
      const r = await pending;
      expect(r.isError).not.toBe(true);
      expect(JSON.parse(text(r))).toMatchObject({ doc_id: md.id, inserted_blocks: 1 });
      expect(r.content).toContainEqual({ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' });
      // The window made the change in its editor; the server did not write the file.
      expect(readFileSync(path.join(folder, 'notes.md'), 'utf8')).toBe(before);

      // A window that has moved on answers unavailable, and the server makes the change itself.
      const again = client.callTool({ name: 'insert_content', arguments: { markdown: 'Saved by the server.' } });
      const second = await nextCall();
      await app.inject({ method: 'POST', url: `/api/local/tool-calls/${second.id}`, payload: { unavailable: true } });
      expect((await again).isError).not.toBe(true);
      expect(readFileSync(path.join(folder, 'notes.md'), 'utf8')).toContain('Saved by the server.');
      expect((await app.inject({ method: 'POST', url: `/api/local/tool-calls/${second.id}`, payload: { content: 'late' } })).statusCode).toBe(404);
    } finally {
      stop.abort();
      await client.close();
    }
  });

  it('says to open the file first for a tool only the window can run', async () => {
    await app.inject({ method: 'POST', url: '/api/local/showing', payload: {} });
    const client = await connect();
    const r = await client.callTool({ name: 'render_slide', arguments: { slide: 1 } });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('Open one with open_file');
    await client.close();
  });

  it('edits a picture in the window, background removal included', async () => {
    // A 1×1 PNG.
    writeFileSync(path.join(folder, 'logo.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
    const client = await connect();
    const found = JSON.parse(text(await client.callTool({ name: 'search_files', arguments: { query: 'logo' } })));
    const logo = (found.files as { id: string; kind: string }[]).find((f) => f.kind === 'file')!;

    // No window: nothing to edit it with.
    const none = await client.callTool({ name: 'transform_image', arguments: { file_id: logo.id, remove_background: true } });
    expect(none.isError).toBe(true);
    expect(text(none)).toContain('window is not open');

    const stop = new AbortController();
    const res = await fetch(`${origin}/api/local/tool-calls?window=w2`, { signal: stop.signal });
    const reader = res.body!.getReader();
    let buffer = '';
    try {
      const pending = client.callTool({ name: 'transform_image', arguments: { file_id: logo.id, crop: { x: 0, y: 0, width: 1, height: 1 }, filter: 'grayscale', remove_background: true } });
      let call: { id: string; kind: string; fileId: string; name: string; input: { operations: { op: string }[]; save: string } } | null = null;
      while (!call) {
        const { value } = await reader.read();
        buffer += new TextDecoder().decode(value);
        const event = /^data: (.*)$/m.exec(buffer);
        if (event) call = JSON.parse(event[1]);
      }
      // After the crop, before the filter; saved as a copy.
      expect(call).toMatchObject({ kind: 'file', fileId: logo.id, name: 'transform_image', input: { save: 'copy' } });
      expect(call.input.operations.map((o) => o.op)).toEqual(['crop', 'remove_background', 'filter']);
      await app.inject({ method: 'POST', url: `/api/local/tool-calls/${call.id}`, payload: { content: JSON.stringify({ edited: true, file_id: 'copy1', image: 'Attached to this message.' }), images: [{ mediaType: 'image/png', data: 'iVBORw0KGgo=' }] } });
      const r = await pending;
      expect(r.isError).not.toBe(true);
      expect(JSON.parse(text(r))).toMatchObject({ edited: true, file_id: 'copy1', image: 'The picture comes with this result. Look at it before reporting back.' });
      expect(r.content).toContainEqual({ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' });

      // A picture put on top, with no save asked for, goes to the window with none, which opens the image editor
      // so the user can still move it; asked for a file, it is a copy as other edits are.
      buffer = '';
      const layered = client.callTool({ name: 'transform_image', arguments: { file_id: logo.id, overlays: [{ file_id: logo.id, x: 0, y: 0, width: 1, opacity: 50 }] } });
      let overlay: { id: string; input: Record<string, unknown> } | null = null;
      while (!overlay) {
        const { value } = await reader.read();
        buffer += new TextDecoder().decode(value);
        const event = /^data: (.*)$/m.exec(buffer);
        if (event) overlay = JSON.parse(event[1]);
      }
      expect(overlay.input).toEqual({ file_id: logo.id, operations: [{ op: 'overlay', source: logo.id, x: 0, y: 0, width: 1, opacity: 50 }] });
      await app.inject({ method: 'POST', url: `/api/local/tool-calls/${overlay.id}`, payload: { content: JSON.stringify({ edited: true, file_id: logo.id, saved: false }) } });
      expect(JSON.parse(text(await layered))).toMatchObject({ edited: true, saved: false });
    } finally {
      stop.abort();
      await client.close();
    }
  });

  it("edits a text file of the folder in place, and tells the window", async () => {
    const client = await connect();
    const found = JSON.parse(text(await client.callTool({ name: 'search_files', arguments: { query: 'LICENSE' } })));
    const license = (found.files as { id: string; kind: string }[]).find((f) => f.kind === 'file')!;
    const r = await client.callTool({ name: 'edit_file', arguments: { file_id: license.id, edits: [{ find: '2025 Someone', replace: '2026 Scott' }] } });
    expect(r.isError).not.toBe(true);
    expect(readFileSync(path.join(folder, 'LICENSE'), 'utf8')).toBe('MIT License\n\nCopyright (c) 2026 Scott\n');
    expect(changed).toEqual([license.id]);
    // The folder keeps no earlier version beside the file, so there is nothing to undo to.
    const undo = await client.callTool({ name: 'edit_file', arguments: { file_id: license.id, undo: true } });
    expect(undo.isError).toBe(true);
    expect(text(undo)).toContain('no earlier version');
    await client.close();
  });
});
