// Cell images uploaded or pasted by users. The bytes are stored as files next to the sheets, so a cell only
// holds a short "/api/images/<id>" reference: large images don't bloat autosaves, undo history or the
// workbook JSON. Images are only readable by the user who uploaded them.
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { CELL_IMAGE_TYPES } from '../shared/types.ts';
import type { Backup } from './backup.ts';
import type { DB } from './db.ts';

export class ImageStore {
  private db: DB;
  private dir: string;
  /** The off-box copy (backup.ts): every upload is reported to it when set. */
  backup: Backup | null = null;

  constructor(db: DB, dir: string) {
    this.db = db;
    this.dir = dir;
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  /** Store an image; returns its URL. */
  async create(ownerId: string, type: string, data: Buffer): Promise<string> {
    return this.put(ownerId, type, data, randomUUID());
  }

  /**
   * Store an image unless the user has it already: the same bytes always get the same address. For pictures
   * read from a file each time it is opened (the desktop app's PowerPoint and Word files), which would
   * otherwise be stored again on every open.
   */
  async createOnce(ownerId: string, type: string, data: Buffer): Promise<string> {
    const h = createHash('sha256').update(ownerId).update('\0').update(type).update('\0').update(data).digest('hex');
    const id = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
    if (this.get(ownerId, id)) return `/api/images/${id}`;
    return this.put(ownerId, type, data, id);
  }

  private async put(ownerId: string, type: string, data: Buffer, id: string): Promise<string> {
    if (!CELL_IMAGE_TYPES.includes(type)) throw new Error(`Unsupported image type ${type}`);
    const target = path.join(this.dir, id);
    const tmp = `${target}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, target);
    this.db
      // Two opens of one file at once may store the same picture: the second finds it there.
      .prepare('INSERT OR IGNORE INTO images (id, owner_id, type, size, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, ownerId, type, data.length, new Date().toISOString());
    this.backup?.putImage(ownerId, id, type, data);
    return `/api/images/${id}`;
  }

  /** The file and content type of one of the user's images, or null. */
  get(ownerId: string, id: string): { file: string; type: string } | null {
    const r = this.db.prepare('SELECT type FROM images WHERE id = ? AND owner_id = ?').get(id, ownerId) as { type: string } | undefined;
    return r ? { file: path.join(this.dir, id), type: r.type } : null;
  }
}
