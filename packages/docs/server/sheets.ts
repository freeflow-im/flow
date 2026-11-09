import { randomUUID } from 'node:crypto';
import { newFileId } from './ids.ts';
import { mkdir, readFile, rename, rm, writeFile } from '#runtime/fsp';
import path from 'node:path';
import type { Deck } from '../shared/deck.ts';
import type { Doc } from '../shared/doc.ts';
import type { MarkdownDoc } from '../shared/markdown.ts';
import { csvProblem, csvStyle, csvToWorkbook, isCsvDoc, newCsvDoc, workbookToCsv, type CsvDoc } from '../shared/csv.ts';
import { migrateDeck } from '../shared/lines.ts';
import { checkCellImage, newWorkbook, type DocKind, type SheetMeta, type Workbook } from '../shared/types.ts';
import { xlsxProblem } from '../shared/xlsxFormat.ts';
import { validateCharts } from '../shared/chart.ts';
import type { Backup } from './backup.ts';
import type { DB } from './db.ts';
import { allowed, roleMeta, syncOrgGrant, type Role } from './access.ts';
import { scopeColumns, scopeMeta, scopeOfRow, scopeWhere, type Owned, type ScopeArg, type ViewerArg } from './scope.ts';

export interface SheetRow extends Owned {
  id: string;
  owner_id: string;
  kind: DocKind;
  /** How the file holds the document when not as the app's JSON (CSV text, an Excel file, ...); null otherwise. */
  format: SheetFormat | null;
  title: string;
  /** Path of the folder the document is in; '' at the top. */
  folder: string;
  file: string;
  created_at: string;
  updated_at: string;
  parent_id: string | null;
  parent_title: string | null;
  branched_at: string | null;
  /** Joined: the parent's current title (null if the parent no longer exists). */
  live_parent_title: string | null;
  /** Not a column: the role of the viewer the row was read for (`row`), told in its metadata. */
  role?: Role;
}

// Every metadata read joins the parent so branch info (current title, detached) is always fresh: the parent is
// one of the same owner's, or a shared file of the same organization (a branch of an organization file).
const SELECT_SHEETS = `
  SELECT s.*, p.title AS live_parent_title
  FROM sheets s LEFT JOIN sheets p ON p.id = s.parent_id AND (p.owner_id = s.owner_id OR (p.private = 0 AND p.workspace_id = s.workspace_id))`;

const toMeta = (r: SheetRow): SheetMeta => ({
  id: r.id,
  kind: r.kind,
  ...(r.format ? { format: r.format } : {}),
  title: r.title,
  ...(r.folder ? { folder: r.folder } : {}),
  ...scopeMeta(r),
  ...roleMeta(r.role),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  ...(r.parent_id
    ? {
        branch: {
          parentId: r.parent_id,
          parentTitle: r.live_parent_title ?? r.parent_title ?? 'Deleted spreadsheet',
          branchedAt: r.branched_at ?? r.created_at,
          detached: r.live_parent_title === null,
        },
      }
    : {}),
});

const baseFileOf = (id: string) => `${id}.base.json`;

export type Stored = Workbook | Deck | Doc | MarkdownDoc | CsvDoc;
/** How a document's file holds it, when not as the app's JSON: a spreadsheet as CSV text or an Excel file, a presentation as a PowerPoint file, a document as a Word file. */
export type SheetFormat = 'csv' | 'xlsx' | 'pptx' | 'docx';

/** Structural validation of an uploaded workbook (guards against malformed saves, not a full schema). */
export function validateWorkbook(wb: unknown): string | null {
  if (!wb || typeof wb !== 'object') return 'Workbook must be an object';
  const w = wb as Workbook;
  if (w.version !== 1) return 'Unsupported workbook version';
  if (!Array.isArray(w.tabs) || w.tabs.length === 0) return 'Workbook must have at least one tab';
  if (w.tabs.length > 200) return 'Too many tabs';
  const names = new Set<string>();
  const ids = new Set<string>();
  for (const t of w.tabs) {
    if (!t || typeof t !== 'object') return 'Invalid tab';
    if (typeof t.id !== 'string' || !t.id || ids.has(t.id)) return 'Invalid or duplicate tab id';
    if (typeof t.name !== 'string' || !t.name.trim()) return 'Invalid tab name';
    const lower = t.name.toLowerCase();
    if (names.has(lower)) return `Duplicate tab name "${t.name}"`;
    ids.add(t.id);
    names.add(lower);
    if (!Number.isInteger(t.rows) || !Number.isInteger(t.cols) || t.rows < 1 || t.cols < 1) return 'Invalid tab size';
    if (!t.cells || typeof t.cells !== 'object' || Array.isArray(t.cells)) return 'Invalid cells';
    for (const key in t.cells) {
      if (!/^[A-Z]{1,3}\d+$/.test(key)) return `Invalid cell address "${key}"`;
      const c = t.cells[key];
      if (!c || typeof c.v !== 'string') return `Invalid cell at ${key}`;
      if (c.img !== undefined) {
        const problem = checkCellImage(c.img);
        if (problem) return `Invalid image at ${key}: ${problem}`;
      }
    }
    if (!t.colWidths || typeof t.colWidths !== 'object') return 'Invalid column widths';
    if (!t.rowHeights || typeof t.rowHeights !== 'object') return 'Invalid row heights';
    const charts = validateCharts(t.charts);
    if (charts) return `Tab "${t.name}": ${charts}`;
  }
  return null;
}

/**
 * Spreadsheets, slide decks, text documents and Markdown documents, stored as one JSON file each with their
 * metadata in SQLite. The workbook methods (load, save, branch, ...) only see spreadsheets; the deck, doc and
 * markdown methods likewise. A spreadsheet can be stored as CSV text instead of a workbook (format "csv"):
 * load still returns a workbook, and save writes CSV for as long as the workbook fits in one. The desktop
 * app's store also keeps spreadsheets, presentations and documents as Office files (formats "xlsx", "pptx" and
 * "docx", server/localStore.ts).
 */
export class SheetStore {
  protected db: DB;
  protected dir: string;
  // Serialize writes per document so concurrent saves can't interleave on disk.
  private writeChains = new Map<string, Promise<void>>();
  /** The off-box copy (backup.ts): every write, base and delete is reported to it when set. */
  backup: Backup | null = null;
  /** Told each document's new revision after it is written or renamed (revisionFeed.ts). */
  onRevision: ((id: string, rev: string) => void) | null = null;

  constructor(db: DB, dir: string) {
    this.db = db;
    this.dir = dir;
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  protected filePath(file: string): string {
    return path.join(this.dir, file);
  }

  // --- How documents are laid out on disk. The folder-backed store of the desktop app (server/localStore.ts)
  // overrides these to keep real files (.md, .csv, ...) under the names the user gave them. ---

  /** The file for a new document, relative to the store's directory, and the title it ends up with. */
  protected newFile(id: string, _kind: DocKind, _format: SheetFormat | null, title: string, _folder: string): { file: string; title: string } {
    return { file: `${id}.json`, title };
  }

  /** What is written to a document's file. */
  protected encode(_file: string, doc: Stored): string | Buffer | Promise<string | Buffer> {
    return JSON.stringify(doc);
  }

  /** The document read from the bytes of its file. */
  protected decode(_file: string, data: Buffer): Stored | Promise<Stored> {
    return JSON.parse(data.toString('utf8')) as Stored;
  }

  /**
   * The format a new document is stored in, and a spreadsheet richer than CSV (a CSV file that outgrew it):
   * the app's JSON here; the desktop app keeps Office files when the document fits in one.
   */
  protected richFormat(_kind: DocKind, _doc: Stored): SheetFormat | null {
    return null;
  }

  /** What the file of a document just loaded holds that the app cannot keep (an Excel file's charts, say), if anything. */
  protected notKept(_r: SheetRow): string[] | undefined {
    return undefined;
  }

  /** Where a branch's snapshot of its original is kept. */
  protected basePath(id: string): string {
    return this.filePath(baseFileOf(id));
  }

  /** The modification time recorded for a file that was just written. */
  protected stamp(_file: string): string {
    return new Date().toISOString();
  }

  /** Remove a deleted document's file. */
  protected async removeFile(r: SheetRow): Promise<void> {
    await rm(this.filePath(r.file), { force: true });
  }

  /** Documents of one kind (spreadsheets by default) in a scope (server/scope.ts), most recently edited first. */
  list(scope: ScopeArg, kind: DocKind = 'sheet'): SheetMeta[] {
    const where = scopeWhere(scope, 's');
    const rows = this.db
      .prepare(`${SELECT_SHEETS} WHERE ${where.sql} AND s.kind = ? ORDER BY s.updated_at DESC`)
      .all(...where.params, kind) as unknown as SheetRow[];
    return rows.map(toMeta);
  }

  /** A document's row whoever may access it: for the caller to check (server/access.ts) or to learn its scope. */
  find(id: string): SheetRow | undefined {
    return this.db.prepare(`${SELECT_SHEETS} WHERE s.id = ?`).get(id) as SheetRow | undefined;
  }

  /** A document the viewer's role on lets them do what `need` allows (server/access.ts), of the kind when one is given. */
  protected row(who: ViewerArg, id: string, kind?: DocKind, need: Role = 'viewer'): SheetRow | undefined {
    const r = this.find(id);
    if (!r || (kind && r.kind !== kind)) return undefined;
    const role = allowed(this.db, who, 'sheet', r, need);
    return role ? Object.assign(r, { role }) : undefined;
  }

  /** Metadata of a document of any kind. */
  get(who: ViewerArg, id: string, kind?: DocKind): SheetMeta | null {
    const r = this.row(who, id, kind);
    return r ? toMeta(r) : null;
  }

  /** The ids of the stored pictures (`/api/images/<id>`) a document shows: what moves with it to another organization. */
  async picturesIn(who: ViewerArg, id: string): Promise<string[]> {
    const r = this.row(who, id);
    if (!r) return [];
    const text = JSON.stringify(await this.read<Stored>(r));
    return [...new Set(Array.from(text.matchAll(/\/api\/images\/([0-9a-f-]{36})/g), (m) => m[1]))];
  }

  /**
   * Put a document in another root (Share with organization, Make private, Move to organization…): its new
   * organization, whether it is private (and to whom: the one who made it private keeps it) and the folder there.
   */
  setScope(who: ViewerArg, id: string, scope: ScopeArg, folder: string): SheetMeta | null {
    const r = this.row(who, id);
    if (!r) return null;
    const c = scopeColumns(scope);
    const owner = c.private ? c.owner_id : r.owner_id;
    this.db.prepare('UPDATE sheets SET owner_id = ?, workspace_id = ?, private = ?, folder = ? WHERE id = ?').run(owner, c.workspace_id, c.private, folder, id);
    syncOrgGrant(this.db, 'sheet', id, c, typeof who === 'string' ? who : who.userId);
    return toMeta({ ...r, owner_id: owner, workspace_id: c.workspace_id, private: c.private, folder });
  }

  /** An id no document has yet. */
  protected newId(): string {
    return newFileId((id) => !!this.db.prepare('SELECT 1 FROM sheets WHERE id = ?').get(id));
  }

  private async insert(scope: ScopeArg, kind: DocKind, wanted: string, doc: Stored, folder = '', format: SheetFormat | null = null): Promise<SheetMeta> {
    const id = this.newId();
    const c = scopeColumns(scope);
    const { file, title } = this.newFile(id, kind, format, wanted, folder);
    const json = await this.writeDoc(file, doc);
    const now = this.stamp(file);
    this.db
      .prepare('INSERT INTO sheets (id, owner_id, workspace_id, private, kind, format, title, folder, file, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, c.owner_id, c.workspace_id, c.private, kind, format, title, folder, file, now, now);
    syncOrgGrant(this.db, 'sheet', id, c, c.owner_id);
    this.backup?.putFile(c.owner_id, kind, id, now, json);
    return { id, kind, ...(format ? { format } : {}), title, ...(folder ? { folder } : {}), ...scopeMeta(c), createdAt: now, updatedAt: now };
  }

  /** Documents of every kind in one folder of a scope, most recently edited first. */
  listIn(scope: ScopeArg, folder: string): SheetMeta[] {
    const where = scopeWhere(scope, 's');
    const rows = this.db.prepare(`${SELECT_SHEETS} WHERE ${where.sql} AND s.folder = ? ORDER BY s.updated_at DESC`).all(...where.params, folder) as unknown as SheetRow[];
    return rows.map(toMeta);
  }

  /** Documents of every kind, in any folder, whose title contains the text (or whose path ends as it does: `nameSearch`); most recently edited first. */
  async search(scope: ScopeArg, text: string, limit = 200): Promise<SheetMeta[]> {
    const name = text.includes('/') ? `'/' || CASE s.folder WHEN '' THEN '' ELSE s.folder || '/' END || s.title` : 's.title';
    const where = scopeWhere(scope, 's');
    const rows = this.db
      .prepare(`${SELECT_SHEETS} WHERE ${where.sql} AND instr(lower(${name}), lower(?)) > 0 ORDER BY s.updated_at DESC LIMIT ?`)
      .all(...where.params, text, limit) as unknown as SheetRow[];
    return rows.map(toMeta);
  }

  /** Put a document in another folder. */
  move(who: ViewerArg, id: string, folder: string): SheetMeta | null {
    const r = this.row(who, id, undefined, 'editor');
    if (!r) return null;
    this.db.prepare('UPDATE sheets SET folder = ? WHERE id = ?').run(folder, id);
    return toMeta({ ...r, folder });
  }

  /** Create a spreadsheet stored as CSV text. Throws CsvError if the text cannot be opened as one. */
  async createCsv(scope: ScopeArg, title: string, csv: string, folder = ''): Promise<SheetMeta> {
    csvToWorkbook(csv);
    return this.insert(scope, 'sheet', title, newCsvDoc(csv), folder, 'csv');
  }

  async create(scope: ScopeArg, title: string, workbook?: Workbook, folder = ''): Promise<SheetMeta> {
    const wb = workbook ?? newWorkbook(randomUUID());
    return this.insert(scope, 'sheet', title, wb, folder, this.richFormat('sheet', wb));
  }

  /** Create a branch: a copy of the sheet that remembers its original and keeps a snapshot (base) of it. */
  async branch(who: ViewerArg, sourceId: string, wanted: string): Promise<SheetMeta | null> {
    const src = await this.load(who, sourceId);
    if (!src) return null;
    // A branch starts in its original's root (server/scope.ts), next to it.
    const c = scopeColumns(scopeOfRow(this.find(sourceId)!, who));
    const id = this.newId();
    // A branch starts next to its original (at the top of the viewer's own files, for one shared with them).
    const folder = c.owner_id === this.find(sourceId)!.owner_id || !c.private ? (src.meta.folder ?? '') : '';
    const format = this.richFormat('sheet', src.workbook);
    const { file, title } = this.newFile(id, 'sheet', format, wanted, folder);
    const json = await this.writeDoc(file, src.workbook);
    await writeAtomic(this.basePath(id), JSON.stringify(src.workbook));
    const now = this.stamp(file);
    this.db
      .prepare(
        `INSERT INTO sheets (id, owner_id, workspace_id, private, kind, format, title, folder, file, created_at, updated_at, parent_id, parent_title, branched_at)
         VALUES (?, ?, ?, ?, 'sheet', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, c.owner_id, c.workspace_id, c.private, format, title, folder, file, now, now, sourceId, src.meta.title, now);
    syncOrgGrant(this.db, 'sheet', id, c, c.owner_id);
    this.backup?.putFile(c.owner_id, 'sheet', id, now, json);
    this.backup?.putBase(c.owner_id, id, json);
    return this.get(who, id);
  }

  /** Everything needed to compare a branch: its base snapshot and the original's current state. */
  async compareData(who: ViewerArg, id: string): Promise<{ meta: SheetMeta; base: Workbook; original: Workbook | null; parent: SheetMeta | null } | 'not-branch' | null> {
    const r = this.row(who, id, 'sheet');
    if (!r) return null;
    if (!r.parent_id) return 'not-branch';
    const base = JSON.parse(await readFile(this.basePath(id), 'utf8')) as Workbook;
    const parent = await this.load(who, r.parent_id);
    return { meta: toMeta(r), base, original: parent?.workbook ?? null, parent: parent?.meta ?? null };
  }

  private async read<T>(r: SheetRow): Promise<T> {
    await this.writeChains.get(r.id);
    return (await this.decode(r.file, await readFile(this.filePath(r.file)))) as T;
  }

  /** `notKept`: what the file holds that saving would lose, for an Excel file the app did not write (see notKept). */
  async load(who: ViewerArg, id: string): Promise<{ meta: SheetMeta; workbook: Workbook; notKept?: string[] } | null> {
    const r = this.row(who, id, 'sheet');
    if (!r) return null;
    const stored = await this.read<Workbook | CsvDoc>(r);
    const csv = isCsvDoc(stored);
    // The file says what it is; bring the column in line if they disagree (e.g. after a restore).
    if (r.format !== 'xlsx' && csv !== (r.format === 'csv')) this.setFormat(r, csv ? 'csv' : null);
    const notKept = this.notKept(r);
    return { meta: toMeta(r), workbook: csv ? csvToWorkbook(stored.csv) : stored, ...(notKept?.length ? { notKept } : {}) };
  }

  protected setFormat(r: SheetRow, format: SheetFormat | null): void {
    this.db.prepare('UPDATE sheets SET format = ? WHERE id = ?').run(format, r.id);
    r.format = format;
  }

  private async write(r: SheetRow, doc: Stored): Promise<SheetMeta> {
    const prev = this.writeChains.get(r.id) ?? Promise.resolve();
    const next = prev.then(() => this.writeDoc(r.file, doc));
    this.writeChains.set(r.id, next.then(() => {}, () => {}));
    const json = await next;
    const now = this.stamp(r.file);
    this.db.prepare('UPDATE sheets SET updated_at = ? WHERE id = ?').run(now, r.id);
    this.backup?.putFile(r.owner_id, r.kind, r.id, now, json);
    this.onRevision?.(r.id, now);
    return { ...toMeta(r), updatedAt: now };
  }

  async save(who: ViewerArg, id: string, workbook: Workbook): Promise<SheetMeta | null> {
    const r = this.row(who, id, 'sheet', 'editor');
    if (!r) return null;
    // An Excel file stays one while the workbook fits; otherwise it is kept in the app's own format rather
    // than lose what was added (the editor asks first; this is for changes made elsewhere).
    if (r.format === 'xlsx' && xlsxProblem(workbook)) this.setFormat(r, null);
    if (r.format !== 'csv') return this.write(r, workbook);
    // A CSV file stays CSV while the workbook holds nothing CSV cannot store; otherwise it becomes a richer
    // spreadsheet rather than lose what was added.
    if (csvProblem(workbook)) {
      this.setFormat(r, this.richFormat('sheet', workbook));
      return this.write(r, workbook);
    }
    const before = await this.read<Workbook | CsvDoc>(r);
    return this.write(r, newCsvDoc(workbookToCsv(workbook, isCsvDoc(before) ? csvStyle(before.csv) : undefined)));
  }

  /**
   * Turn a CSV file into a richer spreadsheet (see richFormat), or an Excel file into the app's own format,
   * which holds everything; same id and content. No-op for one in the app's own format already.
   */
  async convertToNative(who: ViewerArg, id: string): Promise<SheetMeta | null> {
    if (!this.row(who, id, 'sheet', 'editor')) return null;
    const res = await this.load(who, id);
    if (!res) return null;
    if (!res.meta.format) return res.meta;
    const r = this.row(who, id, 'sheet')!;
    this.setFormat(r, res.meta.format === 'csv' ? this.richFormat('sheet', res.workbook) : null);
    return this.write(r, res.workbook);
  }

  /** Keep a presentation or document stored as an Office file in the app's own format instead, which holds everything. */
  async convertToOwnFormat(who: ViewerArg, id: string, kind: 'deck' | 'doc'): Promise<SheetMeta | null> {
    const r = this.row(who, id, kind, 'editor');
    if (!r) return null;
    if (!r.format) return toMeta(r);
    const doc = await this.read<Deck | Doc>(r);
    this.setFormat(r, null);
    return this.write(r, doc);
  }

  // --- Slide decks -------------------------------------------------------------

  async createDeck(scope: ScopeArg, title: string, deck: Deck, folder = ''): Promise<SheetMeta> {
    return this.insert(scope, 'deck', title, deck, folder, this.richFormat('deck', deck));
  }

  async loadDeck(who: ViewerArg, id: string): Promise<{ meta: SheetMeta; deck: Deck; notKept?: string[] } | null> {
    const r = this.row(who, id, 'deck');
    if (!r) return null;
    const deck = migrateDeck(await this.read<Deck>(r));
    const notKept = this.notKept(r);
    return { meta: toMeta(r), deck, ...(notKept?.length ? { notKept } : {}) };
  }

  /** A presentation whoever owns it, with the owner. Only for content the app itself hands out (the Getting started guide). */
  async loadDeckOfAnyOwner(id: string): Promise<{ meta: SheetMeta; deck: Deck; ownerId: string } | null> {
    const r = this.db.prepare(`${SELECT_SHEETS} WHERE s.id = ? AND s.kind = 'deck'`).get(id) as SheetRow | undefined;
    if (!r) return null;
    return { meta: toMeta(r), deck: migrateDeck(await this.read<Deck>(r)), ownerId: r.owner_id };
  }

  async saveDeck(who: ViewerArg, id: string, deck: Deck): Promise<SheetMeta | null> {
    const r = this.row(who, id, 'deck', 'editor');
    return r ? this.write(r, deck) : null;
  }

  // --- Text documents ------------------------------------------------------------

  async createDoc(scope: ScopeArg, title: string, doc: Doc, folder = ''): Promise<SheetMeta> {
    return this.insert(scope, 'doc', title, doc, folder, this.richFormat('doc', doc));
  }

  async loadDoc(who: ViewerArg, id: string): Promise<{ meta: SheetMeta; doc: Doc; notKept?: string[] } | null> {
    const r = this.row(who, id, 'doc');
    if (!r) return null;
    const doc = await this.read<Doc>(r);
    const notKept = this.notKept(r);
    return { meta: toMeta(r), doc, ...(notKept?.length ? { notKept } : {}) };
  }

  async saveDoc(who: ViewerArg, id: string, doc: Doc): Promise<SheetMeta | null> {
    const r = this.row(who, id, 'doc', 'editor');
    return r ? this.write(r, doc) : null;
  }

  // --- Markdown documents --------------------------------------------------------

  async createMarkdown(scope: ScopeArg, title: string, doc: MarkdownDoc, folder = ''): Promise<SheetMeta> {
    return this.insert(scope, 'markdown', title, doc, folder);
  }

  async loadMarkdown(who: ViewerArg, id: string): Promise<{ meta: SheetMeta; doc: MarkdownDoc } | null> {
    const r = this.row(who, id, 'markdown');
    if (!r) return null;
    return { meta: toMeta(r), doc: await this.read<MarkdownDoc>(r) };
  }

  async saveMarkdown(who: ViewerArg, id: string, doc: MarkdownDoc): Promise<SheetMeta | null> {
    const r = this.row(who, id, 'markdown', 'editor');
    return r ? this.write(r, doc) : null;
  }

  // --- Any kind ------------------------------------------------------------------

  rename(who: ViewerArg, id: string, title: string, kind?: DocKind): SheetMeta | null {
    const r = this.row(who, id, kind, 'editor');
    if (!r) return null;
    const now = new Date().toISOString();
    this.db.prepare('UPDATE sheets SET title = ?, updated_at = ? WHERE id = ?').run(title, now, id);
    this.onRevision?.(id, now);
    return { ...toMeta(r), title, updatedAt: now };
  }

  async delete(who: ViewerArg, id: string, kind?: DocKind): Promise<boolean> {
    const r = this.row(who, id, kind, 'owner');
    if (!r) return false;
    this.db.prepare('DELETE FROM sheets WHERE id = ?').run(id);
    await this.writeChains.get(id);
    this.writeChains.delete(id);
    await this.removeFile(r);
    await rm(this.basePath(id), { force: true });
    this.backup?.markDeleted(r.owner_id, r.kind, id, r.title);
    return true;
  }

  /** Puts a deleted file back (from the off-box copy), under its old id. Fails if the id is taken. */
  async restore(ownerId: string, kind: DocKind, id: string, title: string, json: string): Promise<SheetMeta> {
    if (this.db.prepare('SELECT 1 FROM sheets WHERE id = ?').get(id)) throw new Error('A file with this id already exists');
    const file = `${id}.json`;
    await writeAtomic(this.filePath(file), json);
    const now = new Date().toISOString();
    // CSV files are written as {"version":1,"csv":...}; load corrects the column if this guess is ever wrong.
    const format = kind === 'sheet' && /^\s*\{"version":1,"csv":/.test(json) ? 'csv' : null;
    this.db
      .prepare('INSERT INTO sheets (id, owner_id, kind, format, title, file, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, ownerId, kind, format, title, file, now, now);
    this.backup?.putFile(ownerId, kind, id, now, json);
    return { id, kind, ...(format ? { format } : {}), title, createdAt: now, updatedAt: now };
  }

  /** Writes the document to its file and returns its text for the off-box copy (JSON when the file is binary). */
  private async writeDoc(file: string, doc: Stored): Promise<string> {
    const data = await this.encode(file, doc);
    await writeAtomic(this.filePath(file), data);
    return typeof data === 'string' ? data : JSON.stringify(doc);
  }
}

/** Writes a file so a reader never sees half of it: a temp file next to it, then a rename. */
export async function writeAtomic(target: string, data: string | Buffer): Promise<void> {
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, target);
  wroteFile(target);
}

let ownWrites: ((file: string) => void) | null = null;
/**
 * Be told of each file the app writes (writeAtomic, Download to Folder): the desktop app opens new files that
 * appear in some folders (desktop/newFiles.js), but not its own, a document made in the app, say.
 */
export function onOwnWrite(fn: ((file: string) => void) | null): void {
  ownWrites = fn;
}
export function wroteFile(file: string): void {
  ownWrites?.(file);
}
