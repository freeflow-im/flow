// The files each user last opened in the app (RecentOpens), which the web app lists and the desktop app lists above
// the Mac's own Recents (systemRecents.ts, behind `#runtime/local/systemRecents`: Spotlight, macOS only).
import type { DB } from './db.ts';

export interface RecentFile {
  /** Absolute path. */
  path: string;
  name: string;
  /** The folder it is in, with the home directory written "~". */
  where: string;
  /** When it was last opened, or for a download not opened since, when it arrived. */
  lastUsed: string;
  size: number;
  /** Opened in this app (RecentOpens), not only known to Spotlight. */
  app?: boolean;
}

export interface Recents {
  files: RecentFile[];
  /** Folders of the home directory ("Downloads") the system does not let this app read, whose files are therefore missing. */
  blocked: string[];
}

/** How many of the files a user opened in the app are kept. */
export const APP_RECENTS = 20;
const NEWEST = 'ORDER BY opened_at DESC, rowid DESC';

/**
 * The files each user last opened in the app, newest first: each file a page shows is recorded. A file is named
 * by `ref`: on the web its kind and id ("doc:<id>"), in the desktop app its absolute path, since an id there is
 * only the open folder's and the list is every folder's (kept in the app's settings database).
 */
export class RecentOpens {
  private db: DB;

  constructor(db: DB) {
    this.db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS recent_opens (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        ref TEXT NOT NULL,
        opened_at TEXT NOT NULL,
        PRIMARY KEY (user_id, ref)
      );
      CREATE TABLE IF NOT EXISTS recents_cache (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }

  record(userId: string, ref: string, when = new Date()): void {
    // Removed and added again, so that of two opened in the same instant the later is the newer (its rowid).
    this.forget(userId, ref);
    this.db.prepare('INSERT INTO recent_opens (user_id, ref, opened_at) VALUES (?, ?, ?)').run(userId, ref, when.toISOString());
    this.db.prepare(`DELETE FROM recent_opens WHERE user_id = ? AND ref NOT IN (SELECT ref FROM recent_opens WHERE user_id = ? ${NEWEST} LIMIT ?)`).run(userId, userId, APP_RECENTS);
  }

  forget(userId: string, ref: string): void {
    this.db.prepare('DELETE FROM recent_opens WHERE user_id = ? AND ref = ?').run(userId, ref);
  }

  /**
   * The desktop app's last answer from Spotlight, which can take seconds: shown at once the next time, in any
   * folder's window, while it is asked again.
   */
  systemCached(): Recents | null {
    const row = this.db.prepare("SELECT value FROM recents_cache WHERE key = 'system'").get() as { value: string } | undefined;
    try {
      return row ? (JSON.parse(row.value) as Recents) : null;
    } catch {
      return null;
    }
  }

  cacheSystem(recents: Recents): void {
    this.db.prepare("INSERT INTO recents_cache (key, value) VALUES ('system', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(recents));
  }

  list(userId: string): { ref: string; openedAt: string }[] {
    return (this.db.prepare(`SELECT ref, opened_at FROM recent_opens WHERE user_id = ? ${NEWEST}`).all(userId) as { ref: string; opened_at: string }[]).map((r) => ({ ref: r.ref, openedAt: r.opened_at }));
  }
}
