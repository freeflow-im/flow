// Access to the user's documents and presentations for the ChatGPT plugin: the same SQLite database and JSON
// files the app uses, scoped to one account, plus the headless editing the model's tools need. Edits run the
// app's own tools (client/src/agent/docTools.ts and deckTools.ts) against a controller that has no editor
// view, so a tool behaves exactly as it does inside the app, then the result is saved.
import { openGettingStarted } from '../../server/gettingStarted.ts';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { runClientTool, type ClientToolEnv } from '../../client/src/agent/clientTools.ts';
import { linkDeckTables, runDeckTool } from '../../client/src/agent/deckTools.ts';
import { loadLinkedChart, loadLinkedTable } from '../../server/linkedTable.ts';
import { importExcel, ImportError } from '../../server/xlsxImport.ts';
import { runDocTool } from '../../client/src/agent/docTools.ts';
import { markdownToolProblem, runMarkdownTool } from '../../client/src/agent/markdownTools.ts';
import { MarkdownController } from '../../client/src/markdown/controller.ts';
import { ToolError } from '../../client/src/agent/toolError.ts';
import { DeckController } from '../../client/src/deck/controller.ts';
import { DocController } from '../../client/src/doc/controller.ts';
import { SheetController } from '../../client/src/state/controller.ts';
import { openDb, type DB } from '../../server/db.ts';
import { FolderStore, type Folders } from '../../server/folders.ts';
import { cleanFolderPath } from '../../shared/folders.ts';
import { ImageStore } from '../../server/images.ts';
import { SheetStore, validateWorkbook } from '../../server/sheets.ts';
import { buildSlide, newId, validateDeck, type Deck, type LayoutId, type SlideContent, type ThemeId } from '../../shared/deck.ts';
import { docFromNode, newDoc, validateDoc, type Doc } from '../../shared/doc.ts';
import { markdownToDoc } from '../../shared/docMarkdown.ts';
import { newMarkdownDoc, validateMarkdownDoc, type MarkdownDoc } from '../../shared/markdown.ts';
import { CELL_IMAGE_TYPES, EDITABLE_IMAGE_TYPES, isTextFileType, MAX_CELL_IMAGE_BYTES, MAX_TEXT_EDIT_BYTES, PREVIEW_FILE_TYPES, type SheetMeta, type StoredFile, type Workbook } from '../../shared/types.ts';
import { FileStore, isImageOfType } from '../../server/files.ts';
import { imageSize } from '../../server/imageSize.ts';
import { open } from 'node:fs/promises';
import { importBytes, ImportFileError } from '../../server/importFile.ts';
import { NoTextError, storedFileText, textOutline } from '../../server/storedText.ts';
import { PdfError, pdfToMarkdownFile } from '../../server/pdfMarkdown.ts';
import { PrintError, type Paper, type PdfMaker } from '../../server/pdf.ts';
import { applyTextEdits, TextEditError, type TextEdit } from '../../shared/textEdits.ts';
import { readFile } from 'node:fs/promises';

export { ToolError };

/** A Markdown document (`markdown`) is a plain Markdown file: the document tools that change content work on its text. */
export type FileKind = 'doc' | 'deck' | 'sheet' | 'markdown';
export const FILE_KINDS: readonly FileKind[] = ['doc', 'deck', 'sheet', 'markdown'];
export type FileData = Doc | Deck | Workbook | MarkdownDoc;
/** Everything the library lists: the editable kinds, and stored files (PDFs and videos) that are only shown. */
export type LibraryKind = FileKind | 'file';
export const LIBRARY_KINDS: readonly LibraryKind[] = [...FILE_KINDS, 'file'];

/** A picture a tool returned for the model to look at (render_slide, view_image). */
export interface ToolImage {
  mediaType: string;
  data: string;
}

/** What a tool run in the app's window returned: its JSON text, or the message it failed with. */
export interface LiveResult {
  content: string;
  isError?: boolean;
  images?: ToolImage[];
}

/**
 * Runs a tool on a file in the window that shows it (the desktop app, server/windowTools.ts): the change is
 * made in the open editor, undoable there with the agent's other changes, and a destructive one is asked
 * about there. Null when no window has the file open, and the tool runs here on the stored file instead.
 */
export interface LiveEditor {
  run(file: { kind: FileKind; id: string }, tool: string, input: Record<string, unknown>): Promise<LiveResult | null>;
  /** Run a tool on a stored file in the window in front, whatever it shows (transform_image); null with no window. */
  runInFront?(fileId: string, tool: string, input: Record<string, unknown>): Promise<LiveResult | null>;
}

/** Where an edit tool's result keeps the pictures it returned (not part of its JSON), for the MCP layer to attach. */
export const RESULT_IMAGES = Symbol('result images');

export { importLimit, MAX_IMPORT_BYTES, MAX_PDF_BYTES, sniffImageType } from '../../server/importFile.ts';
/** How long a link to a stored file's bytes works (the player asks for the file in pieces as it plays). */
const FILE_LINK_MS = 6 * 60 * 60 * 1000;

/** How long an upload ticket works. */
export const UPLOAD_TICKET_MS = 5 * 60 * 1000;

/** An edit to a stored picture for the app to make (the image editor needs a browser). */
export interface ImageJob {
  id: string;
  file_id: string;
  /** transform_image's operations, as the model gave them (validated by the tool's schema). */
  operations: unknown[];
  save: 'copy' | 'replace';
  /** Not an edit: only a reduced copy of the picture is wanted, for the model to look at. */
  preview?: boolean;
}

/** What the app did with a job. */
export interface ImageJobResult {
  ok: boolean;
  /** Why not, in words for the model. */
  error?: string;
  /** A line about each operation applied. */
  applied?: string[];
  size?: { width: number; height: number } | null;
  /** The file that holds the result (the copy, or the picture itself). */
  file_id?: string;
  /** False when the edit was made in the editor the user has open, which saves when the user does. */
  saved?: boolean;
  /** The picture as it is now, reduced for the model to look at (base64). */
  preview?: { data: string; type: string };
}

/** How long the app has to do a job, and to take one when no app has asked for its state lately. */
const IMAGE_JOB_MS = 90_000;
const IMAGE_JOB_UNSEEN_MS = 25_000;
const IMAGE_PREVIEW_MS = 20_000;
const APP_SEEN_MS = 15_000;

/** A save with a stale revision: someone else (the app, the model) changed the file first. */
export class ConflictError extends Error {
  rev: string;
  constructor(rev: string) {
    super('The file changed since it was loaded. Reload it and try again.');
    this.rev = rev;
  }
}

export interface FileSummary {
  kind: LibraryKind;
  id: string;
  title: string;
  updated_at: string;
  created_at: string;
  /** Stored files: the MIME type and the size in bytes. */
  type?: string;
  size?: number;
  /** The path of the folder the file is in ('' at the top), where the listing asks for it. */
  folder?: string;
}

/** Where the user is in the open file, as reported by the app's editor. */
export interface Cursor {
  /** Documents: 1-based block holding the cursor, and the selected text. */
  cursor_block?: number;
  selected_text?: string;
  /** Presentations: 1-based slide being viewed, and ids of the selected elements. */
  slide?: number;
  selection?: string[];
  /** Spreadsheets: the active tab's name (selection holds the selected ranges, e.g. "B2:D9"). */
  tab?: string;
}

export interface OpenFile {
  kind: LibraryKind;
  id: string;
  title: string;
  rev: string;
}

export interface AppState {
  open: OpenFile | null;
}

export interface FileHubOptions {
  db: DB;
  dataDir: string;
  /** Public origin of the plugin server; images are served from it. */
  publicUrl: string | null;
  /** The app's own stores, when the plugin runs inside the app (so writes share one queue). */
  sheets?: SheetStore;
  images?: ImageStore;
  files?: FileStore;
  folders?: Folders;
  /** Makes PDFs of files, when the plugin runs inside the app (server/pdf.ts); without it there is no export_pdf. */
  pdf?: PdfMaker;
}

/** Tools the model may run on a document, in the app's vocabulary. */
export const DOC_EDIT_TOOLS = ['read_doc', 'get_doc_info', 'insert_content', 'replace_blocks', 'delete_blocks', 'replace_text', 'format_text', 'format_blocks', 'insert_image', 'set_doc_style', 'set_page_setup'] as const;
export type DocEditTool = (typeof DOC_EDIT_TOOLS)[number];
/** Tools the model may run on a presentation (render_slide needs a browser and is left out). */
export const DECK_EDIT_TOOLS = ['read_deck', 'add_slides', 'update_slide', 'edit_elements', 'delete_slides', 'move_slide', 'set_deck_theme'] as const;
export type DeckEditTool = (typeof DECK_EDIT_TOOLS)[number];
/** Tools the model may run on a spreadsheet (select_range only moves the user's cursor and is left out). */
export const SHEET_EDIT_TOOLS = [
  'get_sheet_overview',
  'read_range',
  'write_range',
  'clear_range',
  'format_range',
  'insert_rows',
  'delete_rows',
  'insert_columns',
  'delete_columns',
  'move_columns',
  'sort_range',
  'set_cell_image',
  'set_cell_link',
  'set_filter',
  'set_filter_criteria',
  'set_column_width',
  'set_row_height',
  'freeze',
  'add_chart',
  'edit_chart',
  'delete_chart',
  'add_tab',
  'rename_tab',
  'delete_tab',
] as const;
export type SheetEditTool = (typeof SHEET_EDIT_TOOLS)[number];

export interface SlideSpec extends SlideContent {
  layout?: LayoutId;
}

const summary = (m: SheetMeta): FileSummary => ({ kind: m.kind as FileKind, id: m.id, title: m.title, updated_at: m.updatedAt, created_at: m.createdAt });

const fileSummary = (f: StoredFile): FileSummary => ({ kind: 'file', id: f.id, title: f.filename, updated_at: f.createdAt, created_at: f.createdAt, type: f.type, size: f.size });

const noun = (kind: LibraryKind) => (kind === 'doc' ? 'document' : kind === 'deck' ? 'presentation' : kind === 'sheet' ? 'spreadsheet' : kind === 'markdown' ? 'Markdown document' : 'file');

/** Apply fn to every image address in a document (the content is plain JSON). */
function mapDocImages(doc: Doc, fn: (src: string) => string): Doc {
  const walk = (node: unknown): unknown => {
    if (!node || typeof node !== 'object') return node;
    let out = node as { type?: string; attrs?: { src?: unknown }; content?: unknown[] };
    if (out.type === 'image' && typeof out.attrs?.src === 'string') out = { ...out, attrs: { ...out.attrs, src: fn(out.attrs.src) } };
    if (Array.isArray(out.content)) out = { ...out, content: out.content.map(walk) };
    return out;
  };
  return { ...doc, content: walk(doc.content) as Doc['content'] };
}

/** Apply fn to every image element's address in a presentation. */
function mapDeckImages(deck: Deck, fn: (src: string) => string): Deck {
  return { ...deck, slides: deck.slides.map((s) => ({ ...s, elements: s.elements.map((e) => (e.type === 'image' ? { ...e, src: fn(e.src) } : e)) })) };
}

/** Apply fn to every cell image's address in a workbook. */
function mapWorkbookImages(wb: Workbook, fn: (src: string) => string): Workbook {
  return {
    ...wb,
    tabs: wb.tabs.map((t) => ({ ...t, cells: Object.fromEntries(Object.entries(t.cells).map(([k, c]) => [k, c.img ? { ...c, img: fn(c.img) } : c])) })),
  };
}

function mapImages<T extends FileData>(kind: FileKind, data: T, fn: (src: string) => string): T {
  if (kind === 'doc') return mapDocImages(data as Doc, fn) as T;
  if (kind === 'deck') return mapDeckImages(data as Deck, fn) as T;
  // Markdown is kept exactly as typed, picture addresses included.
  if (kind === 'markdown') return data;
  return mapWorkbookImages(data as Workbook, fn) as T;
}

/** Whether a stored file is text the model may rewrite: what the app's own editors rewrite (not a PDF, picture or video), with no NUL bytes. */
function editableText(meta: StoredFile, data: Buffer): boolean {
  return isTextFileType(meta.type) && !PREVIEW_FILE_TYPES.includes(meta.type) && !data.subarray(0, 8000).includes(0);
}

/** The app's storage, shared by every account the plugin serves. */
export class FileHub {
  readonly db: DB;
  readonly sheets: SheetStore;
  readonly images: ImageStore;
  readonly files: FileStore;
  readonly folders: Folders;
  readonly pdf: PdfMaker | null;
  readonly publicUrl: string | null;
  private readonly byUser = new Map<string, FileService>();
  /**
   * Told when the model opens a file (open_file, or a file it created or imported), for a host that shows
   * it itself: the desktop app's window goes to it. ChatGPT's app follows app_state instead.
   */
  onShow: ((userId: string, file: { kind: LibraryKind; id: string }) => void) | null = null;
  /** Told when the model rewrote a stored file (edit_file), for a host showing it to load it again. */
  onFileChanged: ((userId: string, id: string) => void) | null = null;
  /** The host's open editors, where the edit tools run on a file open in one (the desktop app); null here otherwise. */
  live: LiveEditor | null = null;
  /** Links to stored files' bytes: the app's iframe has no credentials, so the address carries a token. */
  private readonly fileLinks = new Map<string, { userId: string; id: string; expires: number }>();
  /** One-time tickets letting the app upload a file for import without a bearer token (it has none). */
  private readonly tickets = new Map<string, { userId: string; expires: number; folder?: string }>();

  constructor(opts: FileHubOptions) {
    this.db = opts.db;
    this.sheets = opts.sheets ?? new SheetStore(opts.db, path.join(opts.dataDir, 'sheets'));
    this.images = opts.images ?? new ImageStore(opts.db, path.join(opts.dataDir, 'images'));
    this.files = opts.files ?? new FileStore(opts.db, path.join(opts.dataDir, 'files'));
    this.folders = opts.folders ?? new FolderStore(opts.db);
    this.pdf = opts.pdf ?? null;
    this.publicUrl = opts.publicUrl?.replace(/\/$/, '') ?? null;
  }

  /** Open the app's database in this data directory. */
  static async open(opts: { dataDir: string; publicUrl: string | null }): Promise<FileHub> {
    const hub = new FileHub({ db: openDb(path.join(opts.dataDir, 'app.db')), dataDir: opts.dataDir, publicUrl: opts.publicUrl });
    await hub.init();
    return hub;
  }

  async init(): Promise<void> {
    await this.sheets.init();
    await this.images.init();
    await this.files.init();
  }

  /** The files of one account; the same instance (with its open-file state) for every request of that user. */
  forUser(userId: string): FileService {
    let svc = this.byUser.get(userId);
    if (!svc) {
      svc = new FileService(this, userId);
      this.byUser.set(userId, svc);
    }
    return svc;
  }

  userIdForEmail(email: string): string | null {
    const row = this.db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase()) as { id: string } | undefined;
    return row?.id ?? null;
  }

  /** Who the account is, for ChatGPT's account linking. */
  profile(userId: string): { id: string; email: string } | null {
    const row = this.db.prepare('SELECT id, email FROM users WHERE id = ?').get(userId) as { id: string; email: string } | undefined;
    return row ?? null;
  }

  /**
   * A ticket presented when posting a file to /plugin/import; good for one upload within five minutes. The app
   * asks for one (upload_ticket), and so does an agent uploading a file of its own (upload_file), which may
   * name the folder the file goes in.
   */
  issueTicket(userId: string, folder?: string): string {
    const now = Date.now();
    for (const [k, v] of this.tickets) if (v.expires < now) this.tickets.delete(k);
    const ticket = randomBytes(24).toString('base64url');
    this.tickets.set(ticket, { userId, expires: now + UPLOAD_TICKET_MS, ...(folder ? { folder } : {}) });
    return ticket;
  }

  /** The account a ticket was issued to (and the folder it named), consuming it; null when unknown or expired. */
  redeemTicket(ticket: string | null | undefined): { userId: string; folder?: string } | null {
    if (!ticket) return null;
    const t = this.tickets.get(ticket);
    this.tickets.delete(ticket);
    return t && t.expires >= Date.now() ? { userId: t.userId, folder: t.folder } : null;
  }

  /** A token for reading one stored file's bytes for a few hours; the same one while it has plenty of time left. */
  issueFileLink(userId: string, id: string): string {
    const now = Date.now();
    for (const [k, v] of this.fileLinks) {
      if (v.expires < now) this.fileLinks.delete(k);
      else if (v.userId === userId && v.id === id && v.expires - now > FILE_LINK_MS / 2) return k;
    }
    const token = randomBytes(24).toString('base64url');
    this.fileLinks.set(token, { userId, id, expires: now + FILE_LINK_MS });
    return token;
  }

  /** The stored file a link's token is for, or null when the token is unknown, expired or for another file. */
  fileForLink(token: string | null | undefined, id: string): { meta: StoredFile; file: string } | null {
    const link = token ? this.fileLinks.get(token) : undefined;
    if (!link || link.id !== id || link.expires < Date.now()) return null;
    return this.files.get(link.userId, id);
  }

  /** A stored image by id, whoever owns it: the iframe fetches images without credentials, so the id is the secret. */
  /** True for an image address this server stores (either form). */
  isOwnImage(src: string): boolean {
    return src.startsWith('/api/images/') || (!!this.publicUrl && src.startsWith(`${this.publicUrl}/plugin/img/`));
  }

  imageFile(id: string): { file: string; type: string } | null {
    const row = this.db.prepare('SELECT owner_id FROM images WHERE id = ?').get(id) as { owner_id: string } | undefined;
    return row ? this.images.get(row.owner_id, id) : null;
  }
}

export class FileService {
  readonly hub: FileHub;
  readonly sheets: SheetStore;
  readonly images: ImageStore;
  readonly userId: string;
  readonly publicUrl: string | null;
  /** The file shown in the app, which the model's tools act on by default. */
  open: { kind: LibraryKind; id: string } | null = null;
  cursor: Cursor = {};

  constructor(hub: FileHub, userId: string) {
    this.hub = hub;
    this.sheets = hub.sheets;
    this.images = hub.images;
    this.userId = userId;
    this.publicUrl = hub.publicUrl;
  }

  profile(): { id: string; email: string } {
    return this.hub.profile(this.userId) ?? { id: this.userId, email: '' };
  }

  // --- Listing and lifecycle --------------------------------------------------------

  list(kind?: LibraryKind, query?: string): FileSummary[] {
    const q = query?.trim().toLowerCase();
    const kinds = kind ? [kind] : LIBRARY_KINDS;
    return kinds
      .flatMap((k) => (k === 'file' ? this.hub.files.list(this.userId).map(fileSummary) : this.sheets.list(this.userId, k).map(summary)))
      .filter((m) => !q || m.title.toLowerCase().includes(q))
      .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
  }

  /** The listing with each file's folder, optionally only the files in one folder. */
  listWithFolders(kind?: LibraryKind, query?: string, folder?: string): FileSummary[] {
    const q = query?.trim().toLowerCase();
    const kinds = kind ? [kind] : LIBRARY_KINDS;
    // One folder is read on its own: in the desktop app a whole-library list walks every folder on disk.
    const all =
      folder === undefined
        ? kinds.flatMap((k) => (k === 'file' ? this.hub.files.list(this.userId).map((f) => this.fileRow(f)) : this.sheets.list(this.userId, k).map((m) => this.docRow(m))))
        : [
            ...(kinds.includes('file') ? this.hub.files.listIn(this.userId, folder).map((f) => this.fileRow(f)) : []),
            ...this.sheets
              .listIn(this.userId, folder)
              .filter((m) => kinds.includes(m.kind as LibraryKind))
              .map((m) => this.docRow(m)),
          ];
    return all.filter((m) => (!q || m.title.toLowerCase().includes(q)) && (folder === undefined || m.folder === folder)).sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
  }

  private fileRow(f: StoredFile): FileSummary {
    return { ...fileSummary(f), folder: f.folder ?? '' };
  }

  private docRow(m: SheetMeta): FileSummary {
    return { ...summary(m), folder: m.folder ?? '' };
  }

  /**
   * Files and folders whose name contains the text, in any folder (or only in `within` and the folders
   * under it), most recently edited first; the app's Find files.
   */
  async search(text: string, kind?: LibraryKind, within?: string): Promise<{ files: FileSummary[]; folders: string[] }> {
    const inside = (path: string) => within === undefined || within === '' || path === within || path.startsWith(`${within}/`);
    const [docs, files, folders] = await Promise.all([this.sheets.search(this.userId, text), this.hub.files.search(this.userId, text), this.hub.folders.search(this.userId, text)]);
    const found = [...(!kind || kind === 'file' ? files.map((f) => this.fileRow(f)) : []), ...docs.filter((m) => !kind || m.kind === kind).map((m) => this.docRow(m))];
    return {
      files: found.filter((f) => inside(f.folder ?? '')).sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1)),
      folders: kind ? [] : folders.filter((p) => p !== within && inside(p)),
    };
  }

  // --- Folders: a folder is its path ("Reports/2026"); '' is the top -------------------

  /** The folders directly in one ('' for the top), as paths. */
  subfolders(parent: string): string[] {
    return this.hub.folders.children(this.userId, parent);
  }

  /** Every folder of the account, as paths. */
  folders(): string[] {
    const under = (parent: string): string[] => this.hub.folders.children(this.userId, parent).flatMap((p) => [p, ...under(p)]);
    return under('');
  }

  /** A folder path the model gave, which must be a folder that exists. */
  folderPath(input: string): string {
    const clean = cleanFolderPath(input);
    if (clean === null) throw new ToolError('That is not a folder path. Use names separated by "/", such as "Reports/2026"; a name cannot start with a dot or contain \\ : * ? " < > |.');
    if (!this.hub.folders.exists(this.userId, clean)) throw new ToolError(`There is no folder "${clean}". Create it with create_folder, or see list_files for the folders there are.`);
    return clean;
  }

  /** Make a folder, and the folders above it that are missing. */
  createFolder(input: string): { path: string; created: boolean } {
    const clean = cleanFolderPath(input);
    if (!clean) throw new ToolError('Give the folder a path: names separated by "/", such as "Reports/2026". A name cannot start with a dot or contain \\ : * ? " < > |.');
    return { path: clean, created: this.hub.folders.create(this.userId, clean) };
  }

  /** Put a file in a folder ('' for the top). */
  move(kind: LibraryKind, id: string, folder: string): FileSummary {
    const moved = kind === 'file' ? this.hub.files.move(this.userId, id, folder) : this.sheets.move(this.userId, id, folder);
    if (!moved) throw new ToolError(`There is no ${noun(kind)} ${id}.`);
    return { ...(kind === 'file' ? fileSummary(moved as StoredFile) : summary(moved as SheetMeta)), folder };
  }

  /** A text document built from the Markdown, or (kind markdown) a Markdown file holding it as it is. */
  async createDoc(title: string, markdown?: string, kind: 'doc' | 'markdown' = 'doc'): Promise<FileSummary> {
    if (kind === 'markdown') return summary(await this.sheets.createMarkdown(this.userId, title.trim() || 'Untitled Markdown', newMarkdownDoc(markdown ?? '')));
    const doc = markdown ? markdownToDoc(markdown) : newDoc();
    const problem = validateDoc(doc);
    if (problem) throw new ToolError(problem);
    return summary(await this.sheets.createDoc(this.userId, title.trim() || 'Untitled document', doc));
  }

  async createSheet(title: string): Promise<FileSummary> {
    return summary(await this.sheets.create(this.userId, title.trim() || 'Untitled spreadsheet'));
  }

  async createDeck(title: string, theme?: ThemeId, slides: SlideSpec[] = []): Promise<FileSummary> {
    const deck: Deck = {
      version: 1,
      theme: theme ?? 'light',
      slides: slides.length ? slides.map((s, i) => buildSlide(s.layout ?? (i === 0 ? 'title' : 'title-body'), s, newId)) : [buildSlide('title', {}, newId)],
    };
    const problem = validateDeck(deck);
    if (problem) throw new ToolError(problem);
    return summary(await this.sheets.createDeck(this.userId, title.trim() || 'Untitled presentation', deck));
  }

  /** The user's copy of the Getting started guide; the first call makes it. */
  async gettingStarted(): Promise<FileSummary> {
    return summary(await openGettingStarted(this.sheets, this.images, this.userId));
  }

  /**
   * Create a document from a Word file or a presentation from a PowerPoint file, with the app's own
   * converters (pictures are stored for the account). The kind comes from the bytes, not the name.
   */
  async importFile(bytes: Buffer, name: string | undefined, title: string | undefined, folder?: string): Promise<{ file: FileSummary; warnings: string[] }> {
    try {
      const made = await importBytes({ sheets: this.sheets, images: this.images, files: this.hub.files }, this.userId, bytes, name, title);
      const file = made.sheet ? summary(made.sheet) : fileSummary(made.file);
      return { file: folder ? this.move(file.kind, file.id, folder) : file, warnings: made.warnings };
    } catch (e) {
      if (e instanceof ImportFileError) throw new ToolError(e.message);
      throw e;
    }
  }

  rename(kind: LibraryKind, id: string, title: string): FileSummary {
    // A stored file is renamed by its file name, and keeps its extension.
    if (kind === 'file') {
      const file = this.hub.files.rename(this.userId, id, title);
      if (!file) throw new ToolError(`There is no ${noun(kind)} ${id}.`);
      return fileSummary(file);
    }
    const meta = this.sheets.rename(this.userId, id, title.trim(), kind);
    if (!meta) throw new ToolError(`There is no ${noun(kind)} ${id}.`);
    return summary(meta);
  }

  async delete(kind: LibraryKind, id: string): Promise<void> {
    if (!(kind === 'file' ? await this.hub.files.delete(this.userId, id) : await this.sheets.delete(this.userId, id, kind))) throw new ToolError(`There is no ${noun(kind)} ${id}.`);
    if (this.open?.id === id) this.setOpen(null);
  }

  /** A stored file (a PDF or a video) of this account. */
  storedFile(id: string): FileSummary {
    const f = this.hub.files.get(this.userId, id);
    if (!f) throw new ToolError(`There is no file ${id}.`);
    return fileSummary(f.meta);
  }

  /**
   * The stored file read_doc reads: the one named, or the open one when none is named. Null when the target
   * is not a stored file (a document, or nothing).
   */
  storedTarget(id: string | undefined): string | null {
    if (id) return this.hub.files.get(this.userId, id) ? id : null;
    return this.open?.kind === 'file' ? this.open.id : null;
  }

  /**
   * A stored file's text as numbered blocks, read like a document (a PDF's text, a web page's, a text file).
   * With canEdit (a version of the tools that has edit_file), a text file is said to be editable.
   */
  async readStored(id: string, from?: number, to?: number, canEdit = false): Promise<Record<string, unknown>> {
    const f = this.hub.files.get(this.userId, id);
    if (!f) throw new ToolError(`There is no file ${id}.`);
    try {
      const data = await readFile(f.file);
      const text = await storedFileText(f.meta, data);
      const access = canEdit && editableText(f.meta, data) ? { editable: true, note: 'A text file: change it with edit_file (find and replace).' } : { read_only: true };
      return { file_id: id, filename: f.meta.filename, type: f.meta.type, ...access, ...textOutline(text, from, to) };
    } catch (e) {
      if (e instanceof NoTextError) throw new ToolError(e.message);
      throw e;
    }
  }

  /** A Markdown file of a stored PDF's text, made beside the PDF (server/pdfMarkdown.ts). */
  async convertPdf(id: string): Promise<{ file: FileSummary; pdf: FileSummary; pages: number; ocr_pages: number[]; warnings: string[] }> {
    try {
      const made = await pdfToMarkdownFile({ sheets: this.sheets, files: this.hub.files }, this.userId, id);
      if (!made) throw new ToolError(`There is no file ${id}. Use list_files or search_files to find ids.`);
      return { file: { ...summary(made.sheet), folder: made.sheet.folder ?? '' }, pdf: fileSummary(made.pdf), pages: made.pageCount, ocr_pages: made.ocrPages, warnings: made.warnings };
    } catch (e) {
      if (e instanceof PdfError) throw new ToolError(e.message);
      throw e;
    }
  }

  /** A PDF of a document, presentation, Markdown file or stored web page, kept beside it (server/pdf.ts). */
  async exportPdf(id: string, paper: Paper): Promise<FileSummary & { folder: string }> {
    if (!this.hub.pdf) throw new ToolError('PDFs cannot be made here.');
    try {
      const file = await this.hub.pdf.save(this.userId, id, paper);
      if (!file) throw new ToolError(`There is no file ${id}. Use list_files or search_files to find ids.`);
      return { ...fileSummary(file), folder: file.folder ?? '' };
    } catch (e) {
      if (e instanceof PrintError) throw new ToolError(e.message);
      throw e;
    }
  }

  /**
   * Change a stored text file: find-and-replace edits, its whole new text, or undo of the last change (where
   * the store keeps the version before). Saved as the app's text editor saves it.
   */
  async editStored(id: string, change: { edits?: TextEdit[]; content?: string; undo?: boolean }): Promise<Record<string, unknown>> {
    const f = this.hub.files.get(this.userId, id);
    if (!f) throw new ToolError(`There is no file ${id}. Use list_files or search_files to find ids.`);
    const modes = Number(!!change.edits?.length) + Number(typeof change.content === 'string') + Number(change.undo === true);
    if (modes !== 1) throw new ToolError('Give exactly one of edits, content or undo.');
    if (change.undo) {
      const back = await this.hub.files.revert(this.userId, id);
      if (!back) throw new ToolError(`${f.meta.filename} has no earlier version to put back. Make the change back with edits instead.`);
      this.hub.onFileChanged?.(this.userId, id);
      return { undone: true, file_id: id, filename: back.filename, size: back.size };
    }
    const data = await readFile(f.file);
    if (!editableText(f.meta, data)) throw new ToolError(`${f.meta.filename} is not a text file, so it cannot be edited.`);
    if (f.meta.size > MAX_TEXT_EDIT_BYTES) throw new ToolError(`${f.meta.filename} is too large to edit here (over ${MAX_TEXT_EDIT_BYTES / 1024 / 1024} MB).`);
    let text = typeof change.content === 'string' ? change.content : data.toString('utf8');
    let replacements = 0;
    try {
      ({ text, replacements } = applyTextEdits(text, change.edits ?? []));
    } catch (e) {
      if (e instanceof TextEditError) throw new ToolError(e.message.replace('Read that part', 'Read that part with read_doc'));
      throw e;
    }
    const saved = await this.hub.files.update(this.userId, id, Buffer.from(text, 'utf8'));
    if (!saved) throw new ToolError(`There is no file ${id}.`);
    this.hub.onFileChanged?.(this.userId, id);
    return { edited: true, file_id: id, filename: saved.filename, ...(change.edits?.length ? { replacements } : {}), total_chars: text.length };
  }

  // --- Pictures: the image editor runs in the app (a browser), so the model's edits are jobs the app takes ---

  private readonly imageJobs = new Map<string, { job: ImageJob; claimed: boolean; settle(result: ImageJobResult): void }>();
  /** When the app last asked for its state, which is when it takes jobs. */
  private lastAppPoll = 0;

  /** A stored picture the image editor can change, with its bytes' place and its size in pixels. */
  async editableImage(id: string): Promise<{ meta: StoredFile; file: string; pixels: { width: number; height: number } | null }> {
    const f = this.hub.files.get(this.userId, id);
    if (!f) throw new ToolError(`There is no file ${id}. Use list_files to find ids.`);
    if (!f.meta.type.startsWith('image/')) throw new ToolError(`${f.meta.filename} is not a picture.`);
    // The size is in the first part of the file, wherever a camera's notes put the frame header.
    const head = Buffer.alloc(Math.min(f.meta.size, 256 * 1024));
    const handle = await open(f.file, 'r');
    try {
      await handle.read(head, 0, head.length, 0);
    } finally {
      await handle.close();
    }
    return { ...f, pixels: imageSize(head) };
  }

  /**
   * Hand a picture's edit to the app and wait for it. The app takes jobs when it asks for its state, every few
   * seconds while it is showing; with no app showing nothing takes the job, and the wait ends with a message
   * saying what to do. Sooner when no app has been seen lately.
   */
  runImageJob(fileId: string, operations: unknown[], save: 'copy' | 'replace', opts: { preview?: boolean } = {}, now = Date.now()): Promise<ImageJobResult> {
    const id = randomBytes(9).toString('base64url');
    const seen = now - this.lastAppPoll < APP_SEEN_MS;
    // A look at a picture is not worth waiting for an app that is not there.
    if (opts.preview && !seen) return Promise.resolve({ ok: false, error: 'The app is not showing.' });
    const wait = opts.preview ? IMAGE_PREVIEW_MS : seen ? IMAGE_JOB_MS : IMAGE_JOB_UNSEEN_MS;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const claimed = this.imageJobs.get(id)?.claimed;
        this.imageJobs.delete(id);
        resolve({ ok: false, error: claimed ? 'The app took too long to edit the picture. Try again with fewer operations.' : 'The picture is edited by the app, which is not showing. Call open_file with this picture so the app is on screen, then call transform_image again.' });
      }, wait);
      this.imageJobs.set(id, {
        job: { id, file_id: fileId, operations, save, ...(opts.preview ? { preview: true } : {}) },
        claimed: false,
        settle: (result) => {
          clearTimeout(timer);
          this.imageJobs.delete(id);
          resolve(result);
        },
      });
    });
  }

  /** The app asked for its state: the jobs no app has taken yet are its to do. */
  takeImageJobs(now = Date.now()): ImageJob[] {
    this.lastAppPoll = now;
    const jobs: ImageJob[] = [];
    for (const entry of this.imageJobs.values()) {
      if (entry.claimed) continue;
      entry.claimed = true;
      jobs.push(entry.job);
    }
    return jobs;
  }

  /** The app's answer to a job; false when the job is unknown (it ran out of time, or was answered already). */
  finishImageJob(id: string, result: ImageJobResult): boolean {
    const entry = this.imageJobs.get(id);
    if (!entry) return false;
    entry.settle(result);
    return true;
  }

  /** Save an edited picture over a stored one, as the type it is; the version before is kept for one revert. */
  async saveImage(id: string, bytes: Buffer): Promise<FileSummary> {
    const f = this.hub.files.get(this.userId, id);
    if (!f) throw new ToolError(`There is no file ${id}.`);
    if (!EDITABLE_IMAGE_TYPES.includes(f.meta.type)) throw new ToolError('Only PNG, JPEG and WebP pictures can be saved over.');
    if (!isImageOfType(bytes, f.meta.type)) throw new ToolError(`The edited picture must be saved as ${f.meta.type}, the type of ${f.meta.filename}.`);
    const saved = await this.hub.files.update(this.userId, id, bytes);
    return fileSummary(saved!);
  }

  /** A stored file with an address the app's iframe can load it from (and seek in) for the next few hours. */
  fileLink(id: string): { file: FileSummary; url: string } {
    const file = this.storedFile(id);
    return { file, url: `${this.publicUrl ?? ''}/plugin/file/${id}?t=${this.hub.issueFileLink(this.userId, id)}` };
  }

  /** Open a file for the model (setOpen) and have the host show it (FileHub.onShow). */
  show(file: { kind: LibraryKind; id: string }): void {
    this.setOpen(file);
    this.hub.onShow?.(this.userId, file);
  }

  setOpen(file: { kind: LibraryKind; id: string } | null, cursor: Cursor = {}): void {
    if (file && !(file.kind === 'file' ? this.hub.files.get(this.userId, file.id) : this.sheets.get(this.userId, file.id, file.kind))) throw new ToolError(`There is no ${noun(file.kind)} ${file.id}.`);
    this.open = file;
    this.cursor = file ? cursor : {};
  }

  /** The id to act on for a tool of this kind: the given one, else the open file if it is of that kind. */
  target(kind: FileKind, id: string | undefined): string | null {
    if (id) return id;
    return this.open?.kind === kind ? this.open.id : null;
  }

  /** The same for the document tools, which also work on Markdown documents: the file and which of the two it is. */
  docTarget(id: string | undefined): { kind: 'doc' | 'markdown'; id: string } | null {
    if (id) return { kind: this.sheets.get(this.userId, id, 'markdown') ? 'markdown' : 'doc', id };
    return this.open && (this.open.kind === 'doc' || this.open.kind === 'markdown') ? { kind: this.open.kind, id: this.open.id } : null;
  }

  state(): AppState {
    if (this.open?.kind === 'file') {
      const f = this.hub.files.get(this.userId, this.open.id)?.meta;
      if (!f) this.open = null;
      return { open: f ? { kind: 'file', id: f.id, title: f.filename, rev: f.createdAt } : null };
    }
    const meta = this.open ? this.sheets.get(this.userId, this.open.id, this.open.kind) : null;
    if (this.open && !meta) this.open = null;
    return { open: meta ? { kind: this.open!.kind, id: meta.id, title: meta.title, rev: meta.updatedAt } : null };
  }

  // --- Whole files for the app's editors --------------------------------------------------

  /** An Excel file as workbook tabs, for adding to an open spreadsheet. */
  async convertExcel(bytes: Buffer, name?: string): Promise<{ workbook: Workbook; warnings: string[] }> {
    if (name && !/\.xlsx?$/i.test(name)) throw new ToolError('Choose an Excel workbook (.xlsx or .xls).');
    try {
      const { workbook, warnings } = await importExcel(bytes);
      const problem = validateWorkbook(workbook);
      if (problem) throw new ToolError(problem);
      return { workbook, warnings };
    } catch (e) {
      if (e instanceof ImportError) throw new ToolError(e.message);
      throw e;
    }
  }

  /** The stored file of a kind, or null. */
  private async load(kind: FileKind, id: string): Promise<{ meta: SheetMeta; data: FileData } | null> {
    if (kind === 'doc') {
      const r = await this.sheets.loadDoc(this.userId, id);
      return r && { meta: r.meta, data: r.doc };
    }
    if (kind === 'deck') {
      const r = await this.sheets.loadDeck(this.userId, id);
      return r && { meta: r.meta, data: r.deck };
    }
    if (kind === 'markdown') {
      const r = await this.sheets.loadMarkdown(this.userId, id);
      return r && { meta: r.meta, data: r.doc };
    }
    const r = await this.sheets.load(this.userId, id);
    return r && r.meta.kind === 'sheet' ? { meta: r.meta, data: r.workbook } : null;
  }

  /** A file with image addresses the app's iframe can load. The revision is the save time. */
  async get(kind: FileKind, id: string): Promise<{ meta: FileSummary; rev: string; data: FileData }> {
    const loaded = await this.load(kind, id);
    if (!loaded) throw new ToolError(`There is no ${noun(kind)} ${id}.`);
    return { meta: summary(loaded.meta), rev: loaded.meta.updatedAt, data: this.toPublic(kind, loaded.data) };
  }

  /** Save a whole file. With ifRev, the save only happens when nobody else saved first. */
  async save(kind: FileKind, id: string, data: FileData, ifRev?: string): Promise<{ rev: string }> {
    const stored = this.toStored(kind, data);
    const problem = kind === 'doc' ? validateDoc(stored) : kind === 'deck' ? validateDeck(stored) : kind === 'markdown' ? validateMarkdownDoc(stored) : validateWorkbook(stored);
    if (problem) throw new ToolError(problem);
    const meta = this.sheets.get(this.userId, id, kind);
    if (!meta) throw new ToolError(`There is no ${noun(kind)} ${id}.`);
    if (ifRev && meta.updatedAt !== ifRev) throw new ConflictError(meta.updatedAt);
    const saved =
      kind === 'doc'
        ? await this.sheets.saveDoc(this.userId, id, stored as Doc)
        : kind === 'deck'
          ? await this.sheets.saveDeck(this.userId, id, stored as Deck)
          : kind === 'markdown'
            ? await this.sheets.saveMarkdown(this.userId, id, stored as MarkdownDoc)
            : await this.sheets.save(this.userId, id, stored as Workbook);
    if (!saved) throw new ToolError(`There is no ${noun(kind)} ${id}.`);
    return { rev: saved.updatedAt };
  }

  // --- Headless editing for the model's tools --------------------------------------------

  /**
   * Run the tool in the window that has the file open (FileHub.live), when there is one: the result, with its
   * pictures under RESULT_IMAGES. Null when no window has it open, to run it here.
   */
  private async runLive(kind: FileKind, id: string, idKey: string, tool: string, input: Record<string, unknown>): Promise<Record<string | symbol, unknown> | null> {
    if (!this.hub.live || this.open?.id !== id) return null;
    const r = await this.hub.live.run({ kind, id }, tool, input);
    if (!r) return null;
    if (r.isError) throw new ToolError(r.content);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(r.content) as Record<string, unknown>;
    } catch {
      parsed = { result: r.content };
    }
    // The assistant's tools say where their picture is in its own conversation; here it comes with the result.
    if (r.images?.length && typeof parsed.image === 'string') parsed.image = 'The picture comes with this result. Look at it before reporting back.';
    return { [idKey]: id, title: this.sheets.get(this.userId, id)?.title ?? '', ...parsed, ...(r.images?.length ? { [RESULT_IMAGES]: r.images } : {}) };
  }

  /**
   * Edit a stored picture in the app's window (the desktop app), with the built-in assistant's transform_image
   * and its full image editor, background removal included. Null when there is no window to do it.
   */
  async editImageInWindow(input: { file_id: string; operations: unknown[]; save?: 'copy' | 'replace' }): Promise<LiveResult | null> {
    return (await this.hub.live?.runInFront?.(input.file_id, 'transform_image', input)) ?? null;
  }

  /**
   * A tool only the app's window can run (it draws a slide, or moves the selection there), on the file open
   * in it. A file the model has just opened takes a moment to load there, so it is waited for a little.
   */
  async runInWindow(kind: FileKind, id: string, idKey: string, tool: string, input: Record<string, unknown>): Promise<Record<string | symbol, unknown>> {
    for (let i = 0; i < 10; i++) {
      const r = await this.runLive(kind, id, idKey, tool, input);
      if (r) return r;
      if (!this.hub.live || this.open?.id !== id) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new ToolError(`${tool} works on the ${noun(kind)} open in the app’s window. Open it with open_file, then try again.`);
  }

  /**
   * Run one of the app's document tools on a stored document and save the result. Returns what the tool
   * returned (parsed), with the document id and its new revision.
   */
  async editDoc(id: string, tool: DocEditTool, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const live = await this.runLive('doc', id, 'doc_id', tool, input);
    if (live) return live;
    const loaded = await this.sheets.loadDoc(this.userId, id);
    if (!loaded) throw new ToolError(`There is no document ${id}.`);
    const before = JSON.stringify(loaded.doc);
    const ctl = new DocController(loaded.doc, async () => {});
    try {
      const result = JSON.parse(runDocTool({ id: 'mcp', name: tool, input }, { doc: ctl, group: `mcp-${Date.now()}` })) as Record<string, unknown>;
      const after = docFromNode(ctl.doc);
      let rev = loaded.meta.updatedAt;
      if (JSON.stringify(after) !== before) rev = (await this.save('doc', id, after, loaded.meta.updatedAt)).rev;
      if (this.open?.id === id && (tool === 'read_doc' || tool === 'get_doc_info')) {
        // The headless controller has no cursor; report the one the app's editor told us about.
        if (this.cursor.cursor_block) result.cursor_block = this.cursor.cursor_block;
        if (this.cursor.selected_text) result.selected_text = this.cursor.selected_text;
        else delete result.selected_text;
      }
      return { doc_id: id, title: loaded.meta.title, rev, ...result };
    } finally {
      ctl.dispose();
    }
  }

  /**
   * The same for a Markdown document: the document tools that change content act on its text, and the others
   * (formatting, page setup, pictures) are refused with what to do instead.
   */
  async editMarkdown(id: string, tool: DocEditTool, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const problem = markdownToolProblem(tool);
    if (problem) throw new ToolError(problem.replace('The open file', 'This file'));
    const live = await this.runLive('markdown', id, 'doc_id', tool, input);
    if (live) return live;
    const loaded = await this.sheets.loadMarkdown(this.userId, id);
    if (!loaded) throw new ToolError(`There is no Markdown document ${id}.`);
    const ctl = new MarkdownController(loaded.doc, async () => {});
    try {
      const result = JSON.parse(runMarkdownTool({ id: 'mcp', name: tool, input }, ctl)) as Record<string, unknown>;
      let rev = loaded.meta.updatedAt;
      if (ctl.text !== loaded.doc.text) rev = (await this.save('markdown', id, ctl.document, loaded.meta.updatedAt)).rev;
      if (tool === 'read_doc') {
        // The headless controller has no cursor; report the one the app's editor told us about.
        delete result.cursor_block;
        if (this.open?.id === id) {
          if (this.cursor.cursor_block) result.cursor_block = this.cursor.cursor_block;
          if (this.cursor.selected_text) result.selected_text = this.cursor.selected_text;
        }
      }
      return { doc_id: id, title: loaded.meta.title, rev, ...result };
    } finally {
      ctl.dispose();
    }
  }

  /** The same for a presentation and the app's deck tools. */
  async editDeck(id: string, tool: DeckEditTool, given: Record<string, unknown>): Promise<Record<string, unknown>> {
    // A spreadsheet range a table is linked to is read here, so the tool has it in the window or headless.
    const { input } = await linkDeckTables({ id: 'mcp', name: tool, input: given }, async (sheetId, ref) => {
      const t = await loadLinkedTable(this.sheets, this.userId, sheetId, ref);
      if (!t) throw new Error(`There is no spreadsheet ${sheetId}.`);
      if (typeof t === 'string') throw new Error(t);
      return t;
    }, async (sheetId, chartId) => {
      const c = await loadLinkedChart(this.sheets, this.userId, sheetId, chartId);
      if (!c) throw new Error(`There is no spreadsheet ${sheetId}.`);
      if (typeof c === 'string') throw new Error(c);
      return c;
    });
    const live = await this.runLive('deck', id, 'deck_id', tool, input);
    if (live) return live;
    const loaded = await this.sheets.loadDeck(this.userId, id);
    if (!loaded) throw new ToolError(`There is no presentation ${id}.`);
    const before = JSON.stringify(loaded.deck);
    const ctl = new DeckController(loaded.deck, async () => {});
    try {
      if (this.open?.id === id) {
        // Start where the user is, so "the current slide" and the outline's marker are right.
        if (this.cursor.slide) ctl.goTo(this.cursor.slide - 1);
        if (this.cursor.selection?.length) ctl.select(this.cursor.selection);
      }
      const result = JSON.parse(runDeckTool({ id: 'mcp', name: tool, input }, { deck: ctl, group: `mcp-${Date.now()}` })) as Record<string, unknown>;
      const after = ctl.deck;
      let rev = loaded.meta.updatedAt;
      if (JSON.stringify(after) !== before) rev = (await this.save('deck', id, after, loaded.meta.updatedAt)).rev;
      return { deck_id: id, title: loaded.meta.title, rev, ...result };
    } finally {
      ctl.dispose();
    }
  }

  /** The same for a spreadsheet and the app's sheet tools (which run against a SheetController). */
  async editSheet(id: string, tool: SheetEditTool, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    const live = await this.runLive('sheet', id, 'sheet_id', tool, input);
    if (live) return live;
    const loaded = await this.sheets.load(this.userId, id);
    if (!loaded || loaded.meta.kind !== 'sheet') throw new ToolError(`There is no spreadsheet ${id}.`);
    const before = JSON.stringify(loaded.workbook);
    const ctl = new SheetController(loaded.workbook, async () => {});
    try {
      if (this.open?.id === id && this.cursor.tab) {
        // Start on the tab the user is looking at, so tools that default to "the active tab" agree with them.
        const tab = ctl.store.workbook.tabs.find((t) => t.name === this.cursor.tab);
        if (tab && tab.id !== ctl.activeTabId) ctl.switchTab(tab.id);
      }
      const unavailable = (what: string) => async () => {
        throw new ToolError(`${what} is not available here.`);
      };
      const env = {
        ctl,
        deck: null,
        doc: null,
        group: `mcp-${Date.now()}`,
        openSheet: unavailable('Opening another spreadsheet'),
        openDeck: unavailable('Opening a presentation'),
        openDoc: unavailable('Opening a document'),
        requestAppChange: unavailable('Changing the app'),
        requestResearch: unavailable('Research'),
        uploadImage: async (blob: Blob) => this.storeImage(blob.type, Buffer.from(await blob.arrayBuffer())),
      } as unknown as ClientToolEnv;
      const result = JSON.parse(await runClientTool({ id: 'mcp', name: tool, input }, env)) as Record<string, unknown>;
      const after = ctl.store.workbook;
      let rev = loaded.meta.updatedAt;
      if (JSON.stringify(after) !== before) rev = (await this.save('sheet', id, after, loaded.meta.updatedAt)).rev;
      if (this.open?.id === id && tool === 'get_sheet_overview' && this.cursor.selection?.length) result.selection = this.cursor.selection;
      return { sheet_id: id, title: loaded.meta.title, rev, ...result };
    } finally {
      ctl.dispose();
    }
  }

  // --- Images ---------------------------------------------------------------------------

  /** Store an image uploaded from the app; returns an address the iframe can load. */
  uploadImage(type: string, base64: string): Promise<string> {
    return this.storeImage(type, Buffer.from(base64, 'base64'));
  }

  /** Store image bytes (an upload, an attachment, an inline image); returns an address the iframe can load. */
  async storeImage(type: string, data: Buffer): Promise<string> {
    if (!CELL_IMAGE_TYPES.includes(type)) throw new ToolError('Please choose a PNG, JPEG, GIF or WebP image.');
    if (data.length > MAX_CELL_IMAGE_BYTES) throw new ToolError(`Images must be under ${Math.round(MAX_CELL_IMAGE_BYTES / 1e6)} MB.`);
    return this.publicSrc(await this.images.create(this.userId, type, data));
  }

  /** True for an image address this server stores (either form). */
  isOwnImage(src: string): boolean {
    return src.startsWith('/api/images/') || (!!this.publicUrl && src.startsWith(`${this.publicUrl}/plugin/img/`));
  }

  imageFile(id: string): { file: string; type: string } | null {
    return this.images.get(this.userId, id);
  }

  /** Stored "/api/images/<id>" addresses become "<publicUrl>/plugin/img/<id>" for the iframe. */
  publicSrc(src: string): string {
    return this.publicUrl && src.startsWith('/api/images/') ? `${this.publicUrl}/plugin/img/${src.slice('/api/images/'.length)}` : src;
  }

  storedSrc(src: string): string {
    const prefix = this.publicUrl ? `${this.publicUrl}/plugin/img/` : null;
    return prefix && src.startsWith(prefix) ? `/api/images/${src.slice(prefix.length)}` : src;
  }

  toPublic<T extends FileData>(kind: FileKind, data: T): T {
    return this.publicUrl ? mapImages(kind, data, (s) => this.publicSrc(s)) : data;
  }

  toStored<T extends FileData>(kind: FileKind, data: T): T {
    return this.publicUrl ? mapImages(kind, data, (s) => this.storedSrc(s)) : data;
  }
}
