// The folders of a library (shared/folders.ts). On the server they are rows: a folder exists once it is created,
// and files point at it by path, within its root (server/scope.ts). The desktop app's folders are directories instead
// (LocalFolders in server/localStore.ts).
import { folderName, nameSearch, parentFolder } from '../shared/folders.ts';
import type { DB } from './db.ts';
import { scopeColumns, scopeKey, scopeWhere, type ScopeArg } from './scope.ts';

export interface Folders {
  /** Paths of the folders directly inside `parent`, by name. */
  children(scope: ScopeArg, parent: string): string[];
  exists(scope: ScopeArg, path: string): boolean;
  /** Create the folder (and any missing parents). False if it already exists. */
  create(scope: ScopeArg, path: string): boolean;
  /** Why the folder's contents cannot be shown (the system refuses to list it), or null. */
  problem?(scope: ScopeArg, path: string): string | null;
  /** Paths of the folders, anywhere in the library, whose name contains the text. */
  search(scope: ScopeArg, text: string): Promise<string[]>;
  /** Remove an empty folder. */
  remove(scope: ScopeArg, path: string): 'ok' | 'not-empty' | 'missing';
}

/** Most results a search of the whole library returns, per kind of thing. */
export const SEARCH_LIMIT = 200;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
export const byName = (a: string, b: string) => collator.compare(a, b);

/** A folder and the folders inside it, as a WHERE fragment over a `folder` (or `path`) column. */
export const underFolder = (column: string, path: string): { sql: string; params: (string | number)[] } => ({ sql: `(${column} = ? OR substr(${column}, 1, ?) = ?)`, params: [path, path.length + 1, `${path}/`] });

/**
 * The folders of each root of the library (server/scope.ts): an organization's shared files, or a user's private
 * files in one; a path is unique within its root (`folders.scope`).
 */
export class FolderStore implements Folders {
  private db: DB;

  constructor(db: DB) {
    this.db = db;
  }

  private paths(scope: ScopeArg): string[] {
    const where = scopeWhere(scope);
    const rows = this.db.prepare(`SELECT path FROM folders WHERE ${where.sql}`).all(...where.params) as { path: string }[];
    return [...new Set(rows.map((r) => r.path))];
  }

  children(scope: ScopeArg, parent: string): string[] {
    return this.paths(scope)
      .filter((p) => parentFolder(p) === parent)
      .sort(byName);
  }

  async search(scope: ScopeArg, text: string): Promise<string[]> {
    const search = nameSearch(text);
    return this.paths(scope)
      .filter((p) => search.matches(p))
      .sort(byName)
      .slice(0, SEARCH_LIMIT);
  }

  exists(scope: ScopeArg, path: string): boolean {
    if (path === '') return true;
    const where = scopeWhere(scope);
    return !!this.db.prepare(`SELECT 1 FROM folders WHERE ${where.sql} AND path = ?`).get(...where.params, path);
  }

  create(scope: ScopeArg, path: string): boolean {
    if (this.exists(scope, path)) return false;
    const now = new Date().toISOString();
    const c = scopeColumns(scope);
    for (let p = path; p && !this.exists(scope, p); p = parentFolder(p)) {
      this.db.prepare('INSERT INTO folders (owner_id, workspace_id, private, scope, path, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(c.owner_id, c.workspace_id, c.private, scopeKey(scope), p, now);
    }
    return true;
  }

  remove(scope: ScopeArg, path: string): 'ok' | 'not-empty' | 'missing' {
    if (!path || !this.exists(scope, path)) return 'missing';
    const where = scopeWhere(scope);
    const used =
      this.children(scope, path).length > 0 ||
      !!this.db.prepare(`SELECT 1 FROM sheets WHERE ${where.sql} AND folder = ? LIMIT 1`).get(...where.params, path) ||
      !!this.db.prepare(`SELECT 1 FROM stored_files WHERE ${where.sql} AND folder = ? LIMIT 1`).get(...where.params, path);
    if (used) return 'not-empty';
    this.db.prepare(`DELETE FROM folders WHERE ${where.sql} AND path = ?`).run(...where.params, path);
    return 'ok';
  }

  /**
   * Move a folder with everything in it to another root, at the top there under its own name (merged with a folder
   * of that name there): its folders, documents and stored files. Returns the ids of the documents and files moved
   * and the folder's path in the new root. The one who moves it into a private root keeps it.
   */
  moveTo(from: ScopeArg, path: string, to: ScopeArg): { path: string; sheets: string[]; files: string[] } {
    const target = folderName(path);
    const rename = (p: string) => target + p.slice(path.length);
    const where = scopeWhere(from);
    const under = underFolder('path', path);
    const moved = (this.db.prepare(`SELECT path FROM folders WHERE ${where.sql} AND ${under.sql}`).all(...where.params, ...under.params) as { path: string }[]).map((r) => r.path);
    this.db.prepare(`DELETE FROM folders WHERE ${where.sql} AND ${under.sql}`).run(...where.params, ...under.params);
    for (const p of moved.sort()) this.create(to, rename(p));
    this.create(to, target);
    const c = scopeColumns(to);
    const ids = { path: target, sheets: [] as string[], files: [] as string[] };
    for (const table of ['sheets', 'stored_files'] as const) {
      const inside = underFolder('folder', path);
      const rows = this.db.prepare(`SELECT id, owner_id, folder FROM ${table} WHERE ${where.sql} AND ${inside.sql}`).all(...where.params, ...inside.params) as { id: string; owner_id: string; folder: string }[];
      const set = this.db.prepare(`UPDATE ${table} SET owner_id = ?, workspace_id = ?, private = ?, folder = ? WHERE id = ?`);
      for (const r of rows) {
        set.run(c.private ? c.owner_id : r.owner_id, c.workspace_id, c.private, rename(r.folder), r.id);
        (table === 'sheets' ? ids.sheets : ids.files).push(r.id);
      }
    }
    return ids;
  }
}
