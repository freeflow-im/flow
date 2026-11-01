// The desktop app's storage: a folder on the user's disk instead of the server's own data directory. The
// files in the folder are the library. Markdown and CSV files are read and written as the plain text they
// are, and Excel, PowerPoint and Word files as Office files (imported when read, written back with the
// exports); a document that does not fit in its Office file is a JSON file with the app's own extension;
// every other file is listed as a stored file (PDFs, images and videos are shown, older .xls files
// converted, the rest only listed), and its directories are the library's folders. SQLite still
// holds the metadata (ids, branch links), brought in line with a directory each time it is listed, so
// everything built on SheetStore and FileStore works as is.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readdirSync, readSync, closeSync, realpathSync, renameSync, rmdirSync, rmSync, statSync } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, rename, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { newCsvDoc, type CsvDoc } from '../shared/csv.ts';
import { newMarkdownDoc, type MarkdownDoc } from '../shared/markdown.ts';
import { joinFolder, nameSearch, parentFolder } from '../shared/folders.ts';
import type { Deck } from '../shared/deck.ts';
import type { Doc } from '../shared/doc.ts';
import { docxProblem } from '../shared/docxFormat.ts';
import { pptxGaps } from '../shared/pptxFormat.ts';
import { fileTypeOf, VIDEO_TYPES, type DocKind, type SheetMeta, type StoredFile, type Workbook } from '../shared/types.ts';
import { xlsxProblem } from '../shared/xlsxFormat.ts';
import type { DB } from './db.ts';
import { docDocx } from './docxExport.ts';
import { importDocx } from './docxImport.ts';
import { deckPptx, type ImageSource } from './export.ts';
import { workbookXlsx } from './export.ts';
import { importPptx } from './pptxImport.ts';
import { FileStore, renamed, splitName, type StoredFileRow } from './files.ts';
import { byName, SEARCH_LIMIT, type Folders } from './folders.ts';
import { SheetStore, writeAtomic, type SheetFormat, type SheetRow, type Stored } from './sheets.ts';
import { importXlsx } from './xlsxImport.ts';

/** Extensions of the files that open in an editor. */
const DOC_TYPES: Record<string, { kind: DocKind; format: SheetFormat | null }> = {
  '.md': { kind: 'markdown', format: null },
  '.markdown': { kind: 'markdown', format: null },
  '.csv': { kind: 'sheet', format: 'csv' },
  '.xlsx': { kind: 'sheet', format: 'xlsx' },
  '.pptx': { kind: 'deck', format: 'pptx' },
  '.docx': { kind: 'doc', format: 'docx' },
  '.ffsheet': { kind: 'sheet', format: null },
  '.ffslides': { kind: 'deck', format: null },
  '.ffdoc': { kind: 'doc', format: null },
};
/** The extension of a document of each kind in the app's own format. */
const NEW_EXT: Record<DocKind, string> = { sheet: '.ffsheet', deck: '.ffslides', doc: '.ffdoc', markdown: '.md' };
/** The extension of a document's file, by its kind and format. */
const extFor = (kind: DocKind, format: SheetFormat | null) => (format ? `.${format}` : NEW_EXT[kind]);

/** Other files that are listed: previews for PDFs, images and videos, and older Excel files, which can be converted. */
const FILE_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.xls': 'application/vnd.ms-excel',
  ...Object.fromEntries(Object.entries(VIDEO_TYPES).map(([ext, type]) => [`.${ext}`, type])),
};

/** The type a file of the folder is listed as. */
const typeOfFile = (rel: string): string => FILE_TYPES[extOf(rel)] ?? fileTypeOf(rel) ?? 'application/octet-stream';

/** The extensions of the files the desktop app shows (the others are listed, not opened). */
export const LISTED_EXTS: ReadonlySet<string> = new Set([...Object.keys(DOC_TYPES), ...Object.keys(FILE_TYPES)]);
/** What a listed file is in the library: a document of some kind, or a stored file. */
export const listedKind = (file: string): DocKind | 'file' => DOC_TYPES[extOf(file)]?.kind ?? 'file';

const MAX_DEPTH = 8;
const MAX_FILES = 5000;
const SKIP_DIRS = new Set(['node_modules']);
/** Folders that are listed but not walked through when looking through the whole tree (a search, the assistant's file list): a repository's history is many files, none of them documents. */
const SKIP_IN_WALK = new Set(['.git']);
/** Finder's own bookkeeping, never shown, though every other hidden file and folder is. */
const SYSTEM_FILES = new Set(['.DS_Store']);
/** How long a search of the whole tree may take before it returns what it has. */
const FIND_BUDGET_MS = 60_000;

const extOf = (file: string) => path.extname(file).toLowerCase();
const iso = (ms: number) => new Date(ms).toISOString();
/** A file's name in the library is its file name without the extension. */
/** A document's title is its file's name, extension and all: the app never hides an extension (shared/docNames.ts). */
const titleOf = (rel: string) => path.posix.basename(rel);
/** The name without the extension, for the title inside an Office file. */
const baseOf = (rel: string) => path.posix.basename(rel, path.extname(rel));

type NameSearch = ReturnType<typeof nameSearch>;

interface Found {
  /** Path relative to the mounted folder, with forward slashes. */
  rel: string;
  ext: string;
  size: number;
  mtime: string;
  birthtime: string;
}

/**
 * Looks up files and folders by name under a directory in an index instead of walking it: the absolute paths
 * whose name contains the text, or null when the index does not cover the directory.
 */
export type FindByName = (root: string, text: string) => Promise<string[] | null>;

const mdfind = (args: string[]): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile('/usr/bin/mdfind', args, { maxBuffer: 64 * 1024 * 1024, timeout: 15_000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  });

/** The directories Spotlight was lately seen to cover, and when. */
const indexed = new Map<string, number>();
const INDEXED_FOR_MS = 10 * 60_000;

/**
 * Whether Spotlight covers a directory: it finds the oldest of the directory's own entries by name (a new one
 * may not be indexed yet). A volume or folder it leaves out (indexing off, Privacy) finds nothing.
 */
async function spotlightCovers(root: string): Promise<boolean> {
  if (Date.now() - (indexed.get(root) ?? -Infinity) < INDEXED_FOR_MS) return true;
  let oldest: { name: string; at: number } | null = null;
  try {
    for (const name of readdirSync(root).slice(0, 100)) {
      if (name.startsWith('.')) continue; // Spotlight leaves hidden files out.
      const at = statSync(path.join(root, name)).mtimeMs;
      if (!oldest || at < oldest.at) oldest = { name, at };
    }
  } catch {
    return false;
  }
  if (!oldest) return false;
  const found = await mdfind(['-onlyin', root, `kMDItemFSName == "${spotlightText(oldest.name)}"`]).catch(() => '');
  const covered = found.split('\n').some((p) => path.dirname(p) === root);
  if (covered) indexed.set(root, Date.now());
  return covered;
}

/** Text inside a Spotlight query's quotes, its wildcards and quotes taken literally. */
const spotlightText = (text: string) => text.replace(/[\\"*?]/g, '\\$&');

/** Spotlight's index (macOS): far quicker than walking a large tree, though it leaves hidden files out. */
export const spotlightFind: FindByName = async (dir, text) => {
  const root = realpathSync(dir); // Spotlight answers with real paths (/private/var/..., not /var/...).
  const [covered, found] = await Promise.all([spotlightCovers(root), mdfind(['-onlyin', root, `kMDItemFSName == "*${spotlightText(text)}*"c`])]);
  if (!covered) return null;
  return found
    .split('\n')
    .filter(Boolean)
    .map((p) => path.join(dir, path.relative(root, p)));
};

/** The mounted folder: finds its files, picks names for new ones, and keeps deleted ones recoverable. */
export class LocalFolder {
  readonly root: string;
  private trashDir: string;
  private index: FindByName | null;
  private findBudgetMs: number;

  /**
   * `trashDir` is where deleted files are moved (outside the folder), so a delete can be taken back by hand.
   * `index` is asked by a search before it walks the tree (Spotlight on macOS); `findBudgetMs` is how long a
   * search may walk it instead.
   */
  constructor(root: string, trashDir: string, index: FindByName | null = null, findBudgetMs = FIND_BUDGET_MS) {
    this.root = path.resolve(root);
    this.trashDir = trashDir;
    this.index = index;
    this.findBudgetMs = findBudgetMs;
  }

  /**
   * Left out when looking through the whole tree (a search, the assistant's file list), though it can
   * still be opened: the system's Library in a home directory, which is vast and holds no documents.
   */
  private skipInWalk(rel: string): boolean {
    return SKIP_IN_WALK.has(path.posix.basename(rel)) || (rel === 'Library' && this.root === path.resolve(homedir()));
  }

  abs(rel: string): string {
    return path.join(this.root, ...rel.split('/'));
  }

  /**
   * The files and the folders directly inside one folder, hidden ones (".env", ".git") included. node_modules,
   * .DS_Store and symbolic links are skipped. `all` lists every file; otherwise only the kinds the app shows.
   */
  scanDir(folder: string, all = true): { files: Found[]; dirs: string[] } {
    const files: Found[] = [];
    const dirs: string[] = [];
    let entries;
    try {
      entries = readdirSync(this.abs(folder), { withFileTypes: true });
    } catch {
      return { files, dirs }; // Unreadable or gone: nothing to show.
    }
    for (const e of entries) {
      if (SYSTEM_FILES.has(e.name)) continue;
      const rel = joinFolder(folder, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) dirs.push(rel);
      } else if (e.isFile()) {
        const ext = extOf(e.name);
        if (!all && !(ext in DOC_TYPES) && !(ext in FILE_TYPES)) continue;
        try {
          const st = statSync(this.abs(rel));
          files.push({ rel, ext, size: st.size, mtime: iso(st.mtimeMs), birthtime: iso(st.birthtimeMs || st.mtimeMs) });
        } catch {
          // Gone since it was listed.
        }
      }
    }
    return { files, dirs: dirs.sort(byName) };
  }

  /**
   * Every file the app shows under the mounted folder, up to a limit: what the assistant's file list covers.
   * Other files are left out, so a tree of source code does not crowd out the documents.
   */
  scanAll(): Found[] {
    const all: Found[] = [];
    const walk = (folder: string, depth: number) => {
      const { files, dirs } = this.scanDir(folder, false);
      for (const f of files) if (all.length < MAX_FILES) all.push(f);
      if (depth < MAX_DEPTH) for (const d of dirs) if (all.length < MAX_FILES && !this.skipInWalk(d)) walk(d, depth + 1);
    };
    walk('', 0);
    return all;
  }

  private lastFind: { text: string; at: number; result: Promise<{ files: Found[]; dirs: string[]; truncated: boolean }> } | null = null;

  /**
   * Listed files and folders, anywhere under the mounted folder, whose name contains the text (or whose path ends
   * as it does, for text with a slash: `nameSearch`). The tree is
   * walked level by level, so what is near the top is found first, and without holding up other requests;
   * `truncated` says the walk stopped early (enough results, or out of time on a very large tree). One
   * search asks for documents, files and folders in turn, so a walk is shared for a moment. An index
   * (`index`) that covers the folder answers instead, in a moment however large the tree.
   */
  find(text: string): Promise<{ files: Found[]; dirs: string[]; truncated: boolean }> {
    // Shared while it runs and for a moment after it finishes.
    if (this.lastFind && this.lastFind.text === text && Date.now() - this.lastFind.at < 2000) return this.lastFind.result;
    const search = nameSearch(text);
    const result = this.lookUp(search).then((r) => r ?? this.walkFor(search));
    const entry = { text, at: Infinity, result };
    this.lastFind = entry;
    void result.finally(() => (entry.at = Date.now()));
    return result;
  }

  /**
   * The index's answer, held to what the walk would find: names containing the text whatever their case (paths
   * ending as it does: the index is asked for the name), nearest the top first, nothing in or under a folder the
   * walk skips; null when there is no index for the folder, or the name is a hidden file's.
   */
  private async lookUp(search: NameSearch): Promise<{ files: Found[]; dirs: string[]; truncated: boolean } | null> {
    let paths: string[] | null;
    try {
      // Spotlight leaves hidden files (.env) out, so a name that starts with a dot is walked for.
      paths = this.index && search.name && !search.name.startsWith('.') ? await this.index(this.root, search.name) : null;
    } catch {
      paths = null; // Not answering, or too slow: walk instead.
    }
    if (!paths) return null;
    const rels = paths
      .map((p) => path.relative(this.root, p).split(path.sep))
      .filter((parts) => parts[0] && parts[0] !== '..' && !path.isAbsolute(parts[0]))
      .filter((parts) => search.matches(parts.join('/')) && !SYSTEM_FILES.has(parts.at(-1)!))
      .filter((parts) => !parts.some((p, i) => SKIP_DIRS.has(p) || this.skipInWalk(parts.slice(0, i + 1).join('/'))))
      .map((parts) => ({ rel: parts.join('/'), depth: parts.length }))
      .sort((a, b) => a.depth - b.depth || byName(a.rel, b.rel));
    const files: Found[] = [];
    const dirs: string[] = [];
    for (const { rel } of rels) {
      if (files.length >= SEARCH_LIMIT || dirs.length >= SEARCH_LIMIT) return { files, dirs, truncated: true };
      try {
        const st = await lstat(this.abs(rel));
        if (st.isDirectory()) dirs.push(rel);
        else if (st.isFile()) files.push({ rel, ext: extOf(rel), size: st.size, mtime: iso(st.mtimeMs), birthtime: iso(st.birthtimeMs || st.mtimeMs) });
      } catch {
        // Gone since it was indexed.
      }
    }
    return { files, dirs, truncated: false };
  }

  private async walkFor(search: NameSearch): Promise<{ files: Found[]; dirs: string[]; truncated: boolean }> {
    const files: Found[] = [];
    const dirs: string[] = [];
    const deadline = Date.now() + this.findBudgetMs;
    let level = [''];
    // However deep the tree goes; the time allowed is what bounds the walk.
    for (let depth = 0; level.length && depth <= 40; depth++) {
      const next: string[] = [];
      for (const folder of level) {
        if (files.length >= SEARCH_LIMIT || dirs.length >= SEARCH_LIMIT || Date.now() > deadline) return { files, dirs, truncated: true };
        let entries;
        try {
          entries = await readdir(this.abs(folder), { withFileTypes: true });
        } catch {
          continue; // Unreadable: nothing to find there.
        }
        for (const e of entries) {
          if (SYSTEM_FILES.has(e.name)) continue;
          const rel = joinFolder(folder, e.name);
          const hit = search.matches(rel);
          if (e.isDirectory()) {
            if (SKIP_DIRS.has(e.name) || this.skipInWalk(rel)) continue;
            next.push(rel);
            if (hit) dirs.push(rel);
          } else if (hit && e.isFile()) {
            // Any file: a search finds what the folder's own listing shows.
            const ext = extOf(e.name);
            try {
              const st = await stat(this.abs(rel));
              files.push({ rel, ext, size: st.size, mtime: iso(st.mtimeMs), birthtime: iso(st.birthtimeMs || st.mtimeMs) });
            } catch {
              // Gone since it was listed.
            }
          }
        }
      }
      level = next;
    }
    return { files, dirs, truncated: level.length > 0 };
  }

  isDir(rel: string): boolean {
    try {
      return statSync(this.abs(rel)).isDirectory();
    } catch {
      return false;
    }
  }

  /** When a file was last modified, or null if it is gone. */
  mtime(rel: string): string | null {
    try {
      return iso(statSync(this.abs(rel)).mtimeMs);
    } catch {
      return null;
    }
  }

  /**
   * A free path in a folder for a file the user named: characters a file name cannot have are dropped, and
   * a number is added if the name is taken. Creates the folder if it is missing.
   */
  freePath(folder: string, name: string, ext: string): string {
    // A name that has the extension already (a title, which is a file name) does not get it twice.
    if (ext && name.toLowerCase().endsWith(ext.toLowerCase())) name = name.slice(0, name.length - ext.length);
    const base =
      name
        .replace(/[\\/]/g, '-')
        .replace(/[\u0000-\u001f<>:"|?*]/g, '')
        .trim()
        .replace(/^\.+/, '')
        .replace(/[. ]+$/, '')
        .slice(0, 120) || 'Untitled';
    let rel = joinFolder(folder, `${base}${ext}`);
    for (let n = 2; existsSync(this.abs(rel)); n++) rel = joinFolder(folder, `${base} ${n}${ext}`);
    mkdirSync(this.abs(folder), { recursive: true });
    return rel;
  }

  private trashPath(rel: string): string {
    return path.join(this.trashDir, `${new Date().toISOString().replace(/[:.]/g, '-')} ${path.basename(rel)}`);
  }

  /** Move a deleted file out of the folder, into the trash directory. */
  async trash(rel: string): Promise<void> {
    const from = this.abs(rel);
    if (!existsSync(from)) return;
    await mkdir(this.trashDir, { recursive: true });
    await rename(from, this.trashPath(rel));
  }

  /** Put a copy of a file as it is now in the trash directory, before it is written over. */
  async keepCopy(rel: string): Promise<void> {
    await mkdir(this.trashDir, { recursive: true });
    await copyFile(this.abs(rel), this.trashPath(rel));
  }
}

/** The library's folders are the directories of the mounted folder. */
export class LocalFolders implements Folders {
  private folder: LocalFolder;

  constructor(folder: LocalFolder) {
    this.folder = folder;
  }

  children(_ownerId: string, parent: string): string[] {
    return this.folder.scanDir(parent).dirs;
  }

  async search(_ownerId: string, text: string): Promise<string[]> {
    return (await this.folder.find(text)).dirs;
  }

  exists(_ownerId: string, p: string): boolean {
    return p === '' || this.folder.isDir(p);
  }

  /** A directory the system will not let the app read must not look like an empty one. */
  problem(_ownerId: string, p: string): string | null {
    try {
      readdirSync(this.folder.abs(p));
      return null;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      const name = p ? `“${path.posix.basename(p)}”` : 'this folder';
      if (code === 'EPERM' && process.platform === 'darwin') {
        return `macOS has not given the app permission to read ${name}. Allow it under System Settings → Privacy & Security → Files and Folders (or Full Disk Access), for MCP Docs or for the terminal you started it from, then open the folder again.`;
      }
      if (code === 'EPERM' || code === 'EACCES') return `You do not have permission to read ${name}.`;
      return `${name} could not be read (${code ?? 'unknown error'}).`;
    }
  }

  create(_ownerId: string, p: string): boolean {
    if (existsSync(this.folder.abs(p))) return false;
    mkdirSync(this.folder.abs(p), { recursive: true });
    return true;
  }

  /** Only a directory holding nothing at all is removed, whether or not the library lists what is in it. */
  remove(_ownerId: string, p: string): 'ok' | 'not-empty' | 'missing' {
    if (!p || !this.folder.isDir(p)) return 'missing';
    const dir = this.folder.abs(p);
    const entries = readdirSync(dir);
    if (entries.some((e) => e !== '.DS_Store')) return 'not-empty';
    for (const e of entries) rmSync(path.join(dir, e));
    rmdirSync(dir);
    return 'ok';
  }
}

/** True if the file starts as a zip archive does (an Office file), false if not or if it cannot be read. */
function isZip(file: string): boolean {
  try {
    const fd = openSync(file, 'r');
    try {
      const head = Buffer.alloc(2);
      return readSync(fd, head, 0, 2, 0) === 2 && head.toString('latin1') === 'PK';
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

export class LocalSheetStore extends SheetStore {
  private folder: LocalFolder;
  private baseDir: string;
  /** The modification time of each file as this store last wrote it: one with another time was written by something else. */
  private written = new Map<string, string>();
  /** What each Office file read holds that writing it back would remove (what its import dropped, and what its export approximates). */
  private lost = new Map<string, string[]>();
  /**
   * Where the pictures of PowerPoint and Word files go when they are read (stored once however often the file
   * is opened), and where they come from when one is written. Set by the app, which has the image store.
   */
  media: { store(type: string, data: Buffer): Promise<string>; source: ImageSource } | null = null;

  private get pictures(): NonNullable<LocalSheetStore['media']> {
    if (!this.media) throw new Error('No image store for PowerPoint and Word files');
    return this.media;
  }

  /** `dataDir` holds what does not belong in the user's folder (branch snapshots). */
  constructor(db: DB, folder: LocalFolder, dataDir: string) {
    super(db, folder.root);
    this.folder = folder;
    this.baseDir = path.join(dataDir, 'bases');
  }

  override async init(): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });
    // Rows from before folders (the folder column came later, empty) put a file in a subfolder at the top
    // of the library, named by its whole path. A row's folder and name follow from its file.
    const rows = this.db.prepare('SELECT id, file, title, folder FROM sheets').all() as unknown as Pick<SheetRow, 'id' | 'file' | 'title' | 'folder'>[];
    for (const r of rows) {
      const folder = parentFolder(r.file);
      const title = titleOf(r.file);
      if (r.folder !== folder || r.title !== title) this.db.prepare('UPDATE sheets SET folder = ?, title = ? WHERE id = ?').run(folder, title, r.id);
    }
  }

  /**
   * Bring the table in line with the files found: new files get a row, and rows of files that are gone
   * are removed. `inFolder` limits the clean-up to the rows of one folder (the one that was scanned), and
   * `adoptOnly` skips it (the files are search results, not everything there is).
   */
  private sync(ownerId: string, found: Found[], inFolder?: string, adoptOnly = false): void {
    type Row = Pick<SheetRow, 'id' | 'file' | 'title' | 'folder' | 'updated_at'>;
    const rows = (
      inFolder === undefined
        ? this.db.prepare('SELECT id, file, title, folder, updated_at FROM sheets WHERE owner_id = ?').all(ownerId)
        : this.db.prepare('SELECT id, file, title, folder, updated_at FROM sheets WHERE owner_id = ? AND folder = ?').all(ownerId, inFolder)
    ) as unknown as Row[];
    const byFile = new Map(rows.map((r) => [r.file, r]));
    const seen = new Set<string>();
    for (const f of found) {
      const type = DOC_TYPES[f.ext];
      if (!type) continue;
      seen.add(f.rel);
      const title = titleOf(f.rel);
      const folder = parentFolder(f.rel);
      // A file listed one folder at a time may already have its row from a listing of everything.
      const r = byFile.get(f.rel) ?? (inFolder === undefined ? undefined : (this.db.prepare('SELECT id, file, title, folder, updated_at FROM sheets WHERE owner_id = ? AND file = ?').get(ownerId, f.rel) as Row | undefined));
      if (!r) {
        this.db
          .prepare('INSERT INTO sheets (id, owner_id, kind, format, title, folder, file, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(this.newId(), ownerId, type.kind, type.format, title, folder, f.rel, f.birthtime, f.mtime);
      } else {
        if (r.title !== title || r.folder !== folder) this.db.prepare('UPDATE sheets SET title = ?, folder = ? WHERE id = ?').run(title, folder, r.id);
        this.retime(r, f.mtime);
      }
    }
    if (adoptOnly) return;
    for (const r of rows) if (!seen.has(r.file) && !existsSync(this.folder.abs(r.file))) this.db.prepare('DELETE FROM sheets WHERE id = ?').run(r.id);
  }

  /** Searches the directories themselves, so files the app has not listed yet are found too. */
  override async search(ownerId: string, text: string): Promise<SheetMeta[]> {
    const found = (await this.folder.find(text)).files.filter((f) => f.ext in DOC_TYPES);
    this.sync(ownerId, found, undefined, true);
    const out: SheetMeta[] = [];
    for (const f of found) {
      const r = this.db.prepare('SELECT id FROM sheets WHERE owner_id = ? AND file = ?').get(ownerId, f.rel) as { id: string } | undefined;
      const meta = r && this.get(ownerId, r.id);
      if (meta) out.push(meta);
    }
    return out;
  }

  /** Every document of a kind, wherever it is (the assistant's lists): looks through the whole mounted folder. */
  override list(ownerId: string, kind: DocKind = 'sheet'): SheetMeta[] {
    this.sync(ownerId, this.folder.scanAll());
    return super.list(ownerId, kind);
  }

  override listIn(ownerId: string, folder: string): SheetMeta[] {
    this.sync(ownerId, this.folder.scanDir(folder).files, folder);
    return super.listIn(ownerId, folder);
  }

  /** The id of the document that is the file at `rel` (a path inside the mounted folder), which is listed first if it never was. */
  idOf(ownerId: string, rel: string): string | null {
    this.listIn(ownerId, parentFolder(rel));
    return (this.db.prepare('SELECT id FROM sheets WHERE owner_id = ? AND file = ?').get(ownerId, rel) as { id: string } | undefined)?.id ?? null;
  }

  /** The absolute path of a document's file, or null when there is no such document. */
  fileOf(ownerId: string, id: string): string | null {
    const r = this.row(ownerId, id);
    return r ? this.folder.abs(r.file) : null;
  }

  /** The path inside the folder of a document's file, or null when there is no such document. */
  relOf(ownerId: string, id: string): string | null {
    return this.row(ownerId, id)?.file ?? null;
  }

  /** The file at `rel` may have been changed by another program (folderWatch.ts): see `retime`. */
  fileChanged(rel: string): void {
    const r = this.db.prepare('SELECT id, updated_at FROM sheets WHERE file = ?').get(rel) as Pick<SheetRow, 'id' | 'updated_at'> | undefined;
    const mtime = r && this.folder.mtime(rel);
    if (r && mtime) this.retime(r, mtime);
  }

  /**
   * A file's time is not the one known: something else wrote it, so the document has a new revision, announced
   * to its open editors (onRevision) so they load it, whichever request or watcher noticed first. The store's own
   * writes are known by the time anything looks, and announced by the save itself.
   */
  private retime(r: Pick<SheetRow, 'id' | 'updated_at'>, mtime: string): void {
    if (mtime === r.updated_at) return;
    this.db.prepare('UPDATE sheets SET updated_at = ? WHERE id = ?').run(mtime, r.id);
    r.updated_at = mtime;
    this.onRevision?.(r.id, mtime);
  }

  /** A row is only as good as its file: one that was removed is gone, one that was edited has a new time. */
  protected override row(ownerId: string, id: string, kind?: DocKind): SheetRow | undefined {
    const r = super.row(ownerId, id, kind);
    if (!r) return undefined;
    const mtime = this.folder.mtime(r.file);
    if (mtime === null) {
      this.db.prepare('DELETE FROM sheets WHERE id = ?').run(r.id);
      return undefined;
    }
    this.retime(r, mtime);
    return r;
  }

  protected override filePath(file: string): string {
    return this.folder.abs(file);
  }

  protected override newFile(_id: string, kind: DocKind, format: SheetFormat | null, title: string, folder: string): { file: string; title: string } {
    const file = this.folder.freePath(folder, title, extFor(kind, format));
    return { file, title: titleOf(file) };
  }

  /** Documents are Office files whenever they fit in one, so the app's own formats stay out of sight. */
  protected override richFormat(kind: DocKind, doc: Stored): SheetFormat | null {
    if (kind === 'sheet') return xlsxProblem(doc as Workbook) ? null : 'xlsx';
    if (kind === 'deck') return pptxGaps(doc as Deck).length ? null : 'pptx';
    if (kind === 'doc') return docxProblem(doc as Doc) ? null : 'docx';
    return null;
  }

  /** Only what an Office file written by something else holds counts: the app's own writing lost nothing more. */
  protected override notKept(r: SheetRow): string[] | undefined {
    return r.format && r.format !== 'csv' && this.written.get(r.file) !== r.updated_at ? this.lost.get(r.file) : undefined;
  }

  protected override async encode(file: string, doc: Stored): Promise<string | Buffer> {
    const type = DOC_TYPES[extOf(file)];
    if (type?.kind === 'markdown') return (doc as MarkdownDoc).text;
    if (type?.format === 'csv') return (doc as CsvDoc).csv;
    if (type?.format) {
      // The first time an Office file made elsewhere is written over, a copy of it as it was is kept (writing
      // drops what the app does not read). A file that was something else just before (a CSV file being
      // converted) is not one.
      if (this.written.get(file) !== this.folder.mtime(file) && isZip(this.folder.abs(file))) await this.folder.keepCopy(file);
      if (type.format === 'xlsx') return workbookXlsx(doc as Workbook, baseOf(file));
      if (type.format === 'pptx') return deckPptx(doc as Deck, baseOf(file), this.pictures.source);
      return docDocx(doc as Doc, baseOf(file), async (src) => {
        const img = await this.pictures.source.stored(src);
        return img && { type: img.type, data: img.bytes };
      });
    }
    return JSON.stringify(doc);
  }

  protected override async decode(file: string, data: Buffer): Promise<Stored> {
    const type = DOC_TYPES[extOf(file)];
    if (type?.format === 'xlsx') {
      const { workbook, lost } = await importXlsx(data);
      this.lost.set(file, lost);
      return workbook;
    }
    // What the import reports is what it dropped; what the export approximates is lost on saving too.
    if (type?.format === 'pptx') {
      const { deck, warnings } = await importPptx(data, (t, d) => this.pictures.store(t, d));
      this.lost.set(file, [...warnings, ...pptxGaps(deck)]);
      return deck;
    }
    if (type?.format === 'docx') {
      const { doc, warnings } = await importDocx(data, (t, d) => this.pictures.store(t, d));
      this.lost.set(file, warnings);
      return doc;
    }
    const text = data.toString('utf8');
    if (type?.kind === 'markdown') return newMarkdownDoc(text);
    if (type?.format === 'csv') return newCsvDoc(text);
    return JSON.parse(text) as Stored;
  }

  protected override basePath(id: string): string {
    return path.join(this.baseDir, `${id}.json`);
  }

  /** Called right after the store writes a file, so the time is the one of its own writing. */
  protected override stamp(file: string): string {
    const mtime = this.folder.mtime(file) ?? new Date().toISOString();
    this.written.set(file, mtime);
    return mtime;
  }

  protected override async removeFile(r: SheetRow): Promise<void> {
    await this.folder.trash(r.file);
  }

  /** The format is the extension: a CSV file that becomes an Excel file, say, is renamed to match. */
  protected override setFormat(r: SheetRow, format: SheetFormat | null): void {
    const want = extFor(r.kind, format);
    if (extOf(r.file) !== want) this.moveFile(r, this.folder.freePath(r.folder, baseOf(r.file), want));
    super.setFormat(r, format);
  }

  /** Move the document's file; its title and folder follow from where it ends up. */
  private moveFile(r: SheetRow, to: string): void {
    renameSync(this.folder.abs(r.file), this.folder.abs(to));
    // A move keeps the file's time: what is known of it moves with it.
    for (const known of [this.written, this.lost] as Map<string, unknown>[]) {
      if (known.has(r.file)) known.set(to, known.get(r.file));
      known.delete(r.file);
    }
    r.file = to;
    r.title = titleOf(to);
    r.folder = parentFolder(to);
    this.db.prepare('UPDATE sheets SET file = ?, title = ?, folder = ? WHERE id = ?').run(r.file, r.title, r.folder, r.id);
  }

  /** Renaming a document renames its file. */
  override rename(ownerId: string, id: string, title: string, kind?: DocKind): SheetMeta | null {
    const r = this.row(ownerId, id, kind);
    if (!r) return null;
    // As a stored file is (renamed): what was typed, with the file's extension whether it was typed or not.
    const wanted = renamed(r.title, title);
    if (wanted !== r.title) this.moveFile(r, this.folder.freePath(r.folder, baseOf(wanted), path.extname(r.file)));
    const meta = super.rename(ownerId, id, r.title, kind);
    // The rename did not touch the content, so the document keeps the time of its file.
    return meta && { ...meta, updatedAt: this.row(ownerId, id, kind)?.updated_at ?? meta.updatedAt };
  }

  /** Moving a document moves its file into that directory. */
  override move(ownerId: string, id: string, folder: string): SheetMeta | null {
    const r = this.row(ownerId, id);
    if (!r) return null;
    if (folder !== r.folder) this.moveFile(r, this.folder.freePath(folder, baseOf(r.file), path.extname(r.file)));
    return this.get(ownerId, id);
  }
}

export class LocalFileStore extends FileStore {
  private folder: LocalFolder;

  constructor(db: DB, folder: LocalFolder) {
    super(db, folder.root);
    this.folder = folder;
  }

  override async init(): Promise<void> {}

  /** The folder is the user's own: no copies of earlier versions are left in it. */
  protected override previousPath(): string | null {
    return null;
  }

  private relOf(r: Pick<StoredFileRow, 'filename' | 'folder'>): string {
    return joinFolder(r.folder ?? '', r.filename);
  }

  protected override pathOf(r: StoredFileRow): string {
    return this.folder.abs(this.relOf(r));
  }

  private sync(ownerId: string, found: Found[], inFolder?: string, adoptOnly = false): void {
    const rows = (
      inFolder === undefined
        ? this.db.prepare('SELECT id, filename, folder, type, size, created_at FROM stored_files WHERE owner_id = ?').all(ownerId)
        : this.db.prepare('SELECT id, filename, folder, type, size, created_at FROM stored_files WHERE owner_id = ? AND folder = ?').all(ownerId, inFolder)
    ) as unknown as StoredFileRow[];
    const byRel = new Map(rows.map((r) => [this.relOf(r), r]));
    const seen = new Set<string>();
    for (const f of found) {
      // Everything that is not one of the app's own documents is a stored file.
      if (f.ext in DOC_TYPES) continue;
      seen.add(f.rel);
      const filename = path.posix.basename(f.rel);
      const folder = parentFolder(f.rel);
      const r =
        byRel.get(f.rel) ??
        (inFolder === undefined ? undefined : (this.db.prepare('SELECT id, filename, folder, type, size, created_at FROM stored_files WHERE owner_id = ? AND folder = ? AND filename = ?').get(ownerId, folder, filename) as StoredFileRow | undefined));
      if (!r) {
        this.db
          .prepare('INSERT INTO stored_files (id, owner_id, filename, folder, type, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(this.newId(), ownerId, filename, folder, typeOfFile(f.rel), f.size, f.mtime);
      } else if (r.size !== f.size || r.created_at !== f.mtime) {
        this.db.prepare('UPDATE stored_files SET size = ?, created_at = ? WHERE id = ?').run(f.size, f.mtime, r.id);
      }
    }
    if (adoptOnly) return;
    // A file name holds no folder: such a row is left over from a version that kept the whole path there.
    // One of a kind that is now a document (Excel files were stored files once) is listed as the document.
    for (const [rel, r] of byRel) if (r.filename.includes('/') || extOf(r.filename) in DOC_TYPES || (!seen.has(rel) && !existsSync(this.folder.abs(rel)))) this.db.prepare('DELETE FROM stored_files WHERE id = ?').run(r.id);
  }

  override async search(ownerId: string, text: string): Promise<StoredFile[]> {
    const found = (await this.folder.find(text)).files.filter((f) => !(f.ext in DOC_TYPES));
    this.sync(ownerId, found, undefined, true);
    const out: StoredFile[] = [];
    for (const f of found) {
      const r = this.db
        .prepare('SELECT id, filename, folder, type, size, created_at FROM stored_files WHERE owner_id = ? AND folder = ? AND filename = ?')
        .get(ownerId, parentFolder(f.rel), path.posix.basename(f.rel)) as StoredFileRow | undefined;
      if (r) out.push(this.meta(r));
    }
    return out;
  }

  /** Saves the file in the folder under its name (numbered if the name is taken). */
  override async create(ownerId: string, filename: string, type: string, data: Buffer, folder = ''): Promise<StoredFile> {
    const ext = path.extname(filename);
    const rel = this.folder.freePath(folder, filename.slice(0, filename.length - ext.length), ext);
    await writeAtomic(this.folder.abs(rel), data);
    const row: StoredFileRow = { id: this.newId(), filename: path.posix.basename(rel), folder, type, size: data.length, created_at: this.folder.mtime(rel) ?? new Date().toISOString() };
    this.db
      .prepare('INSERT INTO stored_files (id, owner_id, filename, folder, type, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(row.id, ownerId, row.filename, folder, row.type, row.size, row.created_at);
    return this.meta(row);
  }

  override list(ownerId: string): StoredFile[] {
    this.sync(ownerId, this.folder.scanAll());
    return super.list(ownerId);
  }

  override listIn(ownerId: string, folder: string): StoredFile[] {
    this.sync(ownerId, this.folder.scanDir(folder).files, folder);
    return super.listIn(ownerId, folder);
  }

  /** The id of the stored file at `rel` (a path inside the mounted folder), which is listed first if it never was. */
  idOf(ownerId: string, rel: string): string | null {
    const folder = parentFolder(rel);
    return this.listIn(ownerId, folder).find((f) => f.filename === path.posix.basename(rel))?.id ?? null;
  }

  override get(ownerId: string, id: string): { meta: StoredFile; file: string } | null {
    const f = super.get(ownerId, id);
    if (!f) return null;
    const file = this.folder.abs(joinFolder(f.meta.folder ?? '', f.meta.filename));
    if (!existsSync(file)) {
      this.db.prepare('DELETE FROM stored_files WHERE id = ?').run(id);
      return null;
    }
    return { meta: f.meta, file };
  }

  override move(ownerId: string, id: string, folder: string): StoredFile | null {
    const f = this.get(ownerId, id);
    if (!f) return null;
    if (folder === (f.meta.folder ?? '')) return f.meta;
    const ext = path.extname(f.meta.filename);
    const to = this.folder.freePath(folder, f.meta.filename.slice(0, f.meta.filename.length - ext.length), ext);
    renameSync(f.file, this.folder.abs(to));
    const filename = path.posix.basename(to);
    this.db.prepare('UPDATE stored_files SET filename = ?, folder = ? WHERE id = ?').run(filename, folder, id);
    return { ...f.meta, filename, folder: folder || undefined };
  }

  /** Renaming a file renames it on disk (numbered if the name is taken). */
  override rename(ownerId: string, id: string, name: string): StoredFile | null {
    const f = this.get(ownerId, id);
    if (!f) return null;
    const wanted = renamed(f.meta.filename, name);
    if (wanted === f.meta.filename) return f.meta;
    const [base, ext] = splitName(wanted);
    const to = this.folder.freePath(f.meta.folder ?? '', base, ext);
    renameSync(f.file, this.folder.abs(to));
    const filename = path.posix.basename(to);
    this.db.prepare('UPDATE stored_files SET filename = ? WHERE id = ?').run(filename, id);
    return { ...f.meta, filename };
  }

  /** A PDF signed over (the PDF signer) has no earlier version kept beside it, so a copy goes in the trash first. */
  override async update(ownerId: string, id: string, data: Buffer): Promise<StoredFile | null> {
    const f = this.get(ownerId, id);
    if (f?.meta.type === 'application/pdf') await this.folder.keepCopy(joinFolder(f.meta.folder ?? '', f.meta.filename));
    return super.update(ownerId, id, data);
  }

  override async delete(ownerId: string, id: string): Promise<boolean> {
    const f = this.get(ownerId, id);
    if (!f) return false;
    this.db.prepare('DELETE FROM stored_files WHERE id = ? AND owner_id = ?').run(id, ownerId);
    await this.folder.trash(joinFolder(f.meta.folder ?? '', f.meta.filename));
    return true;
  }
}
