// Cell images uploaded or pasted by users. The bytes are stored as files next to the sheets, so a cell only
// holds a short "/api/images/<id>" reference: large images don't bloat autosaves, undo history or the
// workbook JSON. Images are readable by the user who uploaded them and, in the FreeFlow suite, by the members of
// the organization they were uploaded in (or whose files they were moved into with a file: `retag`).
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rename, writeFile } from '#runtime/fsp';
import path from 'node:path';
import { CELL_IMAGE_TYPES } from '../shared/types.ts';
import type { Backup } from './backup.ts';
import type { DB } from './db.ts';
import { scopeOf, viewerOf, type ScopeArg, type ViewerArg } from './scope.ts';

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
  async create(scope: ScopeArg, type: string, data: Buffer): Promise<string> {
    return this.put(scope, type, data, randomUUID());
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

  private async put(scope: ScopeArg, type: string, data: Buffer, id: string): Promise<string> {
    const { ownerId, workspaceId } = scopeOf(scope);
    if (!CELL_IMAGE_TYPES.includes(type)) throw new Error(`Unsupported image type ${type}`);
    const target = path.join(this.dir, id);
    const tmp = `${target}.tmp`;
    await writeFile(tmp, data);
    await rename(tmp, target);
    this.db
      // Two opens of one file at once may store the same picture: the second finds it there.
      .prepare('INSERT OR IGNORE INTO images (id, owner_id, workspace_id, type, size, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, ownerId, workspaceId, type, data.length, new Date().toISOString());
    this.backup?.putImage(ownerId, id, type, data);
    return `/api/images/${id}`;
  }

  /** The file and content type of an image the viewer may see (theirs, or their organization's), or null. */
  get(who: ViewerArg, id: string): { file: string; type: string } | null {
    const v = viewerOf(who);
    const r = this.db.prepare('SELECT type, owner_id, workspace_id FROM images WHERE id = ?').get(id) as { type: string; owner_id: string; workspace_id: string | null } | undefined;
    const seen = r && (r.owner_id === v.userId || (r.workspace_id !== null && v.workspaces.has(r.workspace_id)));
    return seen ? { file: path.join(this.dir, id), type: r.type } : null;
  }

  /**
   * The pictures a file shows, moved with it into an organization (or out of one): those of `ids` the viewer may
   * see become that organization's, so its members see them in the file. A picture belongs to one organization.
   */
  retag(who: ViewerArg, ids: Iterable<string>, workspaceId: string | null): void {
    const set = this.db.prepare('UPDATE images SET workspace_id = ? WHERE id = ?');
    for (const id of ids) if (this.get(who, id)) set.run(workspaceId, id);
  }
}
