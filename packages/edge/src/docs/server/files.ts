// @ts-nocheck: copied from packages/docs, where it is typechecked under that package's settings (cloudflare-spikes.md).
// Stored files (generated PDFs, uploads). The bytes live next to the sheets as files named by id; the table
// holds the metadata. Files are only readable by their owner.
import { newFileId } from './ids.ts';
import { closeSync, existsSync, openSync, readSync } from '../runtime/fs.ts';
import { copyFile, mkdir, rename, rm, stat, writeFile } from '../runtime/fsp.ts';
import path from 'node:path';
import { MAX_TEXT_EDIT_BYTES, type StoredFile } from '../shared/types.ts';
import type { DB } from './db.ts';
import { canAccess, scopeColumns, scopeMeta, scopeWhere, type Owned, type ScopeArg, type ViewerArg } from './scope.ts';

export interface StoredFileRow extends Partial<Owned> {
  id: string;
  filename: string;
  /** Path of the folder the file is in; '' (or absent) at the top. */
  folder?: string;
  type: string;
  size: number;
  created_at: string;
}

export const toFileMeta = (r: StoredFileRow): StoredFile => ({
  id: r.id,
  filename: r.filename,
  ...(r.folder ? { folder: r.folder } : {}),
  ...scopeMeta(r),
  type: r.type,
  size: r.size,
  createdAt: r.created_at,
  url: `/api/files/${r.id}`,
  downloadUrl: `/api/files/${r.id}/download`,
});

/**
 * Whether bytes read from the start of a file are plain text: valid UTF-8 (which ASCII is), no NUL, and
 * hardly any control characters other than tabs, line ends, form feeds and escapes. When the sample is only
 * the start of the file (`whole` false), a character cut off at its end is not held against it.
 */
export function looksLikeText(sample: Buffer, whole = true): boolean {
  if (sample.includes(0)) return false;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample, { stream: !whole });
  } catch {
    return false;
  }
  let control = 0;
  for (const b of sample) if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d && b !== 0x0c && b !== 0x1b) control++;
  return control <= sample.length / 100;
}

/** Types whose bytes may be plain text (the rest are known not to be): what is looked at before calling a file text. */
const mayBeText = (type: string): boolean => type === 'application/octet-stream' || type.startsWith('text/') || ['application/json', 'application/xml', 'image/svg+xml'].includes(type);

/** Whether a stored file is plain text, by its first 8 KB; remembered for the file as it is (path, size and time). */
const textFiles = new Map<string, boolean>();
export function isTextFile(file: string, r: Pick<StoredFileRow, 'type' | 'size' | 'created_at'>): boolean {
  if (!mayBeText(r.type) || r.size > MAX_TEXT_EDIT_BYTES) return false;
  const key = `${file}\u0000${r.size}\u0000${r.created_at}`;
  let text = textFiles.get(key);
  if (text === undefined) {
    try {
      const fd = openSync(file, 'r');
      try {
        const sample = Buffer.alloc(Math.min(8192, r.size));
        const n = readSync(fd, sample, 0, sample.length, 0);
        text = looksLikeText(sample.subarray(0, n), n >= r.size);
      } finally {
        closeSync(fd);
      }
    } catch {
      text = false;
    }
    if (textFiles.size > 20_000) textFiles.clear();
    textFiles.set(key, text);
  }
  return text;
}

/** True if the bytes start as a picture of this type does (PNG, JPEG or WebP). */
export function isImageOfType(data: Buffer, type: string): boolean {
  if (type === 'image/png') return data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (type === 'image/jpeg') return data.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
  if (type === 'image/webp') return data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP';
  return false;
}

/** A file name without its extension, and the extension ('.pdf', or '' when it has none). */
export function splitName(filename: string): [string, string] {
  const ext = path.extname(filename);
  return [filename.slice(0, filename.length - ext.length), ext];
}

/** The name a file gets when the user renames it: what they typed, cleaned, with the extension it had. */
export function renamed(filename: string, name: string): string {
  const [, ext] = splitName(filename);
  let base = name.replace(/[\\/\u0000-\u001f]/g, '_').trim();
  if (ext && base.toLowerCase().endsWith(ext.toLowerCase())) base = base.slice(0, base.length - ext.length).trim();
  base = base.replace(/^\.+/, '').slice(0, 200 - ext.length);
  return base ? `${base}${ext}` : filename;
}

const FILE_COLUMNS = 'id, owner_id, workspace_id, private, filename, folder, type, size, created_at';

export class FileStore {
  protected db: DB;
  protected dir: string;

  constructor(db: DB, dir: string) {
    this.db = db;
    this.dir = dir;
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  /** Where a file's bytes are. */
  protected pathOf(r: StoredFileRow): string {
    return path.join(this.dir, r.id);
  }

  /** A row as the app sees it: with whether it is plain text, looked at in the file itself. */
  protected meta(r: StoredFileRow): StoredFile {
    const m = toFileMeta(r);
    return isTextFile(this.pathOf(r), r) ? { ...m, text: true } : m;
  }

  /** An id no stored file has yet. */
  protected newId(): string {
    return newFileId((id) => !!this.db.prepare('SELECT 1 FROM stored_files WHERE id = ?').get(id));
  }

  async create(scope: ScopeArg, filename: string, type: string, data: Buffer, folder = ''): Promise<StoredFile> {
    const id = this.newId();
    const c = scopeColumns(scope);
    const target = path.join(this.dir, id);
    await writeFile(`${target}.tmp`, data);
    await rename(`${target}.tmp`, target);
    const row = { id, filename, folder, type, size: data.length, created_at: new Date().toISOString(), ...c };
    this.db
      .prepare('INSERT INTO stored_files (id, owner_id, workspace_id, private, filename, folder, type, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, c.owner_id, c.workspace_id, c.private, filename, folder, type, data.length, row.created_at);
    return this.meta(row);
  }

  /** The files of a scope (server/scope.ts), most recent first. */
  list(scope: ScopeArg): StoredFile[] {
    const where = scopeWhere(scope);
    const rows = this.db.prepare(`SELECT ${FILE_COLUMNS} FROM stored_files WHERE ${where.sql} ORDER BY created_at DESC, rowid DESC`).all(...where.params) as unknown as StoredFileRow[];
    return rows.map((r) => this.meta(r));
  }

  /** The files of a scope in one folder, most recent first. */
  listIn(scope: ScopeArg, folder: string): StoredFile[] {
    const where = scopeWhere(scope);
    const rows = this.db.prepare(`SELECT ${FILE_COLUMNS} FROM stored_files WHERE ${where.sql} AND folder = ? ORDER BY created_at DESC, rowid DESC`).all(...where.params, folder) as unknown as StoredFileRow[];
    return rows.map((r) => this.meta(r));
  }

  /** The user's files, in any folder, whose name contains the text (or whose path ends as it does: `nameSearch`); most recent first. */
  async search(scope: ScopeArg, text: string, limit = 200): Promise<StoredFile[]> {
    const name = text.includes('/') ? `'/' || CASE folder WHEN '' THEN '' ELSE folder || '/' END || filename` : 'filename';
    const where = scopeWhere(scope);
    const rows = this.db
      .prepare(`SELECT ${FILE_COLUMNS} FROM stored_files WHERE ${where.sql} AND instr(lower(${name}), lower(?)) > 0 ORDER BY created_at DESC LIMIT ?`)
      .all(...where.params, text, limit) as unknown as StoredFileRow[];
    return rows.map((r) => this.meta(r));
  }

  /** Put a file in another folder. */
  move(who: ViewerArg, id: string, folder: string): StoredFile | null {
    const f = this.get(who, id);
    if (!f) return null;
    this.db.prepare('UPDATE stored_files SET folder = ? WHERE id = ?').run(folder, id);
    return { ...f.meta, folder: folder || undefined };
  }

  /**
   * Give a file another name. Its extension stays, since that is what says what kind of file it is: the new
   * name may be given with or without it. Null when there is no such file.
   */
  rename(who: ViewerArg, id: string, name: string): StoredFile | null {
    const f = this.get(who, id);
    if (!f) return null;
    const filename = renamed(f.meta.filename, name);
    if (filename === f.meta.filename) return f.meta;
    this.db.prepare('UPDATE stored_files SET filename = ? WHERE id = ?').run(filename, id);
    return { ...f.meta, filename };
  }

  /** A file's row whoever may access it: for the caller to check (canAccess) or to learn its scope. */
  find(id: string): (StoredFileRow & Owned) | undefined {
    return this.db.prepare(`SELECT ${FILE_COLUMNS} FROM stored_files WHERE id = ?`).get(id) as unknown as (StoredFileRow & Owned) | undefined;
  }

  /** A file the viewer may access (server/scope.ts' canAccess). */
  get(who: ViewerArg, id: string): { meta: StoredFile; file: string } | null {
    const r = this.find(id);
    return r && canAccess(who, r) ? { meta: this.meta(r), file: this.pathOf(r) } : null;
  }

  /** Put a file in another root (see SheetStore.setScope). */
  setScope(who: ViewerArg, id: string, scope: ScopeArg, folder: string): StoredFile | null {
    const r = this.find(id);
    if (!r || !canAccess(who, r)) return null;
    const c = scopeColumns(scope);
    const owner = c.private ? c.owner_id : r.owner_id;
    this.db.prepare('UPDATE stored_files SET owner_id = ?, workspace_id = ?, private = ?, folder = ? WHERE id = ?').run(owner, c.workspace_id, c.private, folder, id);
    return this.meta({ ...r, owner_id: owner, workspace_id: c.workspace_id, private: c.private, folder });
  }

  /** Where the version before the last rewrite of a file is kept, or null when this store keeps none. */
  protected previousPath(file: string): string | null {
    return `${file}.prev`;
  }

  /** Replace a file's bytes (a text file the assistant edited, a picture from the image editor). The version it replaces is kept, for one step of undo. */
  async update(who: ViewerArg, id: string, data: Buffer): Promise<StoredFile | null> {
    const f = this.get(who, id);
    if (!f) return null;
    const prev = this.previousPath(f.file);
    if (prev) await copyFile(f.file, prev);
    await writeFile(`${f.file}.tmp`, data);
    await rename(`${f.file}.tmp`, f.file);
    this.db.prepare('UPDATE stored_files SET size = ? WHERE id = ?').run(data.length, id);
    return this.get(who, id)!.meta;
  }

  /** Swap a file with the version before its last rewrite. Null when there is no file, or no earlier version of it. */
  async revert(who: ViewerArg, id: string): Promise<StoredFile | null> {
    const f = this.get(who, id);
    const prev = f && this.previousPath(f.file);
    if (!f || !prev || !(await stat(prev).then(() => true, () => false))) return null;
    await rename(f.file, `${f.file}.tmp`);
    await rename(prev, f.file);
    await rename(`${f.file}.tmp`, prev);
    const size = (await stat(f.file)).size;
    this.db.prepare('UPDATE stored_files SET size = ? WHERE id = ?').run(size, id);
    return { ...f.meta, size };
  }

  async delete(who: ViewerArg, id: string): Promise<boolean> {
    if (!this.get(who, id)) return false;
    const r = this.db.prepare('DELETE FROM stored_files WHERE id = ?').run(id);
    if (!r.changes) return false;
    await rm(path.join(this.dir, id), { force: true });
    await rm(path.join(this.dir, `${id}.prev`), { force: true });
    return true;
  }
}
