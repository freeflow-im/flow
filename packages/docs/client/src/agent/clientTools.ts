// Sheet tools the agent calls, run in the browser against the open spreadsheet's live store.
// Edits go through SheetController.runAgent, so they recalculate, render and autosave like the user's
// own edits, and everything from one agent request undoes as a single step.
import { applyTextEdits, TextEditError } from '../../../shared/textEdits.ts';
import { addChart, deleteChart, editChart } from './chartTools.ts';
import { MAX_COLS, colToName, nameToCol, rangeToString, type Range } from '../../../shared/cellref.ts';
import { IMAGE_MEDIA_TYPES, MAX_IMAGES_PER_MESSAGE, type AgentImage, type ClientToolCall } from '../../../shared/agent/protocol.ts';
import { toCellInput, type FetchResult } from '../../../shared/connectors.ts';
import { findTab, readRange, resolveRange, sheetOverview, splitTabRange } from '../../../shared/agent/sheetRead.ts';
import { hyperlinkFormula, safeLinkUrl } from '../../../shared/links.ts';
import { checkCellImage, hasContent, isDataImage, isTextFileType, type CellStyle, type StoredFile, type Tab } from '../../../shared/types.ts';
import { CellError } from '../../../shared/values.ts';
import { deckOutline } from '../../../shared/deck.ts';
import type { DeckController } from '../deck/controller.ts';
import type { SheetController } from '../state/controller.ts';
import * as ops from '../state/ops.ts';
import type { WorkbookStore } from '../state/store.ts';
import { DECK_TOOLS, deckConfirmationFor, exportDeckTool, renderSlideTool, runDeckTool, type RenderSlideEnv } from './deckTools.ts';
import { DOC_TOOLS, docConfirmationFor, runDocTool } from './docTools.ts';
import { markdownConfirmationFor, markdownOutline, markdownToolProblem, runMarkdownTool } from './markdownTools.ts';
import type { MarkdownController } from '../markdown/controller.ts';
import { docOutline } from '../../../shared/agent/docRead.ts';
import type { DocController } from '../doc/controller.ts';
import { EDIT_NOT_ALLOWED, TransactionRefused, xlsxGuard } from '../state/store.ts';
import { withFilePictures } from './filePictures.ts';
import { IMAGE_TOOLS, replacesImageFile, runImageTool, type ImageToolEnv } from './imageTools.ts';
import { ToolError } from './toolError.ts';
import { appName } from '../brand.ts';

export { ToolError };

/** What open_doc resolves with: the controller of the text or Markdown document now open. */
export type OpenedDoc = { kind: 'doc'; ctl: DocController } | { kind: 'markdown'; ctl: MarkdownController };

export interface ClientToolEnv extends Omit<RenderSlideEnv, 'deck' | 'uploadImage'>, ImageToolEnv {
  /** The open spreadsheet, or null on other pages. */
  ctl: SheetController | null;
  /** The open presentation, or null on other pages. */
  deck: DeckController | null;
  /** The open text document, or null on other pages. */
  doc: DocController | null;
  /** The open Markdown document, or null on other pages (the content tools act on it as on a text document). */
  markdown?: MarkdownController | null;
  /** Undo group for this agent request. */
  group: string;
  /** Navigate to a spreadsheet and resolve once it has loaded. */
  openSheet(id: string): Promise<SheetController>;
  /** Navigate to a presentation and resolve once it has loaded. */
  openDeck(id: string): Promise<DeckController>;
  /** Navigate to a text or Markdown document and resolve once it has loaded. */
  openDoc(id: string): Promise<OpenedDoc>;
  /** The user's stored files, most recent first. */
  listFiles?(): Promise<StoredFile[]>;
  /** Navigate to a stored file's preview tab; resolves with the file once it is shown. */
  openFile?(id: string): Promise<StoredFile>;
  /** A stored file with its bytes. */
  readFile?(id: string): Promise<{ file: StoredFile; data: ArrayBuffer }>;
  /** Replace a stored text file's contents, or (revert) put back the version before the last replacement. */
  writeFile?(id: string, text: string): Promise<StoredFile>;
  revertFile?(id: string): Promise<StoredFile>;
  /** A picture's size in pixels, which positions in transform_image are given in. */
  imageSize?(data: ArrayBuffer, type: string): Promise<{ width: number; height: number }>;
  /** A stored picture made ready for Claude to look at (scaled down if it is large). */
  toAgentImage?(file: StoredFile, data: ArrayBuffer): Promise<AgentImage>;
  /** Make an edited copy of a stored picture with the image model; resolves with the new file. */
  editImage?(id: string, prompt: string): Promise<StoredFile>;
  /** Queue a change to the app's own code; resolves with the job id. */
  requestAppChange(title: string, spec: string): Promise<{ id: string }>;
  /** Queue a background research task; resolves with the job id. */
  requestResearch(title: string, task: string, includeSheet: boolean): Promise<{ id: string; sheetIncluded: boolean }>;
  /** Store an image file on the server; resolves to its URL for a cell. */
  uploadImage(file: Blob): Promise<string>;
  /** Run a connector query on the server (which holds the credentials), or return an earlier result by handle. */
  fetchConnectorData(connectionId: string, body: { dataset: string; params: Record<string, unknown>; handle?: string }): Promise<FetchResult>;
}

const MAX_WRITE_CELLS = 20_000;
const CONFIRM_CLEAR_CELLS = 100;

type Input = Record<string, unknown>;
type CellInput = string | number | boolean | null;

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

function requireSheet(env: ClientToolEnv): SheetController {
  if (!env.ctl) {
    const open = env.deck ? 'A presentation' : env.doc || env.markdown ? 'A document' : null;
    throw new ToolError(open ? `${open} is open, not a spreadsheet. Use list_sheets to find one and open_sheet to open it.` : 'No spreadsheet is open. Use list_sheets to find one and open_sheet to open it.');
  }
  return env.ctl;
}

function tabOf(ctl: SheetController, name: string | undefined): Tab {
  const t = findTab(ctl.store.workbook, name, ctl.tab.id);
  if (typeof t === 'string') throw new ToolError(t);
  return t;
}

function rangeOf(ctl: SheetController, tab: string | undefined, range: string): { tab: Tab; range: Range } {
  const r = resolveRange(ctl.store.workbook, tab, range, ctl.tab.id);
  if (typeof r === 'string') throw new ToolError(r);
  return r;
}

function columnOf(letters: string): number {
  return nameToCol(letters.toUpperCase());
}

function source(ctl: SheetController) {
  return { workbook: ctl.store.workbook, engine: ctl.store.engine };
}

/** Bring the tab the agent is working on into view. */
function show(ctl: SheetController, tabId: string) {
  if (ctl.activeTabId !== tabId) ctl.switchTab(tabId);
}

/** Cells in a range that evaluate to an error, so the agent can fix its formulas. */
function errorsIn(ctl: SheetController, tab: Tab, rg: Range, limit = 20): { cell: string; error: string }[] {
  const out: { cell: string; error: string }[] = [];
  for (const { r, c, key } of ops.existingKeysIn(tab, rg)) {
    const v = ctl.store.value(tab.id, r, c);
    if (v instanceof CellError) out.push({ cell: key, error: v.message ? `${v.code} ${v.message}` : v.code });
    if (out.length >= limit) break;
  }
  return out;
}

function nonEmptyCount(tab: Tab, rg: Range): number {
  return ops.existingKeysIn(tab, rg).filter(({ key }) => hasContent(tab.cells[key])).length;
}

/** A question to ask the user before running a destructive call, or null if it can run straight away. */
export function confirmationFor(call: ClientToolCall, ctl: SheetController | null, deck: DeckController | null = null, doc: DocController | null = null, markdown: MarkdownController | null = null): string | null {
  const i = call.input;
  if (call.name === 'request_app_change') {
    // The spec is what the coding agent acts on, and the assistant may have written it after reading a web
    // page or a document: show it, so the user approves the change itself and not only its name.
    const spec = String(i.spec ?? '').trim();
    return `Change the app: ${String(i.title ?? '')}? A coding agent will edit the app's source code, run its tests and restart it. This takes a few minutes.\n\nWhat it will be asked to do:\n${spec.length > 1200 ? `${spec.slice(0, 1200)}…` : spec}`;
  }
  if (replacesImageFile(call)) return 'Save the edited picture over the original file? The version before it is kept, and can be put back once.';
  if (DECK_TOOLS.has(call.name)) return deckConfirmationFor(call, deck);
  if (DOC_TOOLS.has(call.name)) return markdown ? markdownConfirmationFor(call, markdown) : docConfirmationFor(call, doc);
  if (!ctl) return null;
  try {
    switch (call.name) {
      case 'delete_tab':
        return `Delete the tab “${tabOf(ctl, str(i.tab)).name}”?`;
      case 'delete_rows': {
        const [a, b] = [Number(i.from_row), Number(i.to_row)].sort((x, y) => x - y);
        return `Delete ${a === b ? `row ${a}` : `rows ${a}–${b}`} of “${tabOf(ctl, str(i.tab)).name}”?`;
      }
      case 'delete_columns': {
        const [a, b] = [String(i.from_column), String(i.to_column)].map((s) => s.toUpperCase()).sort((x, y) => columnOf(x) - columnOf(y));
        return `Delete ${a === b ? `column ${a}` : `columns ${a}–${b}`} of “${tabOf(ctl, str(i.tab)).name}”?`;
      }
      case 'clear_range': {
        if (i.what === 'formats') return null;
        const { tab, range } = rangeOf(ctl, str(i.tab), String(i.range));
        const n = nonEmptyCount(tab, range);
        return n > CONFIRM_CLEAR_CELLS ? `Clear ${n} cells in ${tab.name}!${rangeToString(range)}?` : null;
      }
      default:
        return null;
    }
  } catch {
    return null; // The call will fail with a useful error when it runs.
  }
}

/** Run a client tool. Returns the result for Claude; throws ToolError for errors Claude should see. */
/** Attach a stored picture to the message that carries the tool results; returns what to tell Claude about it. */
async function attachPicture(env: ClientToolEnv, file: StoredFile, data: ArrayBuffer): Promise<string> {
  if (!IMAGE_MEDIA_TYPES.has(file.type)) throw new ToolError(`${file.filename} is not a picture that can be shown (PNG, JPEG, GIF or WebP).`);
  if (!env.toAgentImage || !env.attachImage) throw new ToolError('Pictures cannot be looked at here.');
  return env.attachImage(await env.toAgentImage(file, data))
    ? 'Attached to this message after the tool results. Look at it before answering.'
    : `Not attached: at most ${MAX_IMAGES_PER_MESSAGE} pictures fit in one message. Call view_image again for this file.`;
}

export async function runClientTool(call: ClientToolCall, env: ClientToolEnv): Promise<string> {
  // A stored picture file given where a picture goes (on a slide, in a document, in a cell) is stored as a
  // picture, and that address used. A Markdown document keeps addresses as the text they are.
  if (DECK_TOOLS.has(call.name) || call.name === 'set_cell_image' || (DOC_TOOLS.has(call.name) && !(env.markdown && !env.doc))) call = { ...call, input: await withFilePictures(call.input, env) };
  const i = call.input;
  if (call.name === 'request_app_change') {
    const { id } = await env.requestAppChange(String(i.title), String(i.spec));
    return JSON.stringify({
      job_id: id,
      status: 'queued',
      note: 'The change starts after this reply ends. Tell the user it is in progress and stop; you will get a message when it is live.',
    });
  }
  if (call.name === 'request_research') {
    const includeSheet = i.include_open_sheet !== false;
    if (includeSheet && env.ctl) await env.ctl.saver.flush(); // the export reads the saved file
    const { id, sheetIncluded } = await env.requestResearch(String(i.title), String(i.task), includeSheet);
    return JSON.stringify({
      job_id: id,
      status: 'queued',
      sheet_included: sheetIncluded,
      note: 'The research starts after this reply ends. Tell the user it is running and stop; you will get a message with the report.',
    });
  }
  if (call.name === 'open_sheet') {
    const ctl = await env.openSheet(String(i.sheet_id));
    return JSON.stringify({ opened: true, ...sheetOverview(source(ctl), { activeTabId: ctl.tab.id, selection: ctl.sel.ranges.map(rangeToString) }) });
  }
  if (call.name === 'open_deck') {
    const deck = await env.openDeck(String(i.deck_id));
    return JSON.stringify({ opened: true, ...deckOutline(deck.deck, deck.current) });
  }
  if (call.name === 'render_slide') return renderSlideTool(call, env);
  if (call.name === 'export_deck') return exportDeckTool(call, env);
  if (call.name === 'list_files') {
    if (!env.listFiles) throw new ToolError('Stored files are not available here.');
    const q = typeof i.query === 'string' ? i.query.trim().toLowerCase() : '';
    const all = (await env.listFiles()).filter((f) => !q || f.filename.toLowerCase().includes(q));
    return JSON.stringify({
      total: all.length,
      files: all.slice(0, 50).map((f) => ({ id: f.id, filename: f.filename, type: f.type, size: f.size, created_at: f.createdAt, url: f.url, download_url: f.downloadUrl })),
    });
  }
  if (call.name === 'open_file') {
    if (!env.openFile) throw new ToolError('Stored files are not available here.');
    const f = await env.openFile(String(i.file_id));
    return JSON.stringify({ opened: true, file_id: f.id, filename: f.filename, type: f.type, size: f.size });
  }
  if (call.name === 'read_file') {
    if (!env.readFile) throw new ToolError('Stored files are not available here.');
    const { file, data } = await env.readFile(String(i.file_id));
    const bytes = new Uint8Array(data);
    // Text only: a PDF, picture or video has nothing to read as characters.
    if (!isTextFileType(file.type) || bytes.subarray(0, 8000).includes(0)) {
      throw new ToolError(`${file.filename} is not a text file, so it cannot be read. Only web pages and other text files can.`);
    }
    const text = new TextDecoder('utf-8').decode(bytes).replace(/^\uFEFF/, '');
    const offset = Math.min(typeof i.offset === 'number' ? i.offset : 0, text.length);
    const end = Math.min(text.length, offset + (typeof i.max_chars === 'number' ? i.max_chars : 30_000));
    return JSON.stringify({ file_id: file.id, filename: file.filename, type: file.type, total_chars: text.length, offset, text: text.slice(offset, end), ...(end < text.length ? { more: true, next_offset: end } : {}) });
  }
  if (call.name === 'view_image') {
    if (!env.readFile) throw new ToolError('Stored files are not available here.');
    const { file, data } = await env.readFile(String(i.file_id));
    // Its size in pixels, when it can be measured: what you are shown may be scaled down.
    const pixels = await env.imageSize?.(data, file.type).catch(() => undefined);
    return JSON.stringify({ file_id: file.id, filename: file.filename, type: file.type, size: file.size, ...(pixels ? { width: pixels.width, height: pixels.height } : {}), image: await attachPicture(env, file, data) });
  }
  if (IMAGE_TOOLS.has(call.name)) return runImageTool(call, env, (file, data) => attachPicture(env, file, data));
  if (call.name === 'edit_image') {
    if (!env.editImage || !env.readFile) throw new ToolError('Pictures cannot be edited here.');
    const made = await env.editImage(String(i.file_id), String(i.prompt));
    // Show the user the result, and Claude too; the edit stands even if either fails.
    let opened = false;
    let image = 'Not attached. Call view_image to look at it.';
    try {
      opened = !!(await env.openFile?.(made.id));
      image = await attachPicture(env, made, (await env.readFile(made.id)).data);
    } catch {
      // Reported in the result.
    }
    return JSON.stringify({ edited: true, file_id: made.id, filename: made.filename, source_file_id: String(i.file_id), note: `A new file${opened ? ', open now' : ''}; the original is unchanged.`, image });
  }
  if (call.name === 'edit_file') {
    if (!env.readFile || !env.writeFile || !env.revertFile) throw new ToolError('Stored files cannot be edited here.');
    const id = String(i.file_id);
    const edits = Array.isArray(i.edits) ? (i.edits as { find: string; replace: string; all?: boolean }[]) : [];
    const modes = Number(edits.length > 0) + Number(typeof i.content === 'string') + Number(i.undo === true);
    if (modes !== 1) throw new ToolError('Give exactly one of edits, content or undo.');
    if (i.undo === true) {
      const f = await env.revertFile(id);
      return JSON.stringify({ undone: true, file_id: f.id, filename: f.filename, size: f.size });
    }
    const { file, data } = await env.readFile(id);
    const bytes = new Uint8Array(data);
    if (!isTextFileType(file.type) || bytes.subarray(0, 8000).includes(0)) throw new ToolError(`${file.filename} is not a text file, so it cannot be edited.`);
    let text = typeof i.content === 'string' ? i.content : new TextDecoder('utf-8').decode(bytes);
    let replacements = 0;
    try {
      ({ text, replacements } = applyTextEdits(text, edits));
    } catch (e) {
      if (e instanceof TextEditError) throw new ToolError(e.message.replace('Read that part', 'Read that part with read_file'));
      throw e;
    }
    const saved = await env.writeFile(id, text);
    return JSON.stringify({ edited: true, file_id: saved.id, filename: saved.filename, ...(edits.length ? { replacements } : {}), total_chars: text.length });
  }
  if (DECK_TOOLS.has(call.name)) return runDeckTool(call, env);
  if (call.name === 'open_doc') {
    const opened = await env.openDoc(String(i.doc_id));
    if (opened.kind === 'markdown') return JSON.stringify({ opened: true, format: 'markdown', ...markdownOutline(opened.ctl.text, { cursor: opened.ctl.cursor }) });
    return JSON.stringify({ opened: true, ...docOutline(opened.ctl.doc, { cursorBlock: opened.ctl.cursorBlock() }) });
  }
  if (DOC_TOOLS.has(call.name)) {
    if (env.markdown && !env.doc) {
      const problem = markdownToolProblem(call.name);
      if (problem) throw new ToolError(problem);
      return runMarkdownTool(call, env.markdown);
    }
    return runDocTool(call, env);
  }

  const ctl = requireSheet(env);
  const run = (fn: Parameters<SheetController['runAgent']>[1]) => {
    try {
      return ctl.runAgent(env.group, fn);
    } catch (e) {
      // A CSV or Excel file refuses what it cannot store (see csvGuard, xlsxGuard), and an Excel file holding
      // things the app cannot keep refuses everything until the user allows editing it: their decisions.
      if (e instanceof TransactionRefused && e.message === EDIT_NOT_ALLOWED) {
        throw new ToolError(
          'Nothing was changed: this Excel file holds things the app cannot keep (such as charts, borders or comments), so it is read-only until the user allows editing it, which removes those from the file. Tell the user, and that they allow it with the "Read-only" button next to its name; continue only after they have.',
        );
      }
      if (e instanceof TransactionRefused && ctl.store.guard === xlsxGuard) {
        throw new ToolError(
          `Nothing was changed: this is an Excel file, which cannot hold ${e.message.toLowerCase()}. Tell the user that this needs the file kept as a ${appName()} spreadsheet instead of an Excel file (they are offered that when they make such a change themselves), and continue only after they have.`,
        );
      }
      if (e instanceof TransactionRefused) {
        throw new ToolError(
          `Nothing was changed: this file is a CSV file, which can only hold plain cell values, and this needs ${e.message.toLowerCase()}. Tell the user it has to be converted to a spreadsheet first (File → Convert to spreadsheet), and continue only after they have converted it.`,
        );
      }
      throw e;
    }
  };

  switch (call.name) {
    case 'get_sheet_overview':
      return JSON.stringify(sheetOverview(source(ctl), { activeTabId: ctl.tab.id, selection: ctl.sel.ranges.map(rangeToString) }));

    case 'read_range': {
      const { tab, range } = rangeOf(ctl, str(i.tab), String(i.range));
      return JSON.stringify(readRange(source(ctl), tab, range, { formulas: !!i.include_formulas, formats: !!i.include_formats }));
    }

    case 'write_range': {
      const { tab: prefix, range: startRef } = splitTabRange(String(i.start));
      const tab = tabOf(ctl, prefix ?? str(i.tab));
      const m = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(startRef);
      if (!m) throw new ToolError(`"${i.start}" is not a cell address. Use one cell, such as A1.`);
      const r0 = Number(m[2]) - 1;
      const c0 = columnOf(m[1]);
      const rows = i.rows as CellInput[][];
      const nRows = rows.length;
      const nCols = Math.max(...rows.map((r) => r.length));
      if (nRows * nCols > MAX_WRITE_CELLS) throw new ToolError(`That is more than ${MAX_WRITE_CELLS} cells; write it in smaller blocks.`);
      if (c0 + nCols > MAX_COLS) throw new ToolError('That would go past the last column.');
      let written = 0;
      run((tx) => {
        if (r0 + nRows > tab.rows) tx.setTabProp(tab.id, 'rows', r0 + nRows);
        if (c0 + nCols > tab.cols) tx.setTabProp(tab.id, 'cols', c0 + nCols);
        rows.forEach((row, dr) =>
          row.forEach((v, dc) => {
            if (v === null || v === undefined) return;
            ops.setInput(tx, tab.id, r0 + dr, c0 + dc, typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : String(v));
            written++;
          }),
        );
      });
      show(ctl, tab.id);
      const rg = { r1: r0, c1: c0, r2: r0 + nRows - 1, c2: c0 + nCols - 1 };
      const errors = errorsIn(ctl, tab, rg);
      return JSON.stringify({ wrote: `${tab.name}!${rangeToString(rg)}`, cells: written, ...(errors.length ? { cells_with_errors: errors } : {}) });
    }

    case 'clear_range': {
      const { tab, range } = rangeOf(ctl, str(i.tab), String(i.range));
      const what = (str(i.what) ?? 'contents') as 'contents' | 'formats' | 'all';
      run((tx) => {
        if (what === 'contents') ops.clearContents(tx, tab.id, [range]);
        else if (what === 'formats') ops.clearFormatting(tx, tab.id, [range]);
        else for (const { key } of ops.existingKeysIn(tab, range)) tx.setCell(tab.id, key, undefined);
      });
      show(ctl, tab.id);
      return JSON.stringify({ cleared: `${tab.name}!${rangeToString(range)}`, what });
    }

    case 'format_range': {
      const { tab, range } = rangeOf(ctl, str(i.tab), String(i.range));
      // Only the properties given change; undefined removes one (see ops.applyStyle).
      const patch: Partial<Record<keyof CellStyle, unknown>> = {};
      if ('bold' in i) patch.b = i.bold;
      if ('italic' in i) patch.i = i.italic;
      if ('underline' in i) patch.u = i.underline;
      if ('strikethrough' in i) patch.s = i.strikethrough;
      if ('wrap' in i) patch.wrap = i.wrap;
      if ('text_color' in i) patch.color = i.text_color || undefined;
      if ('fill_color' in i) patch.bg = i.fill_color || undefined;
      if ('align' in i) patch.align = i.align === 'default' ? undefined : i.align;
      if ('number_format' in i) patch.fmt = i.number_format === 'general' ? undefined : i.number_format;
      if ('decimals' in i) patch.dp = i.decimals;
      if (!Object.keys(patch).length) throw new ToolError('Pass at least one formatting property.');
      run((tx) => ops.applyStyle(tx, tab.id, [range], patch as Partial<CellStyle>));
      show(ctl, tab.id);
      return JSON.stringify({ formatted: `${tab.name}!${rangeToString(range)}` });
    }

    case 'insert_rows': {
      const tab = tabOf(ctl, str(i.tab));
      const at = Math.min(Number(i.at_row) - 1, tab.rows);
      run((tx) => ops.insertLines(tx, tab.id, 'row', at, Number(i.count)));
      show(ctl, tab.id);
      return JSON.stringify({ inserted_rows: `${at + 1}:${at + Number(i.count)}`, tab: tab.name });
    }

    case 'delete_rows': {
      const tab = tabOf(ctl, str(i.tab));
      const [a, b] = [Number(i.from_row) - 1, Number(i.to_row) - 1].sort((x, y) => x - y);
      if (a >= tab.rows) throw new ToolError(`The tab only has ${tab.rows} rows.`);
      const to = Math.min(b, tab.rows - 1);
      if (a === 0 && to === tab.rows - 1) throw new ToolError('Cannot delete every row of a tab.');
      run((tx) => ops.deleteLines(tx, tab.id, 'row', a, to));
      show(ctl, tab.id);
      return JSON.stringify({ deleted_rows: `${a + 1}:${to + 1}`, tab: tab.name });
    }

    case 'insert_columns': {
      const tab = tabOf(ctl, str(i.tab));
      const at = Math.min(columnOf(String(i.at_column)), tab.cols);
      if (tab.cols + Number(i.count) > MAX_COLS) throw new ToolError('That would make the tab too wide.');
      run((tx) => ops.insertLines(tx, tab.id, 'col', at, Number(i.count)));
      show(ctl, tab.id);
      return JSON.stringify({ inserted_columns: Number(i.count), before_column: String(i.at_column).toUpperCase(), tab: tab.name });
    }

    case 'delete_columns': {
      const tab = tabOf(ctl, str(i.tab));
      const [a, b] = [columnOf(String(i.from_column)), columnOf(String(i.to_column))].sort((x, y) => x - y);
      if (a >= tab.cols) throw new ToolError(`The tab only has ${tab.cols} columns.`);
      const to = Math.min(b, tab.cols - 1);
      if (a === 0 && to === tab.cols - 1) throw new ToolError('Cannot delete every column of a tab.');
      run((tx) => ops.deleteLines(tx, tab.id, 'col', a, to));
      show(ctl, tab.id);
      return JSON.stringify({ deleted_columns: a === to ? colToName(a) : `${colToName(a)}:${colToName(to)}`, tab: tab.name });
    }

    case 'move_columns': {
      const tab = tabOf(ctl, str(i.tab));
      const [a, b] = [columnOf(String(i.from_column)), columnOf(String(i.to_column ?? i.from_column))].sort((x, y) => x - y);
      const before = columnOf(String(i.before_column));
      if (b >= tab.cols) throw new ToolError(`The tab only has ${tab.cols} columns (A–${colToName(tab.cols - 1)}).`);
      if (before > tab.cols) throw new ToolError(`before_column must be at most ${colToName(tab.cols)} (to move to the end).`);
      if (before >= a && before <= b + 1) throw new ToolError(`before_column ${colToName(before)} is inside or right after the moved columns, so nothing would move.`);
      let start = 0;
      run((tx) => {
        start = ops.moveColumns(tx, tab.id, a, b, before) ?? a;
      });
      show(ctl, tab.id);
      return JSON.stringify({ moved_columns: `${colToName(a)}:${colToName(b)}`, new_range: `${colToName(start)}:${colToName(start + b - a)}`, tab: tab.name });
    }

    case 'sort_range': {
      const { tab, range } = rangeOf(ctl, str(i.tab), String(i.range));
      const col = columnOf(String(i.by_column));
      if (col < range.c1 || col > range.c2) throw new ToolError(`Column ${String(i.by_column).toUpperCase()} is not inside ${rangeToString(range)}.`);
      const ext = ctl.store.engine.extent(tab.id);
      // Whole-column ranges: sort only the used rows, so empty rows don't move to the top.
      const rg = { ...range, r1: range.r1 + (i.has_header ? 1 : 0), r2: Math.min(range.r2, Math.max(ext.rows - 1, range.r1)) };
      if (rg.r2 > rg.r1) run((tx) => ops.sortRange(tx, ctl.store as WorkbookStore<unknown>, tab.id, rg, col, i.ascending !== false));
      show(ctl, tab.id);
      return JSON.stringify({ sorted: `${tab.name}!${rangeToString(rg)}`, by_column: String(i.by_column).toUpperCase(), ascending: i.ascending !== false });
    }

    case 'set_cell_image': {
      const { tab, range } = rangeOf(ctl, str(i.tab), String(i.range));
      let url = String(i.url ?? '').trim();
      const problem = checkCellImage(url);
      if (problem) throw new ToolError(`${problem}.`);
      const n = (range.r2 - range.r1 + 1) * (range.c2 - range.c1 + 1);
      if (n > 100) throw new ToolError(`${rangeToString(range)} has ${n} cells; put an image in at most 100 cells at once.`);
      // Store inline images on the server like uploads, so the workbook only holds a short reference.
      if (isDataImage(url)) url = await env.uploadImage(await (await fetch(url)).blob());
      run((tx) => {
        for (let r = range.r1; r <= range.r2; r++) for (let c = range.c1; c <= range.c2; c++) ops.setImage(tx, tab.id, r, c, url);
      });
      show(ctl, tab.id);
      return JSON.stringify({ image_in: `${tab.name}!${rangeToString(range)}` });
    }

    case 'set_cell_link': {
      const { tab, range } = rangeOf(ctl, str(i.tab), String(i.range));
      const url = safeLinkUrl(String(i.url ?? ''));
      if (!url) throw new ToolError('url must be an http(s) or mailto: URL, such as https://example.com.');
      const n = (range.r2 - range.r1 + 1) * (range.c2 - range.c1 + 1);
      if (n > MAX_WRITE_CELLS) throw new ToolError(`${rangeToString(range)} has ${n} cells; add links to at most ${MAX_WRITE_CELLS} cells at once.`);
      const formula = hyperlinkFormula(url, str(i.label));
      run((tx) => {
        for (let r = range.r1; r <= range.r2; r++) for (let c = range.c1; c <= range.c2; c++) ops.setInput(tx, tab.id, r, c, formula);
      });
      show(ctl, tab.id);
      return JSON.stringify({ linked: `${tab.name}!${rangeToString(range)}`, url, label: ctl.store.display(tab.id, range.r1, range.c1) });
    }

    case 'add_chart': {
      const tab = tabOf(ctl, str(i.tab));
      show(ctl, tab.id);
      return addChart(ctl, tab, i, run);
    }
    case 'edit_chart': {
      const tab = tabOf(ctl, str(i.tab));
      show(ctl, tab.id);
      return editChart(ctl, tab, i, run);
    }
    case 'delete_chart': {
      const tab = tabOf(ctl, str(i.tab));
      show(ctl, tab.id);
      return deleteChart(ctl, tab, i, run);
    }
    case 'set_filter': {
      if (typeof i.range !== 'string') {
        const tab = tabOf(ctl, str(i.tab));
        run((tx) => tx.setTabProp(tab.id, 'filter', undefined));
        return JSON.stringify({ removed_filter: tab.name });
      }
      const { tab, range } = rangeOf(ctl, str(i.tab), i.range);
      const ext = ctl.store.engine.extent(tab.id);
      const r2 = range.r2 === tab.rows - 1 ? Math.max(range.r1 + 1, ext.rows - 1) : Math.max(range.r2, range.r1 + 1);
      const filter = { r1: range.r1, c1: range.c1, r2, c2: range.c2, cols: {} };
      run((tx) => tx.setTabProp(tab.id, 'filter', filter));
      show(ctl, tab.id);
      return JSON.stringify({ filter: `${tab.name}!${rangeToString(filter)}` });
    }

    case 'set_filter_criteria': {
      const tab = tabOf(ctl, str(i.tab));
      const f = tab.filter;
      if (!f) throw new ToolError(`“${tab.name}” has no filter. Use set_filter to add one first.`);
      const letter = String(i.column).toUpperCase();
      const col = columnOf(letter);
      if (col < f.c1 || col > f.c2) throw new ToolError(`Column ${letter} is not inside the filter range ${rangeToString(f)}.`);
      const cols = { ...f.cols };
      if (i.clear) delete cols[col];
      else {
        if (!Array.isArray(i.values)) throw new ToolError('Pass values (or clear: true).');
        // Like unchecking values in the header dropdown: hide every display value not in the list.
        const keep = new Set((i.values as string[]).map((v) => v.toLowerCase()));
        const hidden = new Set<string>();
        for (let r = f.r1 + 1; r <= f.r2; r++) {
          const d = ctl.store.display(tab.id, r, col);
          if (!keep.has(d.toLowerCase())) hidden.add(d);
        }
        const cond = cols[col]?.cond;
        if (hidden.size || (cond && cond.type !== 'none')) cols[col] = { hidden: hidden.size ? [...hidden] : undefined, cond };
        else delete cols[col];
      }
      run((tx) => tx.setTabProp(tab.id, 'filter', { ...f, cols }));
      show(ctl, tab.id);
      const updated = ctl.store.workbook.tabs.find((t) => t.id === tab.id)!;
      const visible = f.r2 - f.r1 - ops.computeHiddenRows(ctl.store as WorkbookStore<unknown>, updated).size;
      return JSON.stringify({ filter: `${tab.name}!${rangeToString(f)}`, column: letter, visible_rows: visible });
    }

    case 'set_column_width': {
      const tab = tabOf(ctl, str(i.tab));
      const m = /^([A-Za-z]{1,3})(?::([A-Za-z]{1,3}))?$/.exec(String(i.columns).trim());
      if (!m) throw new ToolError(`"${i.columns}" is not a column or column range, such as B or B:D.`);
      const [a, b] = [columnOf(m[1]), columnOf(m[2] ?? m[1])].sort((x, y) => x - y);
      run((tx) => {
        const next = { ...tab.colWidths };
        for (let c = a; c <= b; c++) next[c] = Number(i.width);
        tx.setTabProp(tab.id, 'colWidths', next);
      });
      show(ctl, tab.id);
      return JSON.stringify({ columns: String(i.columns).toUpperCase(), width: i.width });
    }

    case 'set_row_height': {
      const tab = tabOf(ctl, str(i.tab));
      const m = /^(\d+)(?::(\d+))?$/.exec(String(i.rows).trim());
      if (!m) throw new ToolError(`"${i.rows}" is not a row or row span, such as 1 or 1:3.`);
      const [a, b] = [Number(m[1]) - 1, Number(m[2] ?? m[1]) - 1].sort((x, y) => x - y);
      if (a < 0) throw new ToolError('Rows are numbered from 1.');
      if (a >= tab.rows) throw new ToolError(`The tab only has ${tab.rows} rows.`);
      const to = Math.min(b, tab.rows - 1);
      run((tx) => {
        const next = { ...tab.rowHeights };
        for (let r = a; r <= to; r++) next[r] = Number(i.height);
        tx.setTabProp(tab.id, 'rowHeights', next);
      });
      show(ctl, tab.id);
      return JSON.stringify({ tab: tab.name, rows: a === to ? `${a + 1}` : `${a + 1}:${to + 1}`, height: i.height });
    }

    case 'freeze': {
      const tab = tabOf(ctl, str(i.tab));
      run((tx) => {
        if (typeof i.rows === 'number') tx.setTabProp(tab.id, 'frozenRows', i.rows || undefined);
        if (typeof i.columns === 'number') tx.setTabProp(tab.id, 'frozenCols', i.columns || undefined);
      });
      show(ctl, tab.id);
      return JSON.stringify({ tab: tab.name, frozen_rows: tab.frozenRows ?? 0, frozen_columns: tab.frozenCols ?? 0 });
    }

    case 'add_tab': {
      const name = str(i.name)?.trim();
      if (name) {
        const problem = ops.validateTabName(ctl.store.workbook.tabs, '', name);
        if (problem) throw new ToolError(problem);
      }
      let id = '';
      run((tx) => {
        id = ops.addTab(tx, ctl.store.workbook.tabs.indexOf(ctl.tab));
        if (name) ops.renameTab(tx, id, name);
      });
      ctl.switchTab(id);
      return JSON.stringify({ added_tab: ctl.tab.name });
    }

    case 'rename_tab': {
      const tab = tabOf(ctl, str(i.tab));
      const name = String(i.name).trim();
      const problem = ops.validateTabName(ctl.store.workbook.tabs, tab.id, name);
      if (problem) throw new ToolError(problem);
      const old = tab.name;
      run((tx) => ops.renameTab(tx, tab.id, name));
      return JSON.stringify({ renamed: old, to: name });
    }

    case 'delete_tab': {
      const tab = tabOf(ctl, str(i.tab));
      if (ctl.store.workbook.tabs.length <= 1) throw new ToolError('Cannot delete the only tab.');
      run((tx) => ops.deleteTab(tx, tab.id));
      return JSON.stringify({ deleted_tab: tab.name });
    }

    case 'ingest_connector_data': {
      const m = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(str(i.start_cell) ?? 'A1');
      if (!m) throw new ToolError(`"${i.start_cell}" is not a cell address. Use one cell, such as A1.`);
      const r0 = Number(m[2]) - 1;
      const c0 = columnOf(m[1]);
      const tabName = str(i.tab)?.trim();
      const existing = tabName ? ctl.store.workbook.tabs.find((t) => t.name.toLowerCase() === tabName.toLowerCase()) : ctl.tab;
      if (!existing && tabName) {
        const problem = ops.validateTabName(ctl.store.workbook.tabs, '', tabName);
        if (problem) throw new ToolError(problem);
      }
      let data: FetchResult;
      try {
        data = await env.fetchConnectorData(String(i.connection_id), {
          dataset: String(i.dataset),
          params: (i.params as Record<string, unknown> | undefined) ?? {},
          handle: str(i.result_handle),
        });
      } catch (e) {
        throw new ToolError(e instanceof Error ? e.message : String(e));
      }
      const nCols = data.columns.length;
      if (!nCols) throw new ToolError('The dataset returned no columns.');
      if (c0 + nCols > MAX_COLS) throw new ToolError('That would go past the last column; use a start_cell further left.');
      const append = i.mode === 'append';
      let tabId = existing?.id ?? '';
      let firstRow = r0;
      let header = true;
      run((tx) => {
        if (!existing) {
          tabId = ops.addTab(tx, ctl.store.workbook.tabs.indexOf(ctl.tab));
          ops.renameTab(tx, tabId, tabName!);
        }
        const tab = tx.tab(tabId);
        if (append) {
          // Below the last non-empty cell in these columns, at or under the start row.
          let last = -1;
          for (const { r, key } of ops.existingKeysIn(tab, { r1: r0, c1: c0, r2: tab.rows - 1, c2: c0 + nCols - 1 })) {
            if (hasContent(tab.cells[key]) && r > last) last = r;
          }
          if (last >= 0) [firstRow, header] = [last + 1, false];
        } else {
          ops.clearContents(tx, tabId, [{ r1: r0, c1: c0, r2: tab.rows - 1, c2: c0 + nCols - 1 }]);
        }
        const lines = header ? [data.columns.map((c) => c.name), ...data.rows] : data.rows;
        if (firstRow + lines.length > tab.rows) tx.setTabProp(tabId, 'rows', firstRow + lines.length);
        if (c0 + nCols > tab.cols) tx.setTabProp(tabId, 'cols', c0 + nCols);
        lines.forEach((row, dr) =>
          data.columns.forEach((col, dc) => {
            const v = toCellInput(row[dc] ?? null, header && dr === 0 ? 'string' : col.type);
            if (v !== null) ops.setInput(tx, tabId, firstRow + dr, c0 + dc, v);
          }),
        );
      });
      show(ctl, tabId);
      const tab = tabOf(ctl, ctl.store.getTab(tabId)!.name);
      const height = data.rows.length + (header ? 1 : 0);
      const rg = { r1: firstRow, c1: c0, r2: firstRow + Math.max(height, 1) - 1, c2: c0 + nCols - 1 };
      return JSON.stringify({
        tab: tab.name,
        ...(existing ? {} : { created_tab: true }),
        range_written: `${tab.name}!${rangeToString(rg)}`,
        rows_written: data.rows.length,
        header_written: header,
        columns: data.columns.map((c) => c.name),
        truncated: data.truncated,
        ...(data.truncated ? { note: 'The row cap was reached; pass a larger params.limit (up to 50000) or a narrower date range for everything.' } : {}),
      });
    }

    case 'select_range': {
      const { tab, range } = rangeOf(ctl, str(i.tab), String(i.range));
      show(ctl, tab.id);
      ctl.selectRange(range);
      return JSON.stringify({ selected: `${tab.name}!${rangeToString(range)}` });
    }

    default:
      throw new ToolError(`Unknown tool ${call.name}.`);
  }
}

/** The cell or range a tool call is about, for jumping to it from the chat. */
export function targetOf(call: { name: string; input: Input }, ctl: SheetController): { tabId: string; range: Range } | null {
  const i = call.input;
  try {
    if (typeof i.range === 'string') {
      const { tab, range } = rangeOf(ctl, str(i.tab), i.range);
      return { tabId: tab.id, range };
    }
    if (call.name === 'write_range' && typeof i.start === 'string' && Array.isArray(i.rows)) {
      const { tab: prefix, range: ref } = splitTabRange(i.start);
      const tab = tabOf(ctl, prefix ?? str(i.tab));
      const p = resolveRange(ctl.store.workbook, tab.name, ref);
      if (typeof p === 'string') return null;
      const rows = i.rows as unknown[][];
      const width = Math.max(1, ...rows.map((r) => (Array.isArray(r) ? r.length : 1)));
      return { tabId: tab.id, range: { r1: p.range.r1, c1: p.range.c1, r2: p.range.r1 + rows.length - 1, c2: p.range.c1 + width - 1 } };
    }
  } catch {
    // Tab or range no longer exists.
  }
  return null;
}
