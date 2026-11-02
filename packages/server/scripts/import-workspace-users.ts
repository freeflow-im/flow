// The Workspace app's accounts (MCP Docs, packages/docs: SQLite `users`) become accounts of this server
// (FreeFlow suite phase 2, docs/specs/freeflow-suite.md §2.4). Run once, with the Workspace app's data
// directory and this server's DATABASE_URL, before the suite serves the Workspace app:
//
//   pnpm --filter @flow/server exec tsx scripts/import-workspace-users.ts /data/workspace [--apply]
//
// Without --apply it only reports what it would do. For each Workspace user:
// - no account here with that email: one is created with the same id (so the Workspace database's owner
//   columns keep pointing at it), the email verified, the display name from the email, and the password hash
//   as it is (scrypt; services/auth.ts verifies it and replaces it with argon2 at the next sign-in; a
//   Google-only account has none and signs in with Google here too);
// - an account here already has that email (the same person had both): the Workspace rows are re-owned by
//   that account's id and the Workspace user row is replaced by a mirror of this server's.
// The Workspace sessions, password resets and verification links are not carried over: everyone signs in to
// the suite afresh.
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import postgres from 'postgres';

const [dir, ...flags] = process.argv.slice(2);
if (!dir) {
  console.error('usage: import-workspace-users.ts <workspace data dir> [--apply]');
  process.exit(2);
}
const apply = flags.includes('--apply');
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is not set');
  process.exit(2);
}

interface WorkspaceUser { id: string; email: string; password_hash: string; created_at: string; email_verified_at: string | null; google_sub: string | null }

// Every Workspace table that names a user (packages/docs/server/db.ts).
const OWNER_COLUMNS: Array<[table: string, column: string]> = [
  ['sheets', 'owner_id'], ['images', 'owner_id'], ['stored_files', 'owner_id'], ['public_links', 'owner_id'], ['folders', 'owner_id'],
  ['agent_conversations', 'user_id'], ['agent_jobs', 'user_id'], ['connections', 'user_id'], ['agent_usage', 'user_id'], ['assistant_settings', 'user_id'],
  ['sessions', 'user_id'], ['password_resets', 'user_id'], ['email_verifications', 'user_id'],
];

const sqlite = new DatabaseSync(path.join(dir, 'app.db'));
const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
try {
  const columns = new Set(sqlite.prepare('PRAGMA table_info(users)').all().map((c) => (c as { name: string }).name));
  const tables = new Set(sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => (t as { name: string }).name));
  const owners = OWNER_COLUMNS.filter(([t]) => tables.has(t));
  const select = `SELECT id, email, password_hash, created_at, ${columns.has('email_verified_at') ? 'email_verified_at' : 'created_at AS email_verified_at'}, ${columns.has('google_sub') ? 'google_sub' : 'NULL AS google_sub'} FROM users WHERE id <> 'local' ORDER BY created_at`;
  const workspaceUsers = sqlite.prepare(select).all() as unknown as WorkspaceUser[];
  let created = 0;
  let merged = 0;
  let kept = 0;
  for (const u of workspaceUsers) {
    const email = u.email.trim().toLowerCase();
    const [existing] = await sql<Array<{ id: string }>>`SELECT id FROM users WHERE email = ${email} LIMIT 1`;
    if (existing && existing.id === u.id) {
      kept++;
      continue;
    }
    if (existing) {
      merged++;
      console.log(`${apply ? 'merging' : 'would merge'} ${email}: Workspace ${u.id} -> suite ${existing.id}`);
      if (!apply) continue;
      sqlite.exec('BEGIN');
      try {
        // The row the mirror would make, under the suite's id, then every owner column, then the old row.
        sqlite.prepare("INSERT OR IGNORE INTO users (id, email, password_hash, created_at) VALUES (?, ?, '', ?)").run(existing.id, `${existing.id}@merging.invalid`, u.created_at);
        for (const [table, column] of owners) sqlite.prepare(`UPDATE OR IGNORE ${table} SET ${column} = ? WHERE ${column} = ?`).run(existing.id, u.id);
        sqlite.prepare('DELETE FROM users WHERE id = ?').run(u.id);
        sqlite.prepare('UPDATE users SET email = ? WHERE id = ?').run(u.email, existing.id);
        sqlite.exec('COMMIT');
      } catch (e) {
        sqlite.exec('ROLLBACK');
        throw e;
      }
      continue;
    }
    created++;
    const displayName = email.split('@')[0] ?? email;
    console.log(`${apply ? 'creating' : 'would create'} ${email} (${u.id})${u.password_hash ? '' : ', Google sign-in only'}`);
    if (!apply) continue;
    await sql`INSERT INTO users (id, email, password_hash, display_name, email_verified_at, created_at)
      VALUES (${u.id}, ${email}, ${u.password_hash}, ${displayName}, ${u.email_verified_at ?? u.created_at}, ${u.created_at})`;
  }
  console.log(`${workspaceUsers.length} Workspace users: ${created} ${apply ? 'created' : 'to create'}, ${merged} ${apply ? 'merged' : 'to merge'}, ${kept} already here${apply ? '' : ' (dry run; add --apply)'}`);
} finally {
  await sql.end();
  sqlite.close();
}
