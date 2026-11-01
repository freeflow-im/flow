// The off-box copy of every file: each save also puts the file to an object store (Cloudflare R2, blob.ts),
// keyed by owner, kind, id and revision, so the store holds a history and a stale save never overwrites a
// newer object. Images go up on upload, branch bases beside their branch, and a deleted file gets a marker
// instead of being removed (purged 30 days later). Puts are queued and retried so a save never fails because
// the store is down; a daily maintenance pass snapshots the SQLite databases, re-uploads anything missing,
// prunes old snapshots and purges files deleted long enough ago. `restore` rebuilds a data directory from
// the store (see scripts/r2.ts).
import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DeletedFile, DocKind } from '../shared/types.ts';
import type { ObjectStore } from './blob.ts';
import type { DB } from './db.ts';

export interface BackupLog {
  info(msg: string): void;
  error(msg: string): void;
}

export interface BackupOptions {
  /** The app's data directory (sheets/, images/, app.db, plugin.db). */
  dataDir: string;
  db: DB;
  log?: BackupLog;
  /** Waits between retries of a failed put, in ms. */
  retryDelays?: number[];
  /** Days to keep database snapshots and deleted files. */
  keepDays?: number;
}

export const DEFAULT_RETRY_DELAYS = [1_000, 5_000, 30_000, 120_000, 600_000];
const DAY_MS = 24 * 60 * 60 * 1000;
const FILE_KINDS: DocKind[] = ['sheet', 'deck', 'doc', 'markdown'];

/** Keys in the store. Revisions are ISO timestamps, which sort chronologically as strings. */
export const keys = {
  file: (ownerId: string, kind: DocKind, id: string, rev: string) => `users/${ownerId}/${kind}/${id}/${rev}.json`,
  filePrefix: (ownerId: string, kind: DocKind, id: string) => `users/${ownerId}/${kind}/${id}/`,
  base: (ownerId: string, id: string) => `users/${ownerId}/sheet/${id}/base.json`,
  deleted: (ownerId: string, kind: DocKind, id: string) => `users/${ownerId}/${kind}/${id}/deleted.json`,
  image: (ownerId: string, id: string) => `users/${ownerId}/images/${id}`,
  dbSnapshot: (date: string, name: string) => `backups/${date}/${name}`,
};

/** Splits a users/ key into its parts, or null for anything else. */
export function parseKey(key: string): { ownerId: string; kind: DocKind | 'images'; id: string; rest: string } | null {
  const m = /^users\/([^/]+)\/(sheet|deck|doc|images)\/([^/]+)(?:\/(.*))?$/.exec(key);
  if (!m) return null;
  return { ownerId: m[1], kind: m[2] as DocKind | 'images', id: m[3], rest: m[4] ?? '' };
}

const today = () => new Date().toISOString().slice(0, 10);

interface Job {
  label: string;
  run: () => Promise<void>;
  attempts: number;
}

export class Backup {
  readonly store: ObjectStore;
  private dataDir: string;
  private db: DB;
  private log: BackupLog;
  private retryDelays: number[];
  private keepDays: number;
  private queue: Job[] = [];
  private running = false;
  private idle: Promise<void> = Promise.resolve();
  private signalIdle: () => void = () => {};
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  /** Puts that failed after every retry (they are left for the next reconcile). */
  failed = 0;

  constructor(store: ObjectStore, opts: BackupOptions) {
    this.store = store;
    this.dataDir = opts.dataDir;
    this.db = opts.db;
    this.log = opts.log ?? { info: () => {}, error: (m) => console.error(m) };
    this.retryDelays = opts.retryDelays ?? DEFAULT_RETRY_DELAYS;
    this.keepDays = opts.keepDays ?? 30;
  }

  // --- Write-through ---------------------------------------------------------------

  putFile(ownerId: string, kind: DocKind, id: string, rev: string, json: string): void {
    this.enqueue(`file ${kind}/${id}@${rev}`, () => this.store.put(keys.file(ownerId, kind, id, rev), json, 'application/json'));
  }

  putBase(ownerId: string, id: string, json: string): void {
    this.enqueue(`base ${id}`, () => this.store.put(keys.base(ownerId, id), json, 'application/json'));
  }

  putImage(ownerId: string, id: string, type: string, bytes: Buffer): void {
    this.enqueue(`image ${id}`, () => this.store.put(keys.image(ownerId, id), bytes, type));
  }

  markDeleted(ownerId: string, kind: DocKind, id: string, title: string): void {
    const body = JSON.stringify({ deletedAt: new Date().toISOString(), title, kind });
    this.enqueue(`delete ${kind}/${id}`, () => this.store.put(keys.deleted(ownerId, kind, id), body, 'application/json'));
  }

  // --- Trash: deleted files still in the store ---------------------------------------

  /** The owner's deleted files that have not been purged yet, newest deletion first. */
  async listDeleted(ownerId: string): Promise<DeletedFile[]> {
    const out: DeletedFile[] = [];
    for (const o of await this.store.list(`users/${ownerId}/`)) {
      const p = parseKey(o.key);
      if (!p || p.kind === 'images' || p.rest !== 'deleted.json') continue;
      const body = await this.store.get(o.key);
      if (!body) continue;
      const m = JSON.parse(body.toString('utf8')) as { deletedAt?: string; title?: string };
      out.push({ id: p.id, kind: p.kind, title: m.title ?? 'Untitled', deletedAt: m.deletedAt ?? o.lastModified });
    }
    return out.sort((a, b) => (a.deletedAt < b.deletedAt ? 1 : a.deletedAt > b.deletedAt ? -1 : 0));
  }

  /** The newest revision of a file in the store, or null. */
  async latestRevision(ownerId: string, kind: DocKind, id: string): Promise<string | null> {
    const revs = (await this.store.list(keys.filePrefix(ownerId, kind, id)))
      .map((o) => parseKey(o.key)?.rest ?? '')
      .filter((rest) => rest.endsWith('.json') && rest !== 'base.json' && rest !== 'deleted.json')
      .sort();
    const rev = revs.at(-1);
    if (!rev) return null;
    const body = await this.store.get(keys.file(ownerId, kind, id, rev.slice(0, -5)));
    return body ? body.toString('utf8') : null;
  }

  /** Removes the deletion marker (after the file is back in the database). */
  async undelete(ownerId: string, kind: DocKind, id: string): Promise<void> {
    await this.store.delete(keys.deleted(ownerId, kind, id));
  }

  /** Queued puts not yet done. */
  get pending(): number {
    return this.queue.length + (this.running ? 1 : 0);
  }

  /** Resolves when the queue is empty, or after `timeoutMs`. */
  async drain(timeoutMs = 10_000): Promise<boolean> {
    if (this.pending === 0) return true;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    const done = this.idle.then(() => true as const);
    const result = await Promise.race([done, timeout]);
    clearTimeout(timer);
    return result;
  }

  private enqueue(label: string, run: () => Promise<void>): void {
    if (this.pending === 0) this.idle = new Promise((resolve) => (this.signalIdle = resolve));
    this.queue.push({ label, run, attempts: 0 });
    void this.work();
  }

  private async work(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.queue.length) {
        const job = this.queue[0];
        try {
          await job.run();
          this.queue.shift();
        } catch (e) {
          job.attempts++;
          const delay = this.retryDelays[job.attempts - 1];
          if (delay === undefined) {
            this.queue.shift();
            this.failed++;
            this.log.error(`backup: giving up on ${job.label}: ${(e as Error).message}`);
          } else {
            this.log.error(`backup: ${job.label} failed (${(e as Error).message}), retrying in ${delay} ms`);
            await new Promise((r) => setTimeout(r, delay));
          }
        }
      }
    } finally {
      this.running = false;
      this.signalIdle();
    }
  }

  // --- Maintenance -----------------------------------------------------------------

  /** A consistent copy of a SQLite database file, uploaded as backups/<date>/<name>. */
  async snapshotDb(file: string, date = today()): Promise<string | null> {
    const name = path.basename(file);
    try {
      await stat(file);
    } catch {
      return null;
    }
    const tmp = path.join(this.dataDir, `${name}.${process.pid}.${Date.now()}.snapshot`);
    const key = keys.dbSnapshot(date, name);
    const src = path.resolve(file) === path.resolve(this.dataDir, 'app.db') ? this.db : new DatabaseSync(file, { readOnly: true });
    try {
      src.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
      await this.store.put(key, await readFile(tmp), 'application/vnd.sqlite3');
    } finally {
      if (src !== this.db) src.close();
      await rm(tmp, { force: true });
    }
    return key;
  }

  /** Uploads every file, base and image on disk that the store lacks. */
  async reconcile(): Promise<{ files: number; bases: number; images: number }> {
    const have = new Set((await this.store.list('users/')).map((o) => o.key));
    const result = { files: 0, bases: 0, images: 0 };
    const rows = this.db.prepare('SELECT id, owner_id, kind, file, updated_at, parent_id FROM sheets').all() as {
      id: string;
      owner_id: string;
      kind: DocKind;
      file: string;
      updated_at: string;
      parent_id: string | null;
    }[];
    for (const r of rows) {
      if (!have.has(keys.file(r.owner_id, r.kind, r.id, r.updated_at))) {
        const json = await readFile(path.join(this.dataDir, 'sheets', r.file), 'utf8').catch(() => null);
        if (json !== null) {
          await this.store.put(keys.file(r.owner_id, r.kind, r.id, r.updated_at), json, 'application/json');
          result.files++;
        }
      }
      if (r.parent_id && !have.has(keys.base(r.owner_id, r.id))) {
        const json = await readFile(path.join(this.dataDir, 'sheets', `${r.id}.base.json`), 'utf8').catch(() => null);
        if (json !== null) {
          await this.store.put(keys.base(r.owner_id, r.id), json, 'application/json');
          result.bases++;
        }
      }
    }
    const images = this.db.prepare('SELECT id, owner_id, type FROM images').all() as { id: string; owner_id: string; type: string }[];
    for (const img of images) {
      if (have.has(keys.image(img.owner_id, img.id))) continue;
      const bytes = await readFile(path.join(this.dataDir, 'images', img.id)).catch(() => null);
      if (bytes) {
        await this.store.put(keys.image(img.owner_id, img.id), bytes, img.type);
        result.images++;
      }
    }
    return result;
  }

  /** Deletes database snapshots older than keepDays. */
  async pruneSnapshots(now = Date.now()): Promise<number> {
    let n = 0;
    for (const o of await this.store.list('backups/')) {
      const date = o.key.split('/')[1];
      if (date && now - Date.parse(date) > this.keepDays * DAY_MS) {
        await this.store.delete(o.key);
        n++;
      }
    }
    return n;
  }

  /** Removes every object of files deleted more than keepDays ago. */
  async purgeDeleted(now = Date.now()): Promise<number> {
    const all = await this.store.list('users/');
    let n = 0;
    for (const o of all) {
      const p = parseKey(o.key);
      if (!p || p.kind === 'images' || p.rest !== 'deleted.json') continue;
      const body = await this.store.get(o.key);
      const deletedAt = body ? ((JSON.parse(body.toString('utf8')) as { deletedAt?: string }).deletedAt ?? '') : '';
      if (!deletedAt || now - Date.parse(deletedAt) <= this.keepDays * DAY_MS) continue;
      const prefix = keys.filePrefix(p.ownerId, p.kind, p.id);
      for (const victim of all.filter((x) => x.key.startsWith(prefix))) await this.store.delete(victim.key);
      n++;
    }
    return n;
  }

  /** The daily pass: snapshots, reconcile, prune, purge. Never throws. */
  async maintenance(): Promise<void> {
    const step = async (name: string, fn: () => Promise<unknown>) => {
      try {
        const r = await fn();
        this.log.info(`backup: ${name} ${typeof r === 'object' && r ? JSON.stringify(r) : r === null ? 'skipped' : String(r)}`);
      } catch (e) {
        this.log.error(`backup: ${name} failed: ${(e as Error).message}`);
      }
    };
    await step('snapshot app.db', () => this.snapshotDb(path.join(this.dataDir, 'app.db')));
    await step('snapshot plugin.db', () => this.snapshotDb(path.join(this.dataDir, 'plugin.db')));
    await step('reconcile', () => this.reconcile());
    await step('prune snapshots', () => this.pruneSnapshots());
    await step('purge deleted', () => this.purgeDeleted());
  }

  /** Runs maintenance shortly after start and then once a day. */
  startDaily(initialDelayMs = 60_000, periodMs = DAY_MS): void {
    const schedule = (ms: number) => {
      if (this.stopped) return;
      this.timer = setTimeout(async () => {
        await this.maintenance();
        schedule(periodMs);
      }, ms);
      this.timer.unref();
    };
    schedule(initialDelayMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}

export interface RestoreResult {
  databases: string[];
  files: number;
  bases: number;
  images: number;
  skippedDeleted: number;
}

/**
 * Rebuilds a data directory from the store: the newest database snapshots, the newest revision of every
 * file (deleted ones left out unless asked for), branch bases and images. The directory must be empty.
 */
export async function restore(store: ObjectStore, dataDir: string, opts: { includeDeleted?: boolean; log?: BackupLog } = {}): Promise<RestoreResult> {
  const log = opts.log ?? { info: () => {}, error: (m) => console.error(m) };
  await mkdir(dataDir, { recursive: true });
  if ((await readdir(dataDir)).length) throw new Error(`${dataDir} is not empty`);
  await mkdir(path.join(dataDir, 'sheets'), { recursive: true });
  await mkdir(path.join(dataDir, 'images'), { recursive: true });
  const result: RestoreResult = { databases: [], files: 0, bases: 0, images: 0, skippedDeleted: 0 };

  const snapshots = await store.list('backups/');
  const newestDate = snapshots.map((o) => o.key.split('/')[1]).sort().at(-1);
  for (const o of snapshots.filter((o) => o.key.split('/')[1] === newestDate)) {
    const name = path.basename(o.key);
    const bytes = await store.get(o.key);
    if (!bytes) continue;
    await writeAtomic(path.join(dataDir, name), bytes);
    result.databases.push(name);
    log.info(`restored ${name} from ${o.key}`);
  }

  const groups = new Map<string, { ownerId: string; kind: DocKind; id: string; revs: string[]; base: boolean; deleted: boolean }>();
  for (const o of await store.list('users/')) {
    const p = parseKey(o.key);
    if (!p) continue;
    if (p.kind === 'images') {
      const bytes = await store.get(o.key);
      if (bytes) {
        await writeAtomic(path.join(dataDir, 'images', p.id), bytes);
        result.images++;
      }
      continue;
    }
    const gk = `${p.ownerId}/${p.kind}/${p.id}`;
    const g = groups.get(gk) ?? { ownerId: p.ownerId, kind: p.kind, id: p.id, revs: [], base: false, deleted: false };
    if (p.rest === 'base.json') g.base = true;
    else if (p.rest === 'deleted.json') g.deleted = true;
    else if (p.rest.endsWith('.json')) g.revs.push(p.rest.slice(0, -5));
    groups.set(gk, g);
  }
  for (const g of groups.values()) {
    if (g.deleted && !opts.includeDeleted) {
      result.skippedDeleted++;
      continue;
    }
    const rev = g.revs.sort().at(-1);
    if (rev) {
      const bytes = await store.get(keys.file(g.ownerId, g.kind, g.id, rev));
      if (bytes) {
        await writeAtomic(path.join(dataDir, 'sheets', `${g.id}.json`), bytes);
        result.files++;
      }
    }
    if (g.base) {
      const bytes = await store.get(keys.base(g.ownerId, g.id));
      if (bytes) {
        await writeAtomic(path.join(dataDir, 'sheets', `${g.id}.base.json`), bytes);
        result.bases++;
      }
    }
  }
  return result;
}

async function writeAtomic(target: string, bytes: Buffer): Promise<void> {
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, bytes);
  await rename(tmp, target);
}

export { FILE_KINDS };
