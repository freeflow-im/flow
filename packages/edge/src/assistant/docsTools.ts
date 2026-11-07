// Docs' server tools as the Assistant object runs them (platform.md §5.5): against the organization's Docs object over its
// HTTP API, as the person, where docs/server/agent/tools.ts' runDocsTool calls the stores in its own process. Each one
// answers what runDocsTool answers; what touches no store (web_search, image_search) runs there as it is.
import { docOutline } from '../docs/shared/agent/docRead.ts';
import { markdownBlocks, markdownOutline } from '../docs/shared/agent/markdownBlocks.ts';
import { readRange, resolveRange, sheetOverview } from '../docs/shared/agent/sheetRead.ts';
import { buildSlide, newId, type Deck } from '../docs/shared/deck.ts';
import { docNode } from '../docs/shared/doc.ts';
import { markdownToDoc } from '../docs/shared/docMarkdown.ts';
import { Engine } from '../docs/shared/formula/engine.ts';
import { STORED_IMAGE_RE } from '../docs/shared/types.ts';
import { checkSearchRate, runDocsTool, ToolFailure, type ServerToolEnv } from '../docs/server/agent/tools.ts';
import { importLimit, webImportName } from '../docs/server/importFile.ts';
import { fetchPublicFile, WebFetchError } from '../docs/server/webFetch.ts';

/** A Docs object's HTTP API (/api/*), as one person in one organization: the paths are the Docs client's. */
export type DocsFetch = (path: string, init?: RequestInit) => Promise<Response>;

/** The root the tools list and make files in: the organization's files (`shared`) or the person's own there. */
export interface DocsPlace { workspace: string; shared: boolean }

/** What the registry's Docs runners use in the Assistant object (ServerToolEnv.docs). */
export interface DocsToolContext {
  fetch: DocsFetch;
  place: DocsPlace;
  run(name: string, input: Record<string, unknown>, env: ServerToolEnv): Promise<string>;
}

export function docsToolContext(fetch: DocsFetch, place: DocsPlace): DocsToolContext {
  return { fetch, place, run: (name, input, env) => runDocsToolByHttp(name, input, env, fetch, place) };
}

/** `?workspace=<id>[&shared=1]`, the root as Docs' routes read it (requireUser's scopeNamed). */
export const placeQuery = (p: DocsPlace): string => `workspace=${encodeURIComponent(p.workspace)}${p.shared ? '&shared=1' : ''}`;

interface Answer { status: number; data: Record<string, any> }

async function call(docs: DocsFetch, method: string, path: string, body?: unknown): Promise<Answer> {
  const init: RequestInit =
    body instanceof Uint8Array
      ? { method, body: body as unknown as BodyInit, headers: { 'content-type': 'application/octet-stream' } }
      : body !== undefined
        ? { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }
        : { method };
  const res = await docs(path, init);
  const data = (await res.json().catch(() => ({}))) as Record<string, any>;
  return { status: res.status, data };
}

/** A refusal Docs explained (4xx, `{ error }`), for the model to see; anything else fails the turn as an error in-process would. */
function refused(a: Answer): Error {
  const message = typeof a.data.error === 'string' ? a.data.error : typeof a.data.error?.message === 'string' ? a.data.error.message : `Docs answered ${a.status}.`;
  return a.status >= 400 && a.status < 500 ? new ToolFailure(message) : new Error(`Docs: ${a.status} ${message}`);
}

const enc = encodeURIComponent;

/** Bytes into the root as a new file (import_file, and a mail attachment saved to Docs): what importBytes made. */
export async function importToDocs(docs: DocsFetch, place: DocsPlace, bytes: Uint8Array, filename: string | undefined, title?: string): Promise<{ sheet?: any; file?: any; warnings: string[] }> {
  const q = `${placeQuery(place)}${filename ? `&filename=${enc(filename)}` : ''}${title ? `&title=${enc(title)}` : ''}`;
  const a = await call(docs, 'POST', `/api/import/bytes?${q}`, bytes);
  if (a.status !== 200) throw refused(a);
  return { ...(a.data.sheet ? { sheet: a.data.sheet } : { file: a.data.file }), warnings: a.data.warnings ?? [] };
}

type Meta = { id: string; title: string; updatedAt: string; kind?: string; branch?: { parentTitle: string } };

async function list(docs: DocsFetch, place: DocsPlace, kind: 'sheets' | 'decks' | 'docs' | 'markdown'): Promise<Meta[]> {
  const a = await call(docs, 'GET', `/api/${kind}?${placeQuery(place)}`);
  if (a.status !== 200) throw refused(a);
  return (a.data[kind === 'markdown' ? 'docs' : kind] ?? []) as Meta[];
}

export async function runDocsToolByHttp(name: string, input: Record<string, unknown>, env: ServerToolEnv, docs: DocsFetch, place: DocsPlace): Promise<string> {
  switch (name) {
    case 'list_sheets': {
      const q = typeof input.query === 'string' ? input.query.trim().toLowerCase() : '';
      const all = (await list(docs, place, 'sheets')).filter((s) => !q || s.title.toLowerCase().includes(q));
      return JSON.stringify({
        total: all.length,
        sheets: all.slice(0, 50).map((s) => ({
          id: s.id,
          title: s.title,
          updated_at: s.updatedAt,
          ...(s.branch ? { branch_of: s.branch.parentTitle } : {}),
          ...(env.context.page === 'sheet' && env.context.sheetId === s.id ? { open_now: true } : {}),
        })),
        ...(all.length ? {} : { note: 'No spreadsheets. Presentations are listed separately by list_decks.' }),
      });
    }
    case 'read_other_sheet': {
      const id = input.sheet_id as string;
      if (env.context.page === 'sheet' && env.context.sheetId === id) {
        throw new ToolFailure('That spreadsheet is open right now; use get_sheet_overview and read_range so you see unsaved edits.');
      }
      const a = await call(docs, 'GET', `/api/sheets/${enc(id)}`);
      if (a.status === 404) throw new ToolFailure(`No spreadsheet with id "${id}". Use list_sheets to find ids.`);
      if (a.status !== 200) throw refused(a);
      const workbook = a.data.workbook;
      const src = { workbook, engine: new Engine(workbook) };
      if (typeof input.range !== 'string') return JSON.stringify({ title: a.data.sheet.title, ...sheetOverview(src) });
      const rr = resolveRange(workbook, input.tab as string | undefined, input.range);
      if (typeof rr === 'string') throw new ToolFailure(rr);
      return JSON.stringify({ title: a.data.sheet.title, ...readRange(src, rr.tab, rr.range) });
    }
    case 'create_sheet': {
      const a = await call(docs, 'POST', `/api/sheets?${placeQuery(place)}`, { title: String(input.title).trim() });
      if (a.status !== 200) throw refused(a);
      return JSON.stringify({ id: a.data.sheet.id, title: a.data.sheet.title });
    }
    case 'list_decks': {
      const q = typeof input.query === 'string' ? input.query.trim().toLowerCase() : '';
      const all = (await list(docs, place, 'decks')).filter((s) => !q || s.title.toLowerCase().includes(q));
      return JSON.stringify({
        total: all.length,
        decks: all.slice(0, 50).map((s) => ({
          id: s.id,
          title: s.title,
          updated_at: s.updatedAt,
          ...(env.context.page === 'deck' && env.context.deckId === s.id ? { open_now: true } : {}),
        })),
      });
    }
    case 'create_deck': {
      const specs = (input.slides as (Parameters<typeof buildSlide>[1] & { layout?: Parameters<typeof buildSlide>[0] })[] | undefined) ?? [];
      const deck: Deck = {
        version: 1,
        theme: (input.theme as Deck['theme'] | undefined) ?? 'light',
        slides: specs.length ? specs.map((s, i) => buildSlide(s.layout ?? (i === 0 ? 'title' : 'title-body'), s, newId)) : [buildSlide('title', {}, newId)],
      } as Deck;
      const a = await call(docs, 'POST', `/api/decks?${placeQuery(place)}`, { title: String(input.title).trim(), deck });
      if (a.status !== 200) throw refused(a);
      return JSON.stringify({ id: a.data.deck.id, title: a.data.deck.title, slide_count: deck.slides.length, note: 'Call open_deck to show it to the user.' });
    }
    case 'list_docs': {
      const q = typeof input.query === 'string' ? input.query.trim().toLowerCase() : '';
      const all = [...(await list(docs, place, 'docs')), ...(await list(docs, place, 'markdown'))]
        .filter((s) => !q || s.title.toLowerCase().includes(q))
        .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
      const openId = env.context.page === 'doc' || env.context.page === 'markdown' ? env.context.docId : null;
      return JSON.stringify({
        total: all.length,
        docs: all.slice(0, 50).map((s) => ({ id: s.id, kind: s.kind, title: s.title, updated_at: s.updatedAt, ...(openId === s.id ? { open_now: true } : {}) })),
      });
    }
    case 'create_doc': {
      const markdown = typeof input.markdown === 'string' ? input.markdown : '';
      const title = String(input.title).trim();
      if (input.kind === 'markdown') {
        const a = await call(docs, 'POST', `/api/markdown?${placeQuery(place)}`, { title, text: markdown });
        if (a.status !== 200) throw refused(a);
        return JSON.stringify({ id: a.data.doc.id, kind: 'markdown', title: a.data.doc.title, block_count: markdownBlocks(markdown).length, note: 'Call open_doc to show it to the user.' });
      }
      const doc = markdownToDoc(markdown);
      const a = await call(docs, 'POST', `/api/docs?${placeQuery(place)}`, { title, doc });
      if (a.status !== 200) throw refused(a);
      return JSON.stringify({ id: a.data.doc.id, kind: 'doc', title: a.data.doc.title, block_count: doc.content.content?.length ?? 0, note: 'Call open_doc to show it to the user.' });
    }
    case 'read_other_doc': {
      const id = input.doc_id as string;
      if ((env.context.page === 'doc' || env.context.page === 'markdown') && env.context.docId === id) throw new ToolFailure('That document is open right now; use read_doc so you see unsaved edits.');
      const range = { from: input.from as number | undefined, to: input.to as number | undefined };
      const d = await call(docs, 'GET', `/api/docs/${enc(id)}`);
      if (d.status === 200) return JSON.stringify({ title: d.data.meta.title, ...docOutline(docNode(d.data.doc), range) });
      if (d.status !== 404) throw refused(d);
      const md = await call(docs, 'GET', `/api/markdown/${enc(id)}`);
      if (md.status === 404) throw new ToolFailure(`No document with id "${id}". Use list_docs to find ids.`);
      if (md.status !== 200) throw refused(md);
      return JSON.stringify({ title: md.data.meta.title, format: 'markdown', ...markdownOutline(md.data.doc.text, range) });
    }
    case 'list_connections': {
      const [mine, kinds] = await Promise.all([call(docs, 'GET', '/api/connections'), call(docs, 'GET', '/api/connectors')]);
      if (mine.status !== 200) throw refused(mine);
      if (kinds.status !== 200) throw refused(kinds);
      const connections = (mine.data.connections ?? []).map((c: Record<string, any>) => ({
        id: c.id,
        connector: c.connector,
        name: c.name,
        status: c.status,
        ...(c.error ? { error: c.error } : {}),
        ...(c.lastUsedAt ? { last_used_at: c.lastUsedAt } : {}),
      }));
      return JSON.stringify({
        connections,
        connectors: (kinds.data.connectors ?? []).map((c: Record<string, any>) => ({ id: c.id, name: c.name, datasets: c.datasets })),
        ...(connections.length ? {} : { note: 'No connections yet. Ask the user to add one on the Connectors page (/connectors). Never ask for API keys in the chat.' }),
      });
    }
    case 'fetch_connector_data': {
      const a = await call(docs, 'POST', `/api/connections/${enc(String(input.connection_id))}/fetch`, { dataset: String(input.dataset), params: input.params ?? {} });
      if (a.status !== 200) throw a.status < 500 ? new ToolFailure(typeof a.data.error === 'string' ? a.data.error : 'That connection could not be read.') : refused(a);
      const res = a.data;
      const n = typeof input.preview_rows === 'number' ? input.preview_rows : 20;
      return JSON.stringify({
        result_handle: res.handle,
        columns: (res.columns ?? []).map((c: { name: string }) => c.name),
        preview: (res.rows ?? []).slice(0, n),
        total_rows: res.totalRows,
        truncated: res.truncated,
        ...(res.truncated ? { note: 'The row cap was reached; pass a larger params.limit (up to 50000) or a narrower date range for everything.' } : {}),
      });
    }
    case 'convert_pdf': {
      const id = typeof input.file_id === 'string' && input.file_id ? input.file_id : env.context.page === 'file' ? env.context.fileId : null;
      if (!id) throw new ToolFailure('Give file_id: the user has no file open. Find ids with list_files.');
      const a = await call(docs, 'POST', `/api/files/${enc(id)}/markdown`);
      if (a.status === 404) throw new ToolFailure(`There is no file ${id}. Find ids with list_files.`);
      if (a.status !== 200) throw refused(a);
      const warnings: string[] = a.data.warnings ?? [];
      return JSON.stringify({
        converted: true,
        doc_id: a.data.doc.id,
        kind: 'markdown',
        title: a.data.doc.title,
        pages: a.data.pages,
        ...(warnings.length ? { warnings } : {}),
        note: 'A new Markdown document next to the PDF. open_doc shows it to the user; read_doc reads it.',
      });
    }
    case 'export_pdf': {
      const c = env.context;
      const open = c.page === 'doc' || c.page === 'markdown' ? c.docId : c.page === 'deck' ? c.deckId : c.page === 'file' ? c.fileId : null;
      const id = typeof input.file_id === 'string' && input.file_id ? input.file_id : open;
      if (!id) throw new ToolFailure('Give file_id: the user has no file open. Find ids with list_docs, list_decks or list_files.');
      const a = await call(docs, 'POST', `/api/files/${enc(id)}/pdf`, { paper: input.paper === 'a4' ? 'a4' : 'letter' });
      if (a.status === 404) throw new ToolFailure(`There is no file ${id}.`);
      if (a.status !== 200) throw refused(a);
      const file = a.data.file;
      return JSON.stringify({ made: true, file_id: file.id, name: file.filename, folder: file.folder ?? '', size: file.size, note: 'A new PDF next to the file. open_file shows it to the user.' });
    }
    case 'import_file': {
      checkSearchRate(env.userId);
      try {
        const title = typeof input.title === 'string' ? input.title : undefined;
        // A picture the user pasted or attached is already stored for them (its address is in <attached_images>):
        // it is read from there, not fetched. The app's own address in front of it is fine too.
        const own = /^(?:https?:\/\/[^/]+)?(\/api\/images\/[0-9a-f-]{36})$/.exec(String(input.url).trim())?.[1];
        let fetched: { bytes: Uint8Array; name: string };
        if (own) {
          const res = STORED_IMAGE_RE.test(own) ? await docs(own) : null;
          if (!res?.ok) throw new ToolFailure('There is no stored picture at that address. Use an address from <attached_images>.');
          fetched = { bytes: new Uint8Array(await res.arrayBuffer()), name: '' };
        } else fetched = await fetchPublicFile(String(input.url), { limit: importLimit });
        const made = await importToDocs(docs, place, fetched.bytes, webImportName(fetched.name, title), title);
        if (made.file) {
          const picture = String(made.file.type).startsWith('image/');
          return JSON.stringify({ imported: true, kind: 'file', file_id: made.file.id, filename: made.file.filename, type: made.file.type, size: made.file.size, note: `Saved in the user's files. open_file shows it to the user${picture ? '; view_image shows it to you' : ''}.` });
        }
        const k = made.sheet.kind;
        const kind = k === 'deck' ? 'presentation' : k === 'doc' ? 'document' : k === 'markdown' ? 'Markdown document' : 'spreadsheet';
        const idField = k === 'deck' ? 'deck_id' : k === 'doc' || k === 'markdown' ? 'doc_id' : 'sheet_id';
        const opener = k === 'deck' ? 'open_deck' : k === 'doc' || k === 'markdown' ? 'open_doc' : 'open_sheet';
        return JSON.stringify({ imported: true, kind, [idField]: made.sheet.id, title: made.sheet.title, ...(made.warnings.length ? { warnings: made.warnings.slice(0, 20) } : {}), note: `A new ${kind} in the user's files. ${opener} opens it.` });
      } catch (e) {
        if (e instanceof WebFetchError) throw new ToolFailure(e.message);
        throw e;
      }
    }
    default:
      // web_search and image_search: no store, so they run as they do in-process.
      return runDocsTool(name, input, env);
  }
}
