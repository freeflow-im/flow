// The MCP server ChatGPT talks to: the model's document and presentation tools, the tools the app (the MCP
// App shown in ChatGPT) uses to load and save files, and the app itself as a UI resource.
//
// One McpServer is built per HTTP request (stateless streamable HTTP), so this must stay cheap.
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { EXTENSION_ID, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { CELL_IMAGE_TYPES, EDITABLE_IMAGE_TYPES, isTextFileType, MAX_TEXT_EDIT_BYTES, MAX_VIDEO_BYTES } from '../../shared/types.ts';
import { editElementsV1, schemas } from '../../server/agent/tools.ts';
import { MAX_OUTLINE_BLOCKS } from '../../shared/agent/docRead.ts';
import type { ThemeId } from '../../shared/deck.ts';
import { webImportName } from '../../server/importFile.ts';
import { fetchPublicFile, WebFetchError, type FetchedFile } from '../../server/webFetch.ts';
import { appName } from '../../shared/brand.ts';
import type { ImageJobResult, LiveResult, ToolImage } from './files.ts';
import { ConflictError, DECK_EDIT_TOOLS, RESULT_IMAGES, DOC_EDIT_TOOLS, FILE_KINDS, FileService, importLimit, LIBRARY_KINDS, MAX_IMPORT_BYTES, MAX_PDF_BYTES, sniffImageType, SHEET_EDIT_TOOLS, ToolError, UPLOAD_TICKET_MS, type LibraryKind, type DeckEditTool, type DocEditTool, type FileData, type FileKind, type SheetEditTool, type SlideSpec } from './files.ts';

/**
 * The app's resource URI. Hosts capture the HTML by URI when the plugin is created or its tools refreshed, so
 * the URI carries the bundle's content hash: a rebuilt app is a new URI, never a stale copy under the old one.
 * An old URI is still read (a published app keeps the one it was reviewed with) and answers with the current app.
 */
export const appUri = (hash: string): string => `ui://freeflow-docs/app-${hash}.html`;
/**
 * Versions of the MCP surface (its tools, their descriptions and what they return). Version 1, at /mcp, is the
 * one submitted to ChatGPT and stays as it is (mcp-v1.json holds its tool list, checked by the tests); a newer
 * version is served at /mcp/v<n> until it is submitted in turn.
 */
export const MCP_VERSIONS = [1, 2] as const;
export type McpVersion = (typeof MCP_VERSIONS)[number];
const SERVER_VERSIONS: Record<McpVersion, string> = { 1: '0.2.0', 2: '0.3.0' };
/**
 * Who the server says it is: MCP Docs, on the web (id universal-docs, which agents' settings name) and in the
 * desktop app (mcp-docs, for agents on the same machine). Version 1 keeps the name it was submitted under.
 */
export const serverInfo = (version: McpVersion = 1, local = false) => ({
  ...(local ? { name: 'mcp-docs', title: 'MCP Docs' } : version === 1 ? { name: 'freeflow-docs' } : { name: 'universal-docs', title: 'MCP Docs' }),
  version: SERVER_VERSIONS[version],
});
/** Version 1's server info. */
export const SERVER_INFO = serverInfo(1);
/** What the server advertises: tools, resources, and MCP Apps UI resources. */
export const SERVER_CAPABILITIES = {
  tools: { listChanged: true },
  resources: { listChanged: true },
  extensions: { [EXTENSION_ID]: { mimeTypes: [RESOURCE_MIME_TYPE] } },
};

export interface Bundle {
  js: string;
  css: string;
  /** Short content hash, for cache busting when the bundle is served as files. */
  hash: string;
}

export interface McpOptions {
  /** The built app. */
  bundle: () => Bundle;
  /** Public origin: where images are served from, and the app's script and stylesheet with hostedAssets. */
  publicUrl: string | null;
  /** Reference the script and stylesheet at publicUrl instead of inlining them. ChatGPT runs a custom
   *  server's app with its CSP off and did not load an external script; inline is the safe default. */
  hostedAssets?: boolean;
  /** Serve a static test page instead of the app, to tell host problems from app problems. */
  helloPage?: boolean;
  /** Serve the resource as the legacy Apps SDK type (text/html+skybridge) instead of the MCP Apps type. */
  legacyMime?: boolean;
  /** Which _meta to put on the resource content: everything, only the MCP Apps keys, only the legacy keys, or none. */
  resourceMeta?: 'full' | 'ui' | 'legacy' | 'none';
  /** For bisecting what ChatGPT's setup rejects: 'minimal' is list_files alone, 'tools' is every model tool
   *  but no UI (no resource, no app-only tools, no entrypoint), 'render' adds the resource and open_file
   *  rendering it, 'app' adds the app-only tools and the docs_app tool, 'full' (default) adds the sidebar
   *  entrypoint. */
  level?: 'minimal' | 'tools' | 'render' | 'app' | 'full';
  /** Which version of the tools to serve (MCP_VERSIONS); 1 when not given. */
  version?: McpVersion;
  /** The desktop app's server, for agents on the same machine: it is named MCP Docs. */
  local?: boolean;
  /**
   * The desktop app's file at a path on this machine (open_path): the open folder's document or stored file, or,
   * for a file outside it, `elsewhere`, its folder, which the app opens in a new tab. Throws ToolError when there is no such file.
   */
  openPath?: (path: string) => { kind: LibraryKind; id: string } | { elsewhere: string };
  /** Fetches files ChatGPT hands to import_file (tests pass a fake). */
  fetchFn?: typeof fetch;
}


export const INSTRUCTIONS = `Universal Docs: the user's text documents, slide presentations and spreadsheets, with an app that shows one file open for editing.
Document tools (read_doc, insert_content, replace_blocks, ...) act on the open document, presentation tools (read_deck, add_slides, update_slide, ...) on the open presentation and spreadsheet tools (get_sheet_overview, read_range, write_range, ...) on the open spreadsheet unless an id is given. Read first (read_doc, read_deck or get_sheet_overview) to learn block or slide numbers, element ids or the data layout; they change after inserts and deletes. Spreadsheet tools act on the tab the user is looking at unless a tab is given; write formulas (starting with =) rather than computed numbers. Write document content as Markdown. Keep edits targeted: change the blocks, slides, elements or cells that need changing rather than rewriting everything. A Markdown document (kind markdown) is a plain Markdown file, kept exactly as written: read_doc, insert_content, replace_blocks, delete_blocks and replace_text work on it, and its formatting is its text. After editing, the open file updates in the app by itself; do not call open_file again.`;

const V2_INSTRUCTIONS =
  'A file on your own computer (one you can read from disk, not an attachment or a web address) is uploaded with upload_file: it returns an address, and you send the file\'s bytes there yourself, with curl for example. Files can be kept in folders, named by their path ("Reports/2026"): list_files lists one folder (its files and the folders in it; the top when none is given), search_files finds files and folders by name in any folder, create_folder makes one, move_file puts a file in one, and upload_file can upload straight into one.';

/** The instructions a version of the server gives; version 2 adds how to read stored files, upload local ones and use folders. */
export const instructionsFor = (version: McpVersion = 1, local = false): string => {
  // Version 1 (ChatGPT's) keeps the name it was submitted under.
  const intro = version === 1 && !local ? INSTRUCTIONS : INSTRUCTIONS.replace(/^Universal Docs:/, `${appName(true)}:`);
  return version === 1
    ? intro
    : `${intro}\n${V2_INSTRUCTIONS}\nStored files (kind file: PDFs, web pages, pictures, videos and other uploads) are not edited. read_file returns one exactly as it is (a text file's text, a picture, or the bytes of a PDF or other file), and read_doc with its id as doc_id reads its text as numbered blocks. convert_pdf_to_markdown makes a Markdown document of a PDF's text, to edit.`;
};

const DOC_ICON = {
  src: 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.33" stroke-linecap="round" stroke-linejoin="round"><path d="M5 2.5h7l3.5 3.5v11.5h-10.5z"/><path d="M12 2.5v3.5h3.5"/><path d="M7.5 10h5M7.5 13h5"/></svg>'),
  mimeType: 'image/svg+xml',
  sizes: ['20x20'],
};

const kind = z.enum(FILE_KINDS as [FileKind, ...FileKind[]]).describe('doc (text document), deck (slide presentation), sheet (spreadsheet) or markdown (Markdown document).');
/** For the tools that work on anything in the library, stored files included. */
const anyKind = z.enum(LIBRARY_KINDS as [LibraryKind, ...LibraryKind[]]).describe('doc (text document), deck (slide presentation), sheet (spreadsheet), markdown (Markdown document: a plain Markdown file) or file (a PDF, web page, video or image, which is shown but not edited).');
const fileId = z.string().describe('The file id (from list_files or the app).');
const optionalDocId = z.string().optional().describe('The document or Markdown document to act on. Defaults to the one open in the app.');
const optionalDeckId = z.string().optional().describe('The presentation to act on. Defaults to the presentation open in the app.');
const optionalSheetId = z.string().optional().describe('The spreadsheet to act on. Defaults to the spreadsheet open in the app.');
type EditTool = DocEditTool | DeckEditTool | SheetEditTool;

/**
 * Which of the app's tools change the file, for ChatGPT's "ask before changes" setting. A tool that writes over
 * or removes what was there (text, a slide's content, elements, the page setup) is destructive, as OpenAI's
 * review reads it, even though the app's editor can undo it.
 */
const ANNOTATIONS: Record<EditTool, { readOnlyHint: boolean; destructiveHint: boolean }> = {
  read_doc: { readOnlyHint: true, destructiveHint: false },
  get_doc_info: { readOnlyHint: true, destructiveHint: false },
  insert_content: { readOnlyHint: false, destructiveHint: false },
  replace_blocks: { readOnlyHint: false, destructiveHint: true },
  delete_blocks: { readOnlyHint: false, destructiveHint: true },
  replace_text: { readOnlyHint: false, destructiveHint: true },
  format_text: { readOnlyHint: false, destructiveHint: false },
  format_blocks: { readOnlyHint: false, destructiveHint: false },
  insert_image: { readOnlyHint: false, destructiveHint: false },
  set_doc_style: { readOnlyHint: false, destructiveHint: false },
  set_page_setup: { readOnlyHint: false, destructiveHint: true },
  read_deck: { readOnlyHint: true, destructiveHint: false },
  add_slides: { readOnlyHint: false, destructiveHint: false },
  update_slide: { readOnlyHint: false, destructiveHint: true },
  edit_elements: { readOnlyHint: false, destructiveHint: true },
  delete_slides: { readOnlyHint: false, destructiveHint: true },
  move_slide: { readOnlyHint: false, destructiveHint: false },
  set_deck_theme: { readOnlyHint: false, destructiveHint: false },
  get_sheet_overview: { readOnlyHint: true, destructiveHint: false },
  read_range: { readOnlyHint: true, destructiveHint: false },
  write_range: { readOnlyHint: false, destructiveHint: true },
  clear_range: { readOnlyHint: false, destructiveHint: true },
  format_range: { readOnlyHint: false, destructiveHint: false },
  insert_rows: { readOnlyHint: false, destructiveHint: false },
  delete_rows: { readOnlyHint: false, destructiveHint: true },
  insert_columns: { readOnlyHint: false, destructiveHint: false },
  delete_columns: { readOnlyHint: false, destructiveHint: true },
  move_columns: { readOnlyHint: false, destructiveHint: false },
  sort_range: { readOnlyHint: false, destructiveHint: false },
  set_cell_image: { readOnlyHint: false, destructiveHint: true },
  set_cell_link: { readOnlyHint: false, destructiveHint: true },
  set_filter: { readOnlyHint: false, destructiveHint: false },
  add_chart: { readOnlyHint: false, destructiveHint: false },
  edit_chart: { readOnlyHint: false, destructiveHint: false },
  delete_chart: { readOnlyHint: false, destructiveHint: true },
  set_filter_criteria: { readOnlyHint: false, destructiveHint: false },
  set_column_width: { readOnlyHint: false, destructiveHint: false },
  set_row_height: { readOnlyHint: false, destructiveHint: false },
  freeze: { readOnlyHint: false, destructiveHint: false },
  add_tab: { readOnlyHint: false, destructiveHint: false },
  rename_tab: { readOnlyHint: false, destructiveHint: false },
  delete_tab: { readOnlyHint: false, destructiveHint: true },
};

/** Descriptions that differ from the in-app assistant's (which mention things only it has). */
const DESCRIPTIONS: Partial<Record<EditTool, string>> = {
  insert_image: 'Add an image block to the open document from an https URL, or from an image the user attached in the chat (pass it as file). To save a picture as a file of its own, use import_file instead. (Markdown ![alt](src) on its own line in insert_content does the same without a width.)',
  set_cell_image:
    'Show an image inside a cell, scaled to fit the cell: from an https URL, or from an image the user attached in the chat (pass it as file). Replaces the cell\'s value; keeps its formatting. Make the row taller or the column wider (set_row_height, set_column_width) if the image should appear larger.',
  replace_blocks: 'Replace blocks from..to of the document with new content written as Markdown. Use this to rewrite a paragraph or a whole section; prefer replace_text for small wording changes.',
  delete_blocks: 'Delete blocks from..to of the document.',
  delete_slides: 'Delete slides by number.',
  read_deck: 'Outline of the presentation: theme, every slide with its layout, elements (id, type, position, text) and notes, and which slide the user is on. Call this before changing slides.',
  get_sheet_overview:
    'Describe the spreadsheet: every tab with its size, used range, frozen panes, filter and first few rows, plus the range the user has selected. Call this first when you need to know how the data is laid out.',
};

/** Tools that take an image, and the field it goes in: the user's attachment can stand in for the address. */
const IMAGE_TOOLS: Partial<Record<EditTool, string>> = { set_cell_image: 'url', insert_image: 'src' };

// The shape ChatGPT documents for a file parameter: download_url and file_id are required.
const attachedFile = z.object({
  download_url: z.string().describe('Where to download the file (filled in by ChatGPT).'),
  file_id: z.string().describe('The id ChatGPT gives the attached file.'),
  mime_type: z.string().optional(),
  file_name: z.string().optional(),
});

/**
 * Fetch a file from the web, within limits: one the host attached, or one at an address the model gave. Only
 * https, and never an address on a private network (server/webFetch.ts checks every hop).
 */
async function download(url: string, fetchFn: typeof fetch, limit: number | ((name: string) => number)): Promise<FetchedFile> {
  if (!/^https:\/\//i.test(url.trim())) {
    let valid = true;
    try {
      new URL(url);
    } catch {
      valid = false;
    }
    throw new ToolError(valid ? 'Files can only be fetched from public https addresses.' : 'The file address is not a valid URL.');
  }
  try {
    return await fetchPublicFile(url.trim(), { limit, fetchFn });
  } catch (e) {
    if (e instanceof WebFetchError) throw new ToolError(/public internet/.test(e.message) ? 'Files can only be fetched from public https addresses.' : e.message);
    throw e;
  }
}

function ok(data: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }], structuredContent: data };
}

/** An edit tool's result, with the pictures it returned (render_slide run in the app's window) after its JSON. */
function okEdit(result: Record<string | symbol, unknown>): CallToolResult {
  const { [RESULT_IMAGES]: images, ...data } = result as Record<string, unknown> & { [RESULT_IMAGES]?: ToolImage[] };
  const r = ok(data);
  return images?.length ? { ...r, content: [...r.content, ...images.map((i) => ({ type: 'image' as const, data: i.data, mimeType: i.mediaType }))] } : r;
}

/** A tool run in the desktop app's window: its JSON and the pictures it returned, or its error. */
function windowResult(r: LiveResult): CallToolResult {
  if (r.isError) return fail(r.content);
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(r.content) as Record<string, unknown>;
  } catch {
    data = { result: r.content };
  }
  // The assistant's tools say where their picture is in its own conversation; here it comes with the result.
  if (r.images?.length && typeof data.image === 'string') data.image = 'The picture comes with this result. Look at it before reporting back.';
  return { content: [{ type: 'text', text: JSON.stringify(data) }, ...(r.images ?? []).map((i) => ({ type: 'image' as const, data: i.data, mimeType: i.mediaType }))], structuredContent: data };
}

/** The operations with remove_background added when asked for: after the crop, rotation and flip, before colors, marks and resizing. */
function withBackgroundRemoval(operations: Record<string, unknown>[], remove: boolean): Record<string, unknown>[] {
  if (!remove) return operations;
  const at = operations.findIndex((o) => !['crop', 'rotate', 'straighten', 'flip'].includes(String(o.op)));
  const i = at < 0 ? operations.length : at;
  return [...operations.slice(0, i), { op: 'remove_background' }, ...operations.slice(i)];
}

function fail(message: string): CallToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

const withoutDates = (file: unknown): unknown => {
  if (!file || typeof file !== 'object') return file;
  const { updated_at: _u, created_at: _c, rev: _r, ...rest } = file as Record<string, unknown>;
  return rest;
};

/** A tool result as the model gets it: without the revisions and dates the app keeps in step with. */
export function forModel(result: CallToolResult): CallToolResult {
  const data = result.structuredContent as Record<string, unknown> | undefined;
  if (!data || result.isError) return result;
  const { rev: _rev, ...rest } = data;
  if ('file' in rest) rest.file = withoutDates(rest.file);
  if ('open' in rest) rest.open = withoutDates(rest.open);
  if (Array.isArray(rest.files)) rest.files = rest.files.map(withoutDates);
  const [first, ...others] = result.content;
  // The first part is the same data as text (see ok); pictures and the like follow it.
  return { ...result, structuredContent: rest, content: first?.type === 'text' ? [{ type: 'text', text: JSON.stringify(rest) }, ...others] : result.content };
}

/** Run a tool body, turning the errors the model (or the app) should see into error results. */
async function guard(fn: () => Promise<CallToolResult> | CallToolResult): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ToolError || e instanceof ConflictError) return fail(e.message);
    if (e instanceof Error && e.name === 'RangeError') return fail(e.message);
    throw e;
  }
}

/** The page shown in ChatGPT. `appUrl` is where the full app lives, for its "Open in Freeflow" links. */
export function appHtml(bundle: Bundle, assetOrigin: string | null, appUrl: string | null = null): string {
  const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const head = `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Docs</title>${appUrl ? `<meta name="freeflow-url" content="${escape(appUrl)}">` : ''}`;
  if (assetOrigin) {
    // Served from our own origin, which the resource's CSP (resourceDomains) allows.
    return `<!doctype html>\n<html lang="en"><head>${head}<link rel="stylesheet" href="${assetOrigin}/plugin/app.css?v=${bundle.hash}"></head><body><div id="root"></div><script type="module" src="${assetOrigin}/plugin/app.js?v=${bundle.hash}"></script></body></html>`;
  }
  // Inlined: the host's default CSP allows inline scripts and styles.
  const js = bundle.js.replace(/<\/script/gi, '<\\/script');
  return `<!doctype html>\n<html lang="en"><head>${head}<style>${bundle.css}</style></head><body><div id="root"></div><script type="module">${js}</script></body></html>`;
}

const HELLO = '<!doctype html><html><head><meta charset="utf-8"><style>body{font:14px system-ui;padding:16px}</style></head><body><h1>Docs</h1><p>Hello from the Docs plugin. If you can read this, ChatGPT can show our pages.</p></body></html>';

/**
 * Version 1 describes an arc's x/y/w/h as the box of its whole ellipse; the editor now takes the box around the
 * visible stroke, with the ellipse given by its center and radii. An arc given with its whole box is placed by
 * that ellipse instead.
 */
export function arcsAsEllipseBoxes(input: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(input.set)) return input;
  const set = input.set.map((spec: Record<string, unknown>) => {
    const isArc = spec.shape === 'arc' || spec.start_angle !== undefined || spec.end_angle !== undefined;
    const { x, y, w, h, ...rest } = spec;
    if (!isArc || typeof x !== 'number' || typeof y !== 'number' || typeof w !== 'number' || typeof h !== 'number') return spec;
    return { ...rest, cx: x + w / 2, cy: y + h / 2, rx: w / 2, ry: h / 2 };
  });
  return { ...input, set };
}

export function createMcpServer(service: FileService, opts: McpOptions): McpServer {
  const version = opts.version ?? 1;
  const server = new McpServer({ ...serverInfo(version, opts.local), icons: [DOC_ICON] }, { instructions: instructionsFor(version, opts.local) });
  // What a tool returns to the model holds only what a request needs: revisions and dates are for the app's
  // own tools, which keep them.
  const register = server.registerTool.bind(server) as (name: string, config: { _meta?: Record<string, unknown> }, handler: (...args: unknown[]) => Promise<CallToolResult> | CallToolResult) => unknown;
  (server as unknown as { registerTool: typeof register }).registerTool = (name, config, handler) => {
    const appOnlyTool = ((config._meta?.ui as { visibility?: string[] } | undefined)?.visibility ?? []).join() === 'app';
    return register(name, config, appOnlyTool ? handler : async (...args) => forModel(await handler(...args)));
  };
  const level = opts.level ?? 'full';
  const ui = level === 'render' || level === 'app' || level === 'full';
  // Only the levels that show the app need the bundle. An unbuilt app still lists its tools (the resource
  // read is where "run npm run plugin:build" surfaces), under a URI no built app will ever have.
  const bundleHash = (): string => {
    try {
      return opts.bundle().hash;
    } catch {
      return 'unbuilt';
    }
  };
  const APP_URI = ui ? appUri(bundleHash()) : '';
  const appTools = level === 'app' || level === 'full';
  const entrypoint = level === 'full';

  /** Most files or folders one listing or search returns: a folder on disk can hold thousands. */
  const MAX_LISTED = 200;
  const listFiles = { title: 'List files', description: "The user's documents, Markdown documents, presentations, spreadsheets and stored files (PDFs, web pages, videos and images), most recently edited first, with their ids. Optionally one kind, or filtered by a word in the title.", inputSchema: { kind: anyKind.optional(), query: z.string().max(200).optional().describe('Only files whose title contains this text.') }, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } };
  // Version 2 knows about folders: each file's folder, the folders there are, and a listing of one folder.
  if (version === 1) server.registerTool('list_files', listFiles, async ({ kind: k, query }) => guard(() => ok({ files: service.list(k, query).slice(0, 50), ...service.state() })));
  else {
    server.registerTool(
      'list_files',
      {
        ...listFiles,
        description: `${listFiles.description} Each file has the path of the folder it is in, which is empty at the top. Give folder to list one folder: its files and the folders directly in it. Without folder, the most recently edited files anywhere and the folders at the top. To find a file or folder by name wherever it is, use search_files.`,
        inputSchema: { ...listFiles.inputSchema, folder: z.string().max(1000).optional().describe('Only the files in this folder, by its path, such as "Reports/2026". An empty string means the top level. Leave out to list files in every folder.') },
      },
      async ({ kind: k, query, folder }) =>
        guard(() => {
          const path = folder === undefined ? undefined : service.folderPath(folder);
          const files = service.listWithFolders(k, query, path);
          const limit = path === undefined ? 50 : MAX_LISTED;
          const folders = service.subfolders(path ?? '');
          return ok({
            files: files.slice(0, limit),
            folders: folders.slice(0, MAX_LISTED),
            ...(files.length > limit || folders.length > MAX_LISTED ? { truncated: true, note: 'Not everything is listed: narrow it with query or kind, or use search_files.' } : {}),
            ...service.state(),
          });
        }),
    );
    server.registerTool(
      'search_files',
      {
        title: 'Search files',
        description:
          'Find documents, Markdown documents, presentations, spreadsheets, stored files and folders whose name contains the text, in every folder (or only in one folder and the folders under it), most recently edited first. Each file has its id and the path of its folder. Names are matched, not what the files say.',
        inputSchema: {
          query: z.string().trim().min(1).max(200).describe('Text the name contains, such as "budget" or "MULTI_TMC". Case does not matter.'),
          kind: anyKind.optional(),
          folder: z.string().max(1000).optional().describe('Only look in this folder and the folders under it, by its path, such as "Reports". Leave out to look everywhere.'),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      },
      async ({ query, kind: k, folder }) =>
        guard(async () => {
          const found = await service.search(query, k, folder === undefined ? undefined : service.folderPath(folder));
          const truncated = found.files.length > MAX_LISTED || found.folders.length > MAX_LISTED;
          return ok({ files: found.files.slice(0, MAX_LISTED), folders: found.folders.slice(0, MAX_LISTED), ...(truncated ? { truncated: true, note: 'More match: use a longer query, a kind or a folder.' } : {}), ...service.state() });
        }),
    );
  }
  if (level === 'minimal') return server;

  if (ui) server.server.registerCapabilities(SERVER_CAPABILITIES);

  // Shaped like OpenAI's reference plugin (bits-and-bolts). The declared domains apply once the app is
  // reviewed; in developer mode ChatGPT runs the app with its CSP off.
  const origins = opts.publicUrl ? [opts.publicUrl] : [];
  const uiMeta = {
    ui: {
      csp: { connectDomains: origins, resourceDomains: [...origins, 'https://fonts.googleapis.com', 'https://fonts.gstatic.com'] },
      prefersBorder: true,
    },
    'openai/ui': { preferredDisplayMode: 'inline', availableDisplayModes: ['inline', 'fullscreen'] },
    // Legacy Apps SDK aliases of the same things, which ChatGPT's web host still reads.
    'openai/widgetDescription': 'The Universal Docs editor: the open document, presentation or spreadsheet, editable in place.',
    'openai/widgetPrefersBorder': true,
    'openai/widgetCSP': { connect_domains: origins, resource_domains: [...origins, 'https://fonts.googleapis.com', 'https://fonts.gstatic.com'] },
  };
  /** Tool metadata linking to the app, in both the MCP Apps form and the legacy Apps SDK form. */
  const rendersApp = (extra: Record<string, unknown> = {}) => ({ ui: { resourceUri: APP_URI, ...extra }, 'openai/outputTemplate': APP_URI });

  // --- The app ---------------------------------------------------------------------------

  const mimeType = opts.legacyMime ? 'text/html+skybridge' : RESOURCE_MIME_TYPE;
  const pick = opts.resourceMeta ?? 'full';
  const contentMeta = pick === 'none' ? undefined : pick === 'ui' ? { ui: uiMeta.ui } : pick === 'legacy' ? Object.fromEntries(Object.entries(uiMeta).filter(([k]) => k.startsWith('openai/widget'))) : uiMeta;
  const appContents = (uri: string) => ({
    contents: [{ uri, mimeType, text: opts.helloPage ? HELLO : appHtml(opts.bundle(), opts.hostedAssets ? opts.publicUrl : null, opts.publicUrl), ...(contentMeta ? { _meta: contentMeta } : {}) }],
  });
  if (ui) {
    server.registerResource('docs-app', APP_URI, { title: 'Universal Docs', mimeType }, async () => appContents(APP_URI));
    // A published app keeps the URI it was reviewed with, so an earlier bundle's URI is still the app (the current one).
    server.registerResource('docs-app-earlier', new ResourceTemplate(appUri('{hash}'), { list: undefined }), { title: 'Universal Docs', mimeType }, async (uri) => appContents(uri.href));
  }

  // Opens from ChatGPT's sidebar: the whole app, with the composer alongside.
  if (appTools)
    server.registerTool(
      'docs_app',
      {
        title: 'Universal Docs',
        description: 'Open the Docs app.',
        inputSchema: {},
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        _meta: { ...rendersApp({ visibility: ['app'] }), 'openai/widgetAccessible': true, ...(entrypoint ? { 'openai/ui': { entrypoints: [{ type: 'global' }, { type: 'thread' }] } } : {}) },
      },
      async () => ok({ ...service.state() }),
    );

  // --- Tools for the model (the app may call these too) ----------------------------------------

  // Which account is linked (ChatGPT shows it and can link several).
  server.registerTool(
    'get_profile',
    {
      title: 'Linked account',
      description: 'The account the plugin is signed in as: its email address.',
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: { 'openai/profile': true },
    },
    async () => {
      const p = service.profile();
      // The email is the account's name here too; the id inside the app is not for anyone else.
      return ok({ id: p.email, email: p.email, name: p.email });
    },
  );

  server.registerTool(
    'create_doc',
    {
      title: 'Create document',
      description: 'Create a new text document, or a Markdown document (kind "markdown"), optionally with content written as Markdown, and open it in the app. Make a Markdown document when the user asks for a Markdown or .md file (a README, a SKILL.md, notes kept as Markdown).',
      inputSchema: {
        title: z.string().min(1).max(200),
        markdown: z.string().max(200_000).optional().describe('Initial content as Markdown. Supports headings, lists, quotes, code blocks, images, links, bold and italics.'),
        kind: z.enum(['doc', 'markdown']).optional().describe('"doc" (the default) is a rich text document built from the Markdown; "markdown" is a plain Markdown file holding it exactly as written, front matter included.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ title, markdown, kind: k }) =>
      guard(async () => {
        const file = await service.createDoc(title, markdown, k ?? 'doc');
        service.show({ kind: k ?? 'doc', id: file.id });
        return ok({ file, ...service.state() });
      }),
  );

  server.registerTool(
    'create_deck',
    {
      title: 'Create presentation',
      description: 'Create a new slide presentation, optionally with its slides, and open it in the app.',
      inputSchema: schemas.create_deck.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ title, theme, slides }) =>
      guard(async () => {
        const file = await service.createDeck(title, theme as ThemeId | undefined, (slides ?? []) as SlideSpec[]);
        service.show({ kind: 'deck', id: file.id });
        return ok({ file, ...service.state() });
      }),
  );

  server.registerTool(
    'create_sheet',
    {
      title: 'Create spreadsheet',
      description: 'Create a new, empty spreadsheet and open it in the app. Fill it in with write_range.',
      inputSchema: schemas.create_sheet.shape,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ title }) =>
      guard(async () => {
        const file = await service.createSheet(title);
        service.show({ kind: 'sheet', id: file.id });
        return ok({ file, ...service.state() });
      }),
  );

  // A file the user attached in ChatGPT: the host turns the `file` argument into a download URL (openai/fileParams).
  server.registerTool(
    'import_file',
    {
      title: 'Import a file',
      description:
        version === 1
          ? "Import a file into the user's library and open it in the app. The file is either one the user attached in the chat (file) or one at a public web address (url). Use this whenever the user wants a file uploaded, saved or added to their files. A Word, PowerPoint, Excel, CSV or Markdown file becomes an editable document, presentation, spreadsheet or Markdown document. A PDF, web page (.html), video or image is stored as it is and shown in the app's viewer. Any other type returns an error saying it cannot be imported; tell the user rather than working around it."
          : "Import a file into the user's library and open it in the app. The file is either one the user attached in the chat (file) or one at a public web address (url). Use this whenever the user wants a file uploaded, saved or added to their files. A Word, PowerPoint, Excel, CSV or Markdown file becomes an editable document, presentation, spreadsheet or Markdown document. A PDF, web page (.html), video or image is stored as it is and shown in the app's viewer, and any other plain text file (.txt, .yaml, .json, a config or source file) is stored as it is and edited with edit_file. Any other type returns an error saying it cannot be imported; tell the user rather than working around it.",
      inputSchema: {
        file: attachedFile.optional().describe('The attached file. Give this or url.'),
        url: z.string().max(2000).optional().describe('The https address of a file on the web to import instead of an attachment: the file itself (an image, a PDF, a .docx), not a page that shows it.'),
        title: z.string().max(200).optional().describe('Title for the new file. Defaults to the file name.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      _meta: { 'openai/fileParams': ['file'] },
    },
    async ({ file, url, title }) =>
      guard(async () => {
        if (!file === !url) throw new ToolError('Give either file (an attachment) or url (a web address), not both.');
        // An attachment brings its name; a web address gives one in its last part or its headers.
        const got = file ? await download(file.download_url, opts.fetchFn ?? fetch, importLimit(file.file_name)) : await download(url!, opts.fetchFn ?? fetch, importLimit);
        const r = await service.importFile(got.bytes, file ? file.file_name : webImportName(got.name, title), title);
        service.show({ kind: r.file.kind, id: r.file.id });
        return ok({ ...r, ...service.state() });
      }),
  );

  // Opening a file shows the app with it (the same app the sidebar opens).
  server.registerTool(
    'open_file',
    {
      title: 'Open file',
      description: `Open a document, Markdown document, presentation or spreadsheet in the app so the user sees it, and return its outline (a document's first ${MAX_OUTLINE_BLOCKS} blocks, every slide, or every tab's layout). The document, presentation or spreadsheet tools then act on it by default. A stored file (a PDF, video or image) is shown in the app's viewer; only its name, type and size come back.`,
      inputSchema: { kind: anyKind, id: fileId },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      ...(ui ? { _meta: rendersApp() } : {}),
    },
    async ({ kind: k, id }) => guard(() => openShown(k, id)),
  );

  // Show a file in the app and return what open_file returns about it.
  const openShown = async (k: LibraryKind, id: string): Promise<CallToolResult> => {
    service.show({ kind: k, id });
    if (k === 'file' && version === 1) return ok({ file: service.storedFile(id), ...service.state() });
    if (k === 'file') {
      // Its text comes back too, when it has any (a PDF, a web page, a text file), and a picture is shown.
      const file = service.storedFile(id);
      const read = await service.readStored(id, undefined, undefined, version >= 2).catch((e: unknown) => (e instanceof ToolError ? null : Promise.reject(e)));
      const f = service.hub.files.get(service.userId, id);
      const picture = f && f.meta.type.startsWith('image/') ? await shownImage(f.file, f.meta.type, f.meta.size) : [];
      const result = ok({ file, ...(read ? { text_content: read, note: 'Read more of it with read_doc and this id as doc_id (from, to).' } : {}), ...service.state() });
      return picture.length ? { ...result, content: [...result.content, ...picture] } : result;
    }
    const outline = k === 'doc' ? await service.editDoc(id, 'read_doc', {}) : k === 'markdown' ? await service.editMarkdown(id, 'read_doc', {}) : k === 'deck' ? await service.editDeck(id, 'read_deck', {}) : await service.editSheet(id, 'get_sheet_overview', {});
    return ok({ ...outline, ...service.state() });
  };

  // The desktop app opens a file by its path on this machine, as Finder does.
  const openPath = opts.openPath;
  if (openPath) {
    server.registerTool(
      'open_path',
      {
        title: 'Open a file by its path',
        description:
          "Open a file on this computer in the app by its path: absolute, from the home folder (~/...), or relative to the folder open in the app. A file in the open folder is opened as open_file opens it, and the same comes back. A file anywhere else is opened in a new tab of the app, on the file's own folder; the tools then work on that folder (call list_files or open_path again there).",
        inputSchema: { path: z.string().min(1).max(4096).describe('The path of the file.') },
        annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      },
      async ({ path }) =>
        guard(async () => {
          const found = openPath(path.trim());
          if ('elsewhere' in found) return ok({ opened_in_new_tab: true, folder: found.elsewhere, note: 'The file is outside the open folder, so the app is opening its folder in a new tab, which becomes the one the tools work on.' });
          return openShown(found.kind, found.id);
        }),
    );
  }

  // --- Pictures: look at one, and edit one exactly (the app's image editor does the editing) ---

  /** The largest picture attached to a result for the model to look at; a larger one is described, not shown. */
  const MAX_SHOWN_IMAGE_BYTES = 4 * 1024 * 1024;
  const shownImage = async (file: string, type: string, size: number): Promise<CallToolResult['content']> =>
    size <= MAX_SHOWN_IMAGE_BYTES && CELL_IMAGE_TYPES.includes(type) ? [{ type: 'image', data: (await readFile(file)).toString('base64'), mimeType: type }] : [];

  const previewContent = (r: ImageJobResult): CallToolResult['content'] => (r.preview && CELL_IMAGE_TYPES.includes(r.preview.type) ? [{ type: 'image', data: r.preview.data, mimeType: r.preview.type }] : []);

  server.registerTool(
    'view_image',
    {
      title: 'Look at a picture',
      description: 'Look at a stored picture (PNG, JPEG, GIF or WebP): it comes back for you to see, with its width and height in pixels, which positions in transform_image are given in. Use it before describing or editing a picture. Find ids with list_files.',
      inputSchema: { file_id: fileId },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ file_id }) =>
      guard(async () => {
        const f = await service.editableImage(file_id);
        let picture = await shownImage(f.file, f.meta.type, f.meta.size);
        // A large picture is reduced by the app, when it is showing (the server has nothing to scale pictures with).
        if (!picture.length) picture = previewContent(await service.runImageJob(file_id, [], 'copy', { preview: true }));
        const data = {
          file_id: f.meta.id,
          filename: f.meta.filename,
          type: f.meta.type,
          size: f.meta.size,
          ...(f.pixels ?? {}),
          ...(picture.length ? (f.meta.size > MAX_SHOWN_IMAGE_BYTES ? { note: 'Shown reduced; positions are in the full picture’s pixels (width and height above).' } : {}) : { note: 'Too large to attach, and the app is not showing to reduce it: call open_file with this picture, then view_image again. Its width and height are given.' }),
        };
        return { content: [{ type: 'text', text: JSON.stringify(data) }, ...picture], structuredContent: data };
      }),
  );

  if (version >= 2) {
    const folderPath = z.string().max(1000);
    server.registerTool(
      'create_folder',
      {
        title: 'Create folder',
        description: "Create a folder in the user's library. A folder is named by its path, such as \"Reports/2026\". Folders above it that are missing are created too. Nothing changes if the folder already exists.",
        inputSchema: { path: folderPath.min(1).describe('The path of the new folder: names separated by "/", such as "Reports" or "Reports/2026".') },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      },
      async ({ path: p }) => guard(() => ok({ folder: service.createFolder(p) })),
    );

    server.registerTool(
      'move_file',
      {
        title: 'Move file to a folder',
        description: 'Put a document, Markdown document, presentation, spreadsheet or stored file in a folder. The folder must exist; make it with create_folder. An empty folder path moves the file to the top level.',
        inputSchema: { kind: anyKind, id: fileId, folder: folderPath.describe('The path of the folder to move the file into, such as "Reports/2026". An empty string means the top level.') },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      },
      async ({ kind: k, id, folder }) => guard(() => ok({ file: service.move(k, id, service.folderPath(folder)) })),
    );

    server.registerTool(
      'upload_file',
      {
        title: 'Upload a local file',
        description:
          "Get a one-time address for uploading a file from your own computer into the user's library. Use it when you can read the file from disk and run a command such as curl. Send the file's bytes to the address with an HTTP POST, as the result shows. The file is then imported like import_file does: a Word, PowerPoint, Excel, CSV or Markdown file becomes an editable file, and a PDF, web page, video, image or any other plain text file (.yaml, .json, ...) is stored as it is. The address works once, for five minutes. Call this once for each file.",
        inputSchema: {
          file_name: z.string().min(1).max(200).describe('The name of the file with its extension, such as "report.pdf". The extension tells what kind of file it is.'),
          folder: folderPath.optional().describe('The path of the folder to put the file in, such as "Reports/2026". The folder must exist; make it with create_folder. Leave out for the top level.'),
          title: z.string().max(200).optional().describe('Title for the new file. Defaults to the file name.'),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      },
      async ({ file_name, folder, title }) =>
        guard(() => {
          if (!opts.publicUrl) return fail('This server has no public address to upload to.');
          const into = folder ? service.folderPath(folder) : '';
          const q = new URLSearchParams({ ticket: service.hub.issueTicket(service.userId, into), name: file_name, ...(title ? { title } : {}) });
          const url = `${opts.publicUrl}/plugin/import?${q}`;
          return ok({
            upload_url: url,
            method: 'POST',
            body: "The file's bytes, as they are (not a form).",
            example: `curl -sS -X POST --data-binary @"/path/to/${file_name}" "${url}"`,
            expires_in_seconds: UPLOAD_TICKET_MS / 1000,
            limits: `Videos up to ${MAX_VIDEO_BYTES / 1024 / 1024} MB, PDFs up to ${MAX_PDF_BYTES / 1024 / 1024} MB, other files up to ${MAX_IMPORT_BYTES / 1024 / 1024} MB.`,
            note: 'The response is JSON with the new file (its kind and id) or an error. The address works once.',
          });
        }),
    );
  }

  /** The largest file read_file returns whole; a larger one gets a download link instead. */
  const MAX_READ_FILE_BYTES = 10 * 1024 * 1024;

  if (version >= 2)
  server.registerTool(
    'read_file',
    {
      title: 'Read a stored file',
      description:
        "Return a stored file (anything list_files lists as kind file: a PDF, web page, picture, video or other upload) exactly as it is. A text file (.html, .txt, .json, .svg, .xml, .csv, ...) comes back as its text, in parts for a long one (read on with offset). A picture comes back as an image for you to see; a PDF or any other file comes back as an embedded resource with its bytes. A file over 10 MB comes back as a download link instead. It does not change the file. Documents, presentations and spreadsheets are read with read_doc, read_deck and read_range instead.",
      inputSchema: {
        file_id: fileId,
        offset: z.number().int().min(0).optional().describe('For a text file: the character to start from, for reading a long file in parts. Defaults to 0.'),
        max_chars: z.number().int().min(1).max(100_000).optional().describe('For a text file: how many characters to return. Defaults to 50000.'),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async ({ file_id, offset, max_chars }) =>
      guard(async () => {
        const f = service.hub.files.get(service.userId, file_id);
        if (!f) return fail(`There is no file ${file_id}. Use list_files to find ids (kind file).`);
        const about = { file_id, filename: f.meta.filename, type: f.meta.type, size: f.meta.size };
        if (f.meta.size > MAX_READ_FILE_BYTES) {
          const data = { ...about, download_url: service.fileLink(file_id).url, note: `Larger than ${MAX_READ_FILE_BYTES / 1024 / 1024} MB, so it is not returned here. The link downloads it for the next few hours.` };
          return ok(data);
        }
        const bytes = await readFile(f.file);
        if (isTextFileType(f.meta.type) && !bytes.subarray(0, 8000).includes(0)) {
          const text = new TextDecoder('utf-8').decode(bytes).replace(/^\uFEFF/, '');
          const from = Math.min(offset ?? 0, text.length);
          const end = Math.min(text.length, from + (max_chars ?? 50_000));
          return ok({ ...about, total_chars: text.length, offset: from, text: text.slice(from, end), ...(end < text.length ? { more: true, next_offset: end } : {}) });
        }
        const data = { ...about, ...(f.meta.size > MAX_SHOWN_IMAGE_BYTES && f.meta.type.startsWith('image/') ? { note: 'Too large to show as an image; its bytes are attached. view_image shows a reduced copy.' } : {}) };
        const picture = await shownImage(f.file, f.meta.type, f.meta.size);
        const raw: CallToolResult['content'] = picture.length
          ? picture
          : [{ type: 'resource', resource: { uri: service.fileLink(file_id).url, mimeType: f.meta.type || 'application/octet-stream', blob: bytes.toString('base64') } }];
        return { content: [{ type: 'text', text: JSON.stringify(data) }, ...raw], structuredContent: data };
      }),
  );

  if (version >= 2)
    server.registerTool(
      'edit_file',
      {
        title: 'Edit a stored text file',
        description:
          'Change a stored text file (anything list_files lists as kind file that read_file returns as text: .txt, .json, .html, .svg, .xml, a LICENSE or config file, source code, ...): find-and-replace edits, its whole new text, or undo of the last change. Read the part you change with read_file first, so find matches exactly. Give exactly one of edits, content or undo. PDFs, pictures and videos cannot be edited, and documents, presentations, spreadsheets and Markdown documents have their own tools. The app shows the new text by itself.',
        inputSchema: {
          file_id: fileId,
          edits: z
            .array(
              z.object({
                find: z.string().min(1).describe('Text to find, exactly as it is in the file (including spaces and line breaks). Include enough around it to match one place only.'),
                replace: z.string().describe('What to put there instead; an empty string deletes the text.'),
                all: z.boolean().optional().describe('Replace every occurrence instead of requiring exactly one.'),
              }),
            )
            .max(100)
            .optional()
            .describe('Replacements, made in order. Nothing is saved if any of them does not match.'),
          content: z.string().max(MAX_TEXT_EDIT_BYTES).optional().describe('Instead of edits: the whole new text of the file. Only for a short file or a full rewrite.'),
          undo: z.boolean().optional().describe('Instead of edits: put back the version from before the last change, where one is kept.'),
        },
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      },
      async ({ file_id, edits, content, undo }) => guard(async () => ok(await service.editStored(file_id, { edits, content, undo }))),
    );

  if (version >= 2)
    server.registerTool(
      'convert_pdf_to_markdown',
      {
        title: 'Convert a PDF to Markdown',
        description:
          "Make a Markdown document of a stored PDF's text, next to the PDF (in the same folder, with the same name), and show it in the app. The PDF does not change. Headings, lists, tables and links are kept, running headers and footers dropped, pictures left out, and scanned pages read with OCR (the result says which). Use it when the user wants a PDF as Markdown or as text to edit; the new document is then read and edited with read_doc, replace_blocks and the other document tools. Only to read a PDF, read_doc with its id is enough: it reads the same text without making a file.",
        inputSchema: { file_id: fileId.optional().describe('The PDF (kind file). Defaults to the file open in the app.') },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      async ({ file_id }) =>
        guard(async () => {
          const id = file_id ?? (service.open?.kind === 'file' ? service.open.id : undefined);
          if (!id) throw new ToolError('Give file_id: no file is open in the app. Use list_files or search_files to find ids.');
          const { warnings, ...made } = await service.convertPdf(id);
          service.show({ kind: 'markdown', id: made.file.id });
          return ok({ ...made, ...(warnings.length ? { warnings } : {}), ...service.state() });
        }),
    );

  if (version >= 2 && service.hub.pdf)
    server.registerTool(
      'export_pdf',
      {
        title: 'Make a PDF',
        description:
          'Make a PDF of a document, presentation, Markdown document or stored web page (.html), keep it as a stored file next to it (same folder, same name with .pdf), and show it in the app. The PDF is what the app prints: documents with their page setup, one slide per page, Markdown as its preview with diagrams drawn. The original does not change. Spreadsheets cannot be made into PDFs. read_file returns the PDF\'s bytes.',
        inputSchema: {
          file_id: fileId.optional().describe('The document, presentation, Markdown document or web page. Defaults to the file open in the app.'),
          paper: z.enum(['letter', 'a4']).optional().describe('Paper size for pages that do not set their own (Markdown, web pages). Defaults to letter; use a4 when the user is outside North America.'),
        },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      },
      async ({ file_id, paper }) =>
        guard(async () => {
          const id = file_id ?? service.open?.id;
          if (!id) throw new ToolError('Give file_id: no file is open in the app. Use list_files or search_files to find ids.');
          const file = await service.exportPdf(id, paper ?? 'letter');
          service.show({ kind: 'file', id: file.id });
          return ok({ file, ...service.state() });
        }),
    );

  // One edit of a picture, said as what the picture should become: each change is a field of its own, typed for
  // what it takes. (The app's assistant gives a list of operations instead; this is turned into one.)
  const px = (what: string) => z.number().describe(what);
  const box = { x: px('Left edge, in pixels from the left of the picture.'), y: px('Top edge, in pixels from the top of the picture.'), width: z.number().positive().describe('Width in pixels.'), height: z.number().positive().describe('Height in pixels.') };
  const pictureEdit = {
    file_id: fileId,
    crop: z.object(box).optional().describe('Keep only this rectangle of the picture.'),
    rotate: z.number().int().optional().describe('Turn the picture clockwise by this many degrees: 90, 180 or 270.'),
    straighten: z.number().min(-45).max(45).optional().describe('Level a tilted picture: degrees clockwise, between -45 and 45.'),
    flip: z.enum(['horizontal', 'vertical']).optional().describe('Mirror the picture: horizontal swaps left and right.'),
    adjust: z
      .object({
        brightness: z.number().min(-100).max(100).optional(),
        contrast: z.number().min(-100).max(100).optional(),
        saturation: z.number().min(-100).max(100).optional(),
        vibrance: z.number().min(-100).max(100).optional(),
        hue: z.number().min(-180).max(180).optional().describe('Degrees.'),
        blur: z.number().min(0).max(100).optional(),
      })
      .optional()
      .describe('Change the colors of the whole picture; give only the ones to change.'),
    filter: z.enum(['grayscale', 'sepia', 'invert', 'sharpen', 'none']).optional().describe('A look for the whole picture; none removes the filters.'),
    redact: z
      .array(z.object({ ...box, mode: z.enum(['solid', 'blur', 'pixelate']).optional().describe('Default solid, which cannot be seen through.') }))
      .max(10)
      .optional()
      .describe('Rectangles of the picture to hide.'),
    shapes: z
      .array(
        z.object({
          kind: z.enum(['rect', 'ellipse', 'triangle', 'diamond', 'pentagon', 'hexagon', 'star', 'line', 'arrow']),
          x: px('Left edge of the box the shape fills (every kind but line and arrow).').optional(),
          y: px('Top edge of that box.').optional(),
          width: z.number().positive().optional().describe('Width of that box.'),
          height: z.number().positive().optional().describe('Height of that box.'),
          x1: px('Line and arrow: where it starts.').optional(),
          y1: z.number().optional(),
          x2: px('Line and arrow: where it ends (the arrow head).').optional(),
          y2: z.number().optional(),
          color: z.string().optional().describe('Outline color, a CSS color such as #ff0000. Default red.'),
          stroke_width: z.number().positive().optional().describe('Outline thickness in pixels of the picture. Default 6.'),
          fill: z.string().optional().describe('A color inside the shape. Default none (outline only).'),
          corner_radius: z.number().min(0).optional().describe('Rounded corners, for rect.'),
        }),
      )
      .max(10)
      .optional()
      .describe('Shapes, lines and arrows to draw on the picture.'),
    text: z
      .array(
        z.object({
          text: z.string().min(1).max(2000),
          x: px('Left edge of the text, in pixels from the left of the picture.'),
          y: px('Top edge of the text, in pixels from the top of the picture.'),
          width: z.number().positive().optional().describe('Where the text wraps. Defaults to the rest of the picture.'),
          size: z.number().positive().optional().describe('Font size in pixels of the picture. Default 48; a headline on a 3000 pixel wide photo wants 150 or more.'),
          color: z.string().optional().describe('A CSS color such as #ffffff. Default black.'),
          font: z.string().optional().describe('A font family.'),
          bold: z.boolean().optional(),
          italic: z.boolean().optional(),
          align: z.enum(['left', 'center', 'right']).optional().describe('Within its width.'),
          background: z.string().optional().describe('A color behind the text, to keep it readable over a busy picture.'),
        }),
      )
      .max(10)
      .optional()
      .describe('Text to write on the picture.'),
    // Version 2: pictures put on top (a logo, a signature, a screenshot), each a stored picture uploaded first.
    ...(version >= 2
      ? {
          overlays: z
            .array(
              z.object({
                file_id: fileId.describe('The picture to put on top: a stored picture (PNG, JPEG, GIF or WebP). A picture on your own computer is uploaded first with upload_file.'),
                x: px('Left edge of the picture on top, in pixels from the left of the picture.'),
                y: px('Top edge of the picture on top, in pixels from the top of the picture.'),
                width: z.number().positive().optional().describe('Its width in pixels; the height keeps its shape. With no width or height it keeps its own size, made smaller to stay inside the picture.'),
                height: z.number().positive().optional().describe('Its height in pixels. Give both width and height to stretch it.'),
                opacity: z.number().min(0).max(100).optional().describe('How solid it is, in percent. Default 100.'),
              }),
            )
            .max(10)
            .optional()
            .describe(
              opts.local
                ? 'Pictures to put on top of this one, after the other changes. Each is a layer of its own: with no save given, the picture is opened in the app’s image editor and the edit made there, so the user can still move and resize the pictures on top before saving. Give save only when the user wants a finished file now.'
                : 'Pictures to put on top of this one, after the other changes, flattened into the result (in the image editor the user has open, they stay layers that can still be moved and resized).',
            ),
        }
      : {}),
    resize_width: z.number().positive().optional().describe('Scale the finished picture down to this width in pixels; the height follows. Never up.'),
    remove_background: z
      .boolean()
      .optional()
      .describe(
        opts.local
          ? 'Make the background transparent, around the subject: after any crop, rotation or flip, before the other changes. PNG and WebP keep the transparency; a copy of a JPEG is saved as a PNG so it can (saved over the JPEG, the background turns black).'
          : 'Not available here: when true nothing is changed, and the answer says where in the full app the background can be removed.',
      ),
    save: schemas.transform_image.shape.save,
  };
  /** The edit as the app's operations, in the order they are applied. */
  const operationsOf = (e: Record<string, unknown>): Record<string, unknown>[] => {
    const list = (v: unknown) => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);
    return [
      ...(e.crop ? [{ op: 'crop', ...(e.crop as object) }] : []),
      ...(e.rotate ? [{ op: 'rotate', degrees: e.rotate }] : []),
      ...(e.straighten ? [{ op: 'straighten', degrees: e.straighten }] : []),
      ...(e.flip ? [{ op: 'flip', axis: e.flip }] : []),
      ...(e.adjust && Object.keys(e.adjust).length ? [{ op: 'adjust', ...(e.adjust as object) }] : []),
      ...(e.filter ? [{ op: 'filter', name: e.filter }] : []),
      ...list(e.redact).map((r) => ({ op: 'redact', ...r })),
      ...list(e.shapes).map((sh) => ({ op: 'shape', ...sh })),
      ...list(e.text).map((t) => ({ op: 'text', ...t })),
      ...list(e.overlays).map(({ file_id, ...o }) => ({ op: 'overlay', source: file_id, ...o })),
      ...(e.resize_width ? [{ op: 'resize', width: e.resize_width }] : []),
    ];
  };

  server.registerTool(
    'transform_image',
    {
      title: 'Edit a picture',
      description:
        version === 1
          ? "Edit a stored picture (PNG, JPEG or WebP) exactly, with the app's image editor. Give the changes to make: crop, rotate, straighten, flip, adjust the colors, a filter, rectangles to redact, shapes and arrows to draw, text to write, and a width to resize to. They are applied in that order, as one edit, and every pixel you do not name stays as it was. Call view_image first: it reports the picture's width and height. Positions are in pixels of the picture; for redact, shapes and text they are pixels of the picture after any crop, rotation or flip in the same call. By default the result is saved as a new file and the original is kept. The result comes back as a picture: look at it, and if something landed in the wrong place call transform_image again on the original with better numbers. The editing is done by the app, so it must be showing: call open_file with the picture first. If the user has the picture open in the app's image editor, the edit is made there as one undo step and is saved when the user saves."
          : "Edit a stored picture (PNG, JPEG or WebP) exactly, with the app's image editor. Give the changes to make: crop, rotate, straighten, flip, adjust the colors, a filter, rectangles to redact, shapes and arrows to draw, text to write, pictures to put on top (overlays: a logo, a signature, a screenshot), and a width to resize to. They are applied in that order, as one edit, and every pixel you do not name stays as it was. Call view_image first: it reports the picture's width and height. Positions are in pixels of the picture; for redact, shapes and text they are pixels of the picture after any crop, rotation or flip in the same call. By default the result is saved as a new file and the original is kept. The result comes back as a picture: look at it, and if something landed in the wrong place call transform_image again on the original with better numbers. The editing is done by the app, so it must be showing: call open_file with the picture first. If the user has the picture open in the app's image editor, the edit is made there as one undo step and is saved when the user saves.",
      inputSchema: pictureEdit,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ file_id, save, remove_background, ...edit }) =>
      guard(async () => {
        const operations = operationsOf(edit);
        const f = await service.editableImage(file_id);
        if (!EDITABLE_IMAGE_TYPES.includes(f.meta.type)) throw new ToolError(`${f.meta.filename} cannot be edited: only PNG, JPEG and WebP pictures can.`);
        // In the desktop app its window edits the picture with the app's full image editor, background removal included.
        if (opts.local) {
          const steps = withBackgroundRemoval(operations, !!remove_background);
          if (!steps.length) throw new ToolError('Give at least one change to make: crop, rotate, straighten, flip, adjust, filter, redact, shapes, text, overlays, resize_width or remove_background.');
          // Pictures put on top stay layers in the window's image editor unless a finished file is asked for.
          const layered = save === undefined && steps.some((op) => op.op === 'overlay');
          const r = await service.editImageInWindow({ file_id, operations: steps, ...(layered ? {} : { save: save === 'replace' ? 'replace' : 'copy' }) });
          if (!r) return fail(`The ${appName(true)} window is not open, and it edits the picture. Open the app, then try again.`);
          return windowResult(r);
        }
        // Removing a background takes a model the app here cannot load. Said at once, before anything is done,
        // with where it can be done.
        if (remove_background) {
          const where = opts.publicUrl ? ` Open ${f.meta.filename} there: ${opts.publicUrl}/f/${encodeURIComponent(f.meta.id)} , choose Edit, then Magic and Remove background (or ask the assistant there).` : '';
          throw new ToolError(`Removing a background is only available in the full ${appName(!!opts.local)} app, not here.${where} Nothing was changed. The other changes can be made here: call transform_image again without remove_background.`);
        }
        if (!operations.length) throw new ToolError('Give at least one change to make: crop, rotate, straighten, flip, adjust, filter, redact, shapes, text, overlays or resize_width.');
        const r = await service.runImageJob(file_id, operations, save === 'replace' ? 'replace' : 'copy');
        if (!r.ok) return fail(r.error ?? 'The picture could not be edited.');
        const resultId = r.file_id ?? file_id;
        const made = r.saved === false ? null : await service.editableImage(resultId).catch(() => null);
        const note =
          r.saved === false
            ? 'Done in the editor the user has open, as one undo step. It is not saved until the user saves there; tell them so.'
            : save === 'replace'
              ? 'Saved over the file; the version before it is kept.'
              : 'A new file, open in the app; the original is unchanged.';
        const data = { edited: true, file_id: resultId, ...(made ? { filename: made.meta.filename } : {}), ...(resultId !== file_id ? { source_file_id: file_id } : {}), applied: r.applied ?? [], size: r.size ?? null, saved: r.saved !== false, note, ...service.state() };
        return { content: [{ type: 'text', text: JSON.stringify(data) }, ...(previewContent(r).length ? previewContent(r) : made ? await shownImage(made.file, made.meta.type, made.meta.size) : [])], structuredContent: data };
      }),
  );

  server.registerTool(
    'rename_file',
    {
      title: 'Rename file',
      description: 'Change the title of a document, Markdown document, presentation or spreadsheet, or the name of a stored file (a PDF, video or image), which keeps its extension. Defaults to the open file.',
      inputSchema: { kind: anyKind.optional(), id: z.string().optional(), title: z.string().min(1).max(200) },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ kind: k, id, title }) =>
      guard(() => {
        const target = k && id ? { kind: k, id } : service.open;
        if (!target) return fail('No file is open. Pass kind and id (see list_files).');
        return ok({ file: service.rename(target.kind, target.id, title) });
      }),
  );

  server.registerTool(
    'delete_file',
    {
      title: 'Delete file',
      description: 'Delete a document, Markdown document, presentation, spreadsheet or stored file permanently. Only when the user clearly asks for it.',
      inputSchema: { kind: anyKind, id: fileId },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ kind: k, id }) =>
      guard(async () => {
        await service.delete(k, id);
        return ok({ deleted: id, ...service.state() });
      }),
  );

  const describe = (name: EditTool) => (DESCRIPTIONS[name] ?? schemas[name].description ?? '').replace(/the open (document|presentation|spreadsheet)/g, 'the $1');

  // Image tools also take the image the user attached in the chat (openai/fileParams): the host turns `file`
  // into a download URL, the bytes are stored like an upload, and the address goes where a URL would.
  const inputShape = (name: EditTool): Record<string, z.ZodType> => {
    const shape = schemas[name].shape as Record<string, z.ZodType>;
    const field = IMAGE_TOOLS[name];
    if (!field) return shape;
    return {
      ...shape,
      [field]: (shape[field] as z.ZodString).optional().describe(`${shape[field].description ?? ''} Leave out when passing the attached image as file.`),
      file: attachedFile.optional().describe('An image the user attached in the chat (ChatGPT fills in its download address). Use this instead of an address for attachments.'),
    };
  };
  /** The image tools fetch a picture from the web address they are given, which a reviewer counts as the open world. */
  const fetchesFromWeb = (name: EditTool) => !!IMAGE_TOOLS[name];
  const imageMeta = (name: EditTool) => (IMAGE_TOOLS[name] ? { _meta: { 'openai/fileParams': ['file'] } } : {});
  const resolveImage = async (name: EditTool, input: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const field = IMAGE_TOOLS[name];
    if (!field) return input;
    const { file, ...rest } = input as Record<string, unknown> & { file?: z.infer<typeof attachedFile> };
    const url = typeof rest[field] === 'string' ? rest[field].trim() : '';
    if (file?.download_url) {
      const { bytes } = await download(file.download_url, opts.fetchFn ?? fetch, MAX_IMPORT_BYTES);
      const type = sniffImageType(bytes) ?? file.mime_type ?? '';
      rest[field] = await service.storeImage(type, bytes);
    } else if (/^https?:/i.test(url) && !service.isOwnImage(url)) {
      // A web image is fetched and stored too: the app runs under a CSP that only allows our own origin,
      // and the model should hear now if the address is not an image.
      const { bytes } = await download(url, opts.fetchFn ?? fetch, MAX_IMPORT_BYTES);
      const type = sniffImageType(bytes);
      if (!type) throw new ToolError(`${url} is not a PNG, JPEG, GIF or WebP image. Give the address of the image file itself, not of a page that shows it.`);
      rest[field] = await service.storeImage(type, bytes);
    } else if (!url) throw new ToolError(`Give ${field} (an https image address) or attach the image as file.`);
    return rest;
  };

  for (const name of DOC_EDIT_TOOLS) {
    server.registerTool(
      name,
      { description: describe(name), inputSchema: { ...inputShape(name), doc_id: optionalDocId }, annotations: { ...ANNOTATIONS[name], openWorldHint: fetchesFromWeb(name) }, ...imageMeta(name) },
      async (args: Record<string, unknown>) =>
        guard(async () => {
          const { doc_id, ...input } = args as Record<string, unknown> & { doc_id?: string };
          // A stored file (a PDF, a web page, a text file) is read like a document, and is not changed.
          const stored = version >= 2 ? service.storedTarget(doc_id) : null;
          if (stored) {
            if (name !== 'read_doc')
              return fail(
                version >= 2
                  ? 'This is a stored file (a PDF, web page, picture or other upload), not a document: read_doc reads its text, but the document tools cannot change it. A text file is changed with edit_file; a PDF, picture or video cannot be changed (import it as a document with import_file to edit its content).'
                  : 'This is a stored file (a PDF, web page, picture or other upload), not a document: read_doc reads its text, but it cannot be changed. To edit its content, import it as a document with import_file.',
              );
            return ok(await service.readStored(stored, typeof input.from === 'number' ? input.from : undefined, typeof input.to === 'number' ? input.to : undefined, version >= 2));
          }
          const target = service.docTarget(doc_id);
          if (!target) return fail('No document is open in the app. Pass doc_id (see list_files), or open one with open_file.');
          if (target.kind === 'markdown') return okEdit(await service.editMarkdown(target.id, name, input));
          return okEdit(await service.editDoc(target.id, name, await resolveImage(name, input)));
        }),
    );
  }

  for (const name of DECK_EDIT_TOOLS) {
    server.registerTool(
      name,
      // Version 1's edit_elements stays as it was submitted (no tables).
      { description: name === 'edit_elements' && version === 1 ? (editElementsV1.description ?? '') : describe(name), inputSchema: { ...(name === 'edit_elements' && version === 1 ? editElementsV1 : schemas[name]).shape, deck_id: optionalDeckId }, annotations: { ...ANNOTATIONS[name], openWorldHint: false } },
      async (args: Record<string, unknown>) =>
        guard(async () => {
          const { deck_id, ...input } = args as Record<string, unknown> & { deck_id?: string };
          const id = service.target('deck', deck_id);
          if (!id) return fail('No presentation is open in the app. Pass deck_id (see list_files), or open one with open_file.');
          return okEdit(await service.editDeck(id, name, name === 'edit_elements' && version === 1 ? arcsAsEllipseBoxes(input) : input));
        }),
    );
  }

  for (const name of SHEET_EDIT_TOOLS) {
    // Version 1 stays as it was submitted: it has no charts.
    if (version === 1 && (name === 'add_chart' || name === 'edit_chart' || name === 'delete_chart')) continue;
    server.registerTool(
      name,
      { description: describe(name), inputSchema: { ...inputShape(name), sheet_id: optionalSheetId }, annotations: { ...ANNOTATIONS[name], openWorldHint: fetchesFromWeb(name) }, ...imageMeta(name) },
      async (args: Record<string, unknown>) =>
        guard(async () => {
          const { sheet_id, ...input } = args as Record<string, unknown> & { sheet_id?: string };
          const id = service.target('sheet', sheet_id);
          if (!id) return fail('No spreadsheet is open in the app. Pass sheet_id (see list_files), or open one with open_file.');
          return okEdit(await service.editSheet(id, name, await resolveImage(name, input)));
        }),
    );
  }

  // --- Tools only the desktop app's window can run (it draws the slide, or moves the selection there) ---

  if (opts.local) {
    const windowOnly = [
      {
        name: 'render_slide',
        kind: 'deck',
        description:
          'Take a picture of a slide of the presentation open in the app, drawn exactly as the editor and present mode draw it (same fonts, theme, images, wrapping), to check your work: the PNG comes with the result. Returns its stored /api/images/... address, its size in pixels, and "overflow": text boxes and shape labels whose rendered text is taller or wider than their box (box and rendered sizes in points).',
        inputSchema: { slide: schemas.render_slide.shape.slide, scale: schemas.render_slide.shape.scale, deck_id: optionalDeckId },
        readOnly: true,
      },
      {
        name: 'export_deck',
        kind: 'deck',
        description: 'Export the presentation open in the app as a PDF, every slide drawn exactly as present mode draws it, one 960×540 page per slide. The PDF is saved beside it in the folder. Returns file_id, filename and pages; open_file shows it.',
        inputSchema: { format: schemas.export_deck.shape.format, deck_id: optionalDeckId },
        readOnly: false,
      },
      {
        name: 'select_range',
        kind: 'sheet',
        description: 'Select a range of the spreadsheet open in the app and scroll to it, to show the user something.',
        inputSchema: { ...schemas.select_range.shape, sheet_id: optionalSheetId },
        readOnly: true,
      },
    ] as const;
    for (const t of windowOnly) {
      server.registerTool(t.name, { description: t.description, inputSchema: t.inputSchema, annotations: { readOnlyHint: t.readOnly, destructiveHint: false, openWorldHint: false } }, async (args: Record<string, unknown>) =>
        guard(async () => {
          const { deck_id, sheet_id, ...input } = args as Record<string, unknown> & { deck_id?: string; sheet_id?: string };
          const id = service.target(t.kind, t.kind === 'deck' ? deck_id : sheet_id);
          if (!id) return fail(`No ${t.kind === 'deck' ? 'presentation' : 'spreadsheet'} is open in the app. Open one with open_file.`);
          return okEdit(await service.runInWindow(t.kind, id, t.kind === 'deck' ? 'deck_id' : 'sheet_id', t.name, input));
        }),
      );
    }
  }

  // --- Tools for the app only (hidden from the model) ------------------------------------

  if (!appTools) return server;
  const appOnly = (readOnly: boolean) => ({ _meta: { ui: { visibility: ['app'] }, 'openai/widgetAccessible': true }, annotations: { readOnlyHint: readOnly, destructiveHint: false, openWorldHint: false } });

  server.registerTool('getting_started', { description: "The user's copy of the Getting started guide (made the first time), opened in the app.", inputSchema: {}, ...appOnly(false) }, async () =>
    guard(async () => {
      const file = await service.gettingStarted();
      service.setOpen({ kind: 'deck', id: file.id });
      return ok({ file, ...service.state() });
    }),
  );

  // The app asks every few seconds while it is showing, and takes the picture edits waiting for it.
  server.registerTool('app_state', { description: 'Which file is open and its revision, and the picture edits for the app to make.', inputSchema: {}, ...appOnly(true) }, async () => {
    const jobs = service.takeImageJobs();
    return ok({ ...service.state(), ...(jobs.length ? { jobs } : {}) });
  });

  server.registerTool(
    'image_job_result',
    {
      description: 'What the app did with a picture edit it took from app_state.',
      inputSchema: {
        job_id: z.string(),
        ok: z.boolean(),
        error: z.string().max(2000).optional(),
        applied: z.array(z.string().max(300)).max(40).optional(),
        width: z.number().optional(),
        height: z.number().optional(),
        file_id: z.string().optional(),
        saved: z.boolean().optional(),
        preview_data: z.string().max(4_000_000).optional().describe('The picture as it is now, reduced, in base64.'),
        preview_type: z.string().max(40).optional(),
      },
      ...appOnly(false),
    },
    async ({ job_id, ok: done, error, applied, width, height, file_id, saved, preview_data, preview_type }) =>
      guard(() =>
        ok({ taken: service.finishImageJob(job_id, { ok: done, error, applied, size: width && height ? { width, height } : null, file_id, saved, ...(preview_data && preview_type ? { preview: { data: preview_data, type: preview_type } } : {}) }) }),
      ),
  );

  server.registerTool(
    'set_open_file',
    {
      description: 'The app reports which file it shows (none when omitted) and where the user is in it.',
      inputSchema: {
        kind: anyKind.optional(),
        id: z.string().optional(),
        cursor_block: z.number().int().min(1).optional(),
        selected_text: z.string().max(500).optional(),
        slide: z.number().int().min(1).optional(),
        selection: z.array(z.string()).max(50).optional(),
        tab: z.string().optional(),
      },
      ...appOnly(false),
    },
    async ({ kind: k, id, cursor_block, selected_text, slide, selection, tab }) =>
      guard(() => {
        service.setOpen(k && id ? { kind: k, id } : null, { cursor_block, selected_text, slide, selection, tab });
        return ok({ ...service.state() });
      }),
  );

  // The library's listing, with the dates it shows and sorts by.
  server.registerTool('library_files', { description: "Every file of the account for the app's library, with when each was made and last changed.", inputSchema: {}, ...appOnly(true) }, async () => guard(() => ok({ files: service.list() })));

  server.registerTool('get_file', { description: 'Load a whole file for the editor.', inputSchema: { kind, id: fileId }, ...appOnly(true) }, async ({ kind: k, id }) => guard(async () => ok({ ...(await service.get(k, id)) })));

  server.registerTool(
    'save_file',
    {
      description: 'Save a whole file from the editor. Fails when the revision is stale.',
      inputSchema: { kind, id: fileId, rev: z.string().describe('The revision the editor loaded.'), data: z.looseObject({}).describe('The whole file.') },
      ...appOnly(false),
    },
    async ({ kind: k, id, rev, data }) =>
      guard(async () => {
        try {
          return ok({ ...(await service.save(k, id, data as unknown as FileData, rev)) });
        } catch (e) {
          if (e instanceof ConflictError) return { content: [{ type: 'text', text: e.message }], structuredContent: { conflict: true, rev: e.rev }, isError: true };
          throw e;
        }
      }),
  );

  server.registerTool(
    'upload_ticket',
    { description: 'A one-time ticket and URL for the app to upload a file to import.', inputSchema: {}, ...appOnly(false) },
    async () => guard(() => ok({ ticket: service.hub.issueTicket(service.userId), url: `${opts.publicUrl ?? ''}/plugin/import` })),
  );

  server.registerTool(
    'file_link',
    { description: 'A stored file (a PDF, video or image) and an address the app can load it from for the next few hours.', inputSchema: { id: fileId }, ...appOnly(true) },
    async ({ id }) => guard(() => ok({ ...service.fileLink(id) })),
  );

  server.registerTool(
    'upload_image',
    { description: 'Store an image pasted or dropped into the editor.', inputSchema: { type: z.string(), data: z.string().describe('Base64 bytes.') }, ...appOnly(false) },
    async ({ type, data }) => guard(async () => ok({ src: await service.uploadImage(type, data) })),
  );

  return server;
}
