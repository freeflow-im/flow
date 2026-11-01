// Each user's saved signatures, for signing PDFs (shared/pdfSign.ts): pictures kept so they can be put on any
// document again (a full signature, initials, a company stamp). In the desktop app they are the app's, in its
// settings database, not the open folder's.
import { randomBytes } from 'node:crypto';
import type { DB } from './db.ts';

/** The largest signature picture kept, as a data: address. */
export const MAX_SIGNATURE_CHARS = 2_000_000;
/** How many signatures one user keeps. */
export const MAX_SIGNATURES = 12;

export interface SavedSignature {
  id: string;
  /** A PNG picture as a data: address. */
  image: string;
  createdAt: string;
}

export class SignatureStore {
  private db: DB;

  constructor(db: DB) {
    this.db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS user_signatures (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        image TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS user_signatures_user ON user_signatures(user_id, created_at);
    `);
    // The first version kept one signature per user.
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'signatures'").get()) {
      for (const row of db.prepare('SELECT user_id, image, updated_at FROM signatures').all() as { user_id: string; image: string; updated_at: string }[]) {
        db.prepare('INSERT INTO user_signatures (id, user_id, image, created_at) VALUES (?, ?, ?, ?)').run(newId(), row.user_id, row.image, row.updated_at);
      }
      db.exec('DROP TABLE signatures');
    }
  }

  /** The user's signatures, the oldest first. */
  list(userId: string): SavedSignature[] {
    const rows = this.db.prepare('SELECT id, image, created_at FROM user_signatures WHERE user_id = ? ORDER BY created_at, rowid').all(userId) as { id: string; image: string; created_at: string }[];
    return rows.map((r) => ({ id: r.id, image: r.image, createdAt: r.created_at }));
  }

  /** Keep another signature; null when the user already has as many as are kept. */
  add(userId: string, image: string): SavedSignature | null {
    const { n } = this.db.prepare('SELECT COUNT(*) AS n FROM user_signatures WHERE user_id = ?').get(userId) as { n: number };
    if (n >= MAX_SIGNATURES) return null;
    const saved = { id: newId(), image, createdAt: new Date().toISOString() };
    this.db.prepare('INSERT INTO user_signatures (id, user_id, image, created_at) VALUES (?, ?, ?, ?)').run(saved.id, userId, image, saved.createdAt);
    return saved;
  }

  delete(userId: string, id: string): boolean {
    return this.db.prepare('DELETE FROM user_signatures WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
  }
}

function newId(): string {
  return randomBytes(9).toString('base64url');
}

/** Whether a value is a PNG picture as a data: address, small enough to keep. */
export function isSignatureImage(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_SIGNATURE_CHARS && /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(value) && value.startsWith('data:image/png;base64,iVBORw0KGgo');
}
