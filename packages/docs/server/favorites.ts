// Favorites: the folders and files a user keeps at hand, a tab beside Recents on the home page. On the web a file is
// named by its kind and id (`doc:abc`) and a folder by its path (`folder:Reports/2026`). In the desktop app each is
// named by its absolute path (a folder's after `folder:`), so the list is the app's, the same in every folder it opens.
import type { DB } from './db.ts';

/** The prefix of a folder's name among the favorites. */
export const FOLDER_REF = 'folder:';

export class Favorites {
  private db: DB;

  constructor(db: DB) {
    this.db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS favorites (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        ref TEXT NOT NULL,
        added_at TEXT NOT NULL,
        PRIMARY KEY (user_id, ref)
      );
    `);
  }

  /** Make a file or folder a favorite, or no longer one. */
  set(userId: string, ref: string, on: boolean, when = new Date()): void {
    if (on) this.db.prepare('INSERT OR IGNORE INTO favorites (user_id, ref, added_at) VALUES (?, ?, ?)').run(userId, ref, when.toISOString());
    else this.db.prepare('DELETE FROM favorites WHERE user_id = ? AND ref = ?').run(userId, ref);
  }

  has(userId: string, ref: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM favorites WHERE user_id = ? AND ref = ?').get(userId, ref);
  }

  /** The favorites, the newest first. */
  list(userId: string): { ref: string; addedAt: string }[] {
    return (this.db.prepare('SELECT ref, added_at FROM favorites WHERE user_id = ? ORDER BY added_at DESC, rowid DESC').all(userId) as { ref: string; added_at: string }[]).map((r) => ({ ref: r.ref, addedAt: r.added_at }));
  }
}
