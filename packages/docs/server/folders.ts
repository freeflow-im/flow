// The folders of a user's library (shared/folders.ts). On the server they are rows: a folder exists once
// it is created, and files point at it by path. The desktop app's folders are directories instead
// (LocalFolders in server/localStore.ts).
import { nameSearch, parentFolder } from '../shared/folders.ts';
import type { DB } from './db.ts';

export interface Folders {
  /** Paths of the folders directly inside `parent`, by name. */
  children(ownerId: string, parent: string): string[];
  exists(ownerId: string, path: string): boolean;
  /** Create the folder (and any missing parents). False if it already exists. */
  create(ownerId: string, path: string): boolean;
  /** Why the folder's contents cannot be shown (the system refuses to list it), or null. */
  problem?(ownerId: string, path: string): string | null;
  /** Paths of the folders, anywhere in the library, whose name contains the text. */
  search(ownerId: string, text: string): Promise<string[]>;
  /** Remove an empty folder. */
  remove(ownerId: string, path: string): 'ok' | 'not-empty' | 'missing';
}

/** Most results a search of the whole library returns, per kind of thing. */
export const SEARCH_LIMIT = 200;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
export const byName = (a: string, b: string) => collator.compare(a, b);

export class FolderStore implements Folders {
  private db: DB;

  constructor(db: DB) {
    this.db = db;
  }

  children(ownerId: string, parent: string): string[] {
    const rows = this.db.prepare('SELECT path FROM folders WHERE owner_id = ?').all(ownerId) as { path: string }[];
    return rows
      .map((r) => r.path)
      .filter((p) => parentFolder(p) === parent)
      .sort(byName);
  }

  async search(ownerId: string, text: string): Promise<string[]> {
    const search = nameSearch(text);
    const rows = this.db.prepare('SELECT path FROM folders WHERE owner_id = ?').all(ownerId) as { path: string }[];
    return rows
      .map((r) => r.path)
      .filter((p) => search.matches(p))
      .sort(byName)
      .slice(0, SEARCH_LIMIT);
  }

  exists(ownerId: string, path: string): boolean {
    return path === '' || !!this.db.prepare('SELECT 1 FROM folders WHERE owner_id = ? AND path = ?').get(ownerId, path);
  }

  create(ownerId: string, path: string): boolean {
    if (this.exists(ownerId, path)) return false;
    const now = new Date().toISOString();
    for (let p = path; p && !this.exists(ownerId, p); p = parentFolder(p)) {
      this.db.prepare('INSERT INTO folders (owner_id, path, created_at) VALUES (?, ?, ?)').run(ownerId, p, now);
    }
    return true;
  }

  remove(ownerId: string, path: string): 'ok' | 'not-empty' | 'missing' {
    if (!path || !this.exists(ownerId, path)) return 'missing';
    const used =
      this.children(ownerId, path).length > 0 ||
      !!this.db.prepare('SELECT 1 FROM sheets WHERE owner_id = ? AND folder = ? LIMIT 1').get(ownerId, path) ||
      !!this.db.prepare('SELECT 1 FROM stored_files WHERE owner_id = ? AND folder = ? LIMIT 1').get(ownerId, path);
    if (used) return 'not-empty';
    this.db.prepare('DELETE FROM folders WHERE owner_id = ? AND path = ?').run(ownerId, path);
    return 'ok';
  }
}
