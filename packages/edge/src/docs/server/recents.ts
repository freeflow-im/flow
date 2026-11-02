// @ts-nocheck: copied from packages/docs, where it is typechecked under that package's settings (cloudflare-spikes.md).
export const openedFiles = (..._a: any[]): any[] => [];
export const recentFiles = async (..._a: any[]): Promise<any[]> => [];
// The files a user last opened in the app: the web lists them too, so this one is the real class, and only the desktop
// app's parts (Spotlight, paths on disk) are stand-ins.
export const APP_RECENTS = 20;
const NEWEST = 'ORDER BY opened_at DESC, rowid DESC';
export class RecentOpens {
  private db: any;
  constructor(db: any) {
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
    this.forget(userId, ref);
    this.db.prepare('INSERT INTO recent_opens (user_id, ref, opened_at) VALUES (?, ?, ?)').run(userId, ref, when.toISOString());
    this.db.prepare(`DELETE FROM recent_opens WHERE user_id = ? AND ref NOT IN (SELECT ref FROM recent_opens WHERE user_id = ? ${NEWEST} LIMIT ?)`).run(userId, userId, APP_RECENTS);
  }
  forget(userId: string, ref: string): void {
    this.db.prepare('DELETE FROM recent_opens WHERE user_id = ? AND ref = ?').run(userId, ref);
  }
  systemCached(): any { return null; }
  cacheSystem(_recents: unknown): void {}
  list(userId: string): { ref: string; openedAt: string }[] {
    return this.db.prepare(`SELECT ref, opened_at FROM recent_opens WHERE user_id = ? ${NEWEST}`).all(userId).map((r: any) => ({ ref: r.ref, openedAt: r.opened_at }));
  }
}
export const recentsAvailable = (): boolean => false;
export const whereOf = (..._a: any[]): any => null;
export type Recents = any;
