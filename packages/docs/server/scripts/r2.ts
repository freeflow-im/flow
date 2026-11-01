// Maintenance of the off-box copy in Cloudflare R2 (server/backup.ts), run by hand:
//
//   npm run r2 -- reconcile            upload every file, base and image the store lacks
//   npm run r2 -- snapshot             upload a copy of app.db and plugin.db as backups/<today>/
//   npm run r2 -- maintenance          snapshot + reconcile + prune old snapshots + purge deleted files
//   npm run r2 -- restore <dir> [--include-deleted]
//                                      rebuild an empty data directory from the store
//   npm run r2 -- list [prefix]        list objects
//
// Reads DATA_DIR and the R2_* variables from the environment (.env is loaded).
import '../env.ts';
import path from 'node:path';
import { Backup, restore } from '../backup.ts';
import { r2FromEnv, S3ObjectStore } from '../blob.ts';
import { openDb } from '../db.ts';

const root = path.resolve(import.meta.dirname, '..', '..');
const dataDir = path.resolve(process.env.DATA_DIR ?? path.join(root, 'data'));
const [command, ...args] = process.argv.slice(2);
const log = { info: (m: string) => console.log(m), error: (m: string) => console.error(m) };

const cfg = r2FromEnv();
if (!cfg) {
  console.error('R2 is not configured: set R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY and CLOUDFLARE_ACCOUNT_ID.');
  process.exit(2);
}
const store = new S3ObjectStore(cfg);

const withBackup = async (fn: (b: Backup) => Promise<unknown>) => {
  const db = openDb(path.join(dataDir, 'app.db'));
  try {
    const r = await fn(new Backup(store, { dataDir, db, log }));
    if (r !== undefined) console.log(typeof r === 'string' ? r : JSON.stringify(r));
  } finally {
    db.close();
  }
};

switch (command) {
  case 'reconcile':
    await withBackup((b) => b.reconcile());
    break;
  case 'snapshot':
    await withBackup(async (b) => [await b.snapshotDb(path.join(dataDir, 'app.db')), await b.snapshotDb(path.join(dataDir, 'plugin.db'))]);
    break;
  case 'maintenance':
    await withBackup((b) => b.maintenance());
    break;
  case 'restore': {
    const dir = args.find((a) => !a.startsWith('--'));
    if (!dir) {
      console.error('restore needs a target directory (must be empty)');
      process.exit(2);
    }
    const result = await restore(store, path.resolve(dir), { includeDeleted: args.includes('--include-deleted'), log });
    console.log(JSON.stringify(result));
    break;
  }
  case 'list': {
    for (const o of await store.list(args[0] ?? '')) console.log(`${o.lastModified}  ${String(o.size).padStart(10)}  ${o.key}`);
    break;
  }
  default:
    console.error('usage: npm run r2 -- reconcile | snapshot | maintenance | restore <dir> [--include-deleted] | list [prefix]');
    process.exit(2);
}
