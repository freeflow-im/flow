// The one-time move of everything into the Cloudflare objects (docs/specs/cloudflare-migration.md, the cut-over). Run on the
// instance, inside the suite's container, where Postgres, the Docs data and the shared secret all are:
//
//   docker exec -e EDGE_URL=https://edge.freeflow.im flow node --experimental-strip-types scripts/export-to-edge.ts          (a dry run)
//   docker exec -e EDGE_URL=https://edge.freeflow.im flow node --experimental-strip-types scripts/export-to-edge.ts --apply
//
// It can be run again: every insert keeps rows already there. It writes nothing to Postgres or the Docs files.
//
// What goes where:
// - the directory: users, sessions, OAuth identities, agent tokens (identity, found before the organization is known);
// - each organization's Chat object: every table that reaches `workspaces` through its foreign keys, filtered to that
//   organization, plus the users those rows name. The object's triggers then report ids and memberships to the directory;
// - each organization's Docs object: its rows of the Docs database (packages/docs/server/db.ts), and their file bodies to R2.
//   Rows from before organizations (no workspace_id) go to their owner's first organization, as ruled on 2026-11-02.
// Chat's own blobs (attachments, avatars) are already in the same R2 bucket under the same keys, so they do not move.
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';

const apply = process.argv.includes('--apply');
const EDGE = (process.env.EDGE_URL ?? '').replace(/\/+$/, '');
const SECRET = process.env.EDGE_ORIGIN_SECRET ?? '';
const DOCS_DIR = process.env.WORKSPACE_DATA_DIR ?? '/data/workspace';
if (!EDGE || !SECRET) throw new Error('EDGE_URL and EDGE_ORIGIN_SECRET are needed');
const sql = postgres(process.env.DATABASE_URL ?? '', { max: 2, onnotice: () => {} });

/** Postgres's values as SQLite holds them (packages/edge/src/org/db/schema.ts): ms timestamps, 0/1, JSON text, { $b64 } bytes. */
function toSqlite(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (Buffer.isBuffer(v)) return { $b64: v.toString('base64') };
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}
const convert = (rows: Record<string, unknown>[]) => rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, toSqlite(v)])));

let sent = 0;
async function send(where: string, table: string, rows: Record<string, unknown>[]): Promise<void> {
  if (!rows.length) return;
  for (let i = 0; i < rows.length; i += 200) {
    const batch = rows.slice(i, i + 200);
    sent += batch.length;
    if (!apply) continue;
    const res = await fetch(`${EDGE}/edge/admin/${where}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-edge-secret': SECRET }, body: JSON.stringify({ table, rows: batch }) });
    if (!res.ok) throw new Error(`${where} ${table}: ${res.status} ${await res.text()}`);
  }
}

// ---- how each Chat table reaches an organization, from Postgres's own foreign keys -------------------------------------

const IDENTITY = new Set(['users', 'sessions', 'pending_signups', 'email_tokens', 'oauth_identities', 'app_link_codes', 'auth_handoffs', 'agent_tokens']);
// Pushes are not sent from Cloudflare yet; their devices are registered again when the native apps move.
const NOT_MOVED = new Set(['rate_limit_windows', 'pending_push', 'device_tokens', '__drizzle_migrations', 'schema_migrations']);
type Fk = { table: string; column: string; ref: string; refColumn: string };
const fks = (await sql`
  SELECT tc.table_name AS table, kcu.column_name AS column, ccu.table_name AS ref, ccu.column_name AS "refColumn"
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
  JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
  WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'`) as unknown as Fk[];
const tables = (await sql`SELECT table_name AS t FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`).map((r) => r.t as string);

/** A SQL condition putting a table's rows in organization $1, by the shortest chain of foreign keys to `workspaces`. */
function scopeOf(table: string, seen = new Set<string>()): string | null {
  if (table === 'workspaces') return 'id = $1';
  if (seen.has(table)) return null;
  const direct = fks.find((f) => f.table === table && f.ref === 'workspaces');
  if (direct) return `${direct.column} = $1`;
  for (const f of fks.filter((f) => f.table === table && f.ref !== 'users' && f.ref !== table)) {
    const parent = scopeOf(f.ref, new Set([...seen, table]));
    if (parent) return `${f.column} IN (SELECT ${f.refColumn} FROM ${f.ref} WHERE ${parent})`;
  }
  return null;
}

/** Parents before children, so each object's foreign keys hold as rows arrive. */
function ordered(names: string[]): string[] {
  const out: string[] = [];
  const visit = (t: string, path: Set<string>) => {
    if (out.includes(t) || path.has(t) || !names.includes(t)) return;
    for (const f of fks.filter((f) => f.table === t && f.ref !== t)) visit(f.ref, new Set([...path, t]));
    out.push(t);
  };
  for (const t of names) visit(t, new Set());
  return out;
}

const scoped = new Map<string, string>();
const global: string[] = [];
for (const t of tables) {
  if (IDENTITY.has(t) || NOT_MOVED.has(t)) continue;
  const s = scopeOf(t);
  if (s) scoped.set(t, s);
  else global.push(t);
}
console.log(`Chat: ${scoped.size} tables by organization, ${global.length} copied to every organization (${global.join(', ') || 'none'})`);

// ---- the directory -----------------------------------------------------------------------------------------------------

// Messages are encrypted under a key id; the Worker reads only the one it is given (FLOW_DATA_KEY_ID, default env-1).
const keys = await sql`SELECT enc_key_id AS id, count(*)::int AS n FROM messages GROUP BY 1 ORDER BY 2 DESC`;
console.log(`message keys: ${keys.map((k) => `${k.id} (${k.n})`).join(', ') || 'none'}`);
if (keys.length > 1) console.log('WARNING: more than one key id: messages under the others will not decrypt on the Worker');

const users = await sql`SELECT * FROM users ORDER BY id`;
await send('directory', 'users', convert(users).map((u) => ({ ...u, notification_prefs: u.notification_prefs ?? '{}' })));
for (const t of ['sessions', 'oauth_identities', 'agent_tokens']) {
  const rows = convert(await sql.unsafe(`SELECT * FROM ${t}`));
  // The directory keeps token hashes as hex (packages/edge/src/directory/core.ts hashToken).
  await send('directory', t, rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v && typeof v === 'object' && '$b64' in v ? Buffer.from((v as { $b64: string }).$b64, 'base64').toString('hex') : v]))));
}
const workspaces = await sql`SELECT id, slug FROM workspaces`;
await send('directory', 'organization_slugs', workspaces.map((w) => ({ slug: w.slug, organization_id: w.id })));
console.log(`directory: ${users.length} users`);

// ---- each organization's Chat object --------------------------------------------------------------------------------

const userColumns = fks.filter((f) => f.ref === 'users');
const idColumn = new Set((await sql`SELECT table_name AS t FROM information_schema.columns WHERE table_schema = 'public' AND column_name = 'id'`).map((r) => r.t as string));
for (const w of workspaces) {
  const id = w.id as string;
  const names = ordered([...scoped.keys(), ...global]);
  // The users its rows name, first, so the object's joins and foreign keys find them.
  const named = new Set<string>();
  for (const f of userColumns.filter((f) => scoped.has(f.table))) {
    for (const r of await sql.unsafe(`SELECT DISTINCT ${f.column} AS u FROM ${f.table} WHERE ${f.column} IS NOT NULL AND ${scoped.get(f.table)}`, [id])) named.add(r.u as string);
  }
  // And the users those users name (an agent's sponsor), until nothing new turns up.
  for (let grew = true; grew; ) {
    grew = false;
    for (const u of users) if (named.has(u.id as string) && u.sponsor_user_id && !named.has(u.sponsor_user_id as string)) { named.add(u.sponsor_user_id as string); grew = true; }
  }
  const theirUsers = users.filter((u) => named.has(u.id as string)).sort((a, b) => String(a.id).localeCompare(String(b.id)));
  await send(`org/${id}`, 'users', convert(theirUsers));
  let rows = 0;
  for (const t of names) {
    const where = scoped.get(t);
    // Ids are UUIDv7, ordered by time, so a reply comes after its root and a nested channel after its parent.
    const order = idColumn.has(t) ? ' ORDER BY id' : '';
    const got = where ? await sql.unsafe(`SELECT * FROM ${t} WHERE ${where}${order}`, [id]) : await sql.unsafe(`SELECT * FROM ${t}${order}`);
    rows += got.length;
    await send(`org/${id}`, t, convert(got));
  }
  if (apply) {
    const res = await fetch(`${EDGE}/edge/admin/org/${id}/done`, { method: 'POST', headers: { 'x-edge-secret': SECRET } });
    if (!res.ok) throw new Error(`org ${id} done: ${res.status} ${await res.text()}`);
  }
  console.log(`organization ${w.slug}: ${theirUsers.length} users, ${rows} rows`);
}

// ---- each organization's Docs object ---------------------------------------------------------------------------------

const appDb = path.join(DOCS_DIR, 'app.db');
if (existsSync(appDb)) {
  const docs = new DatabaseSync(appDb, { readOnly: true });
  const all = (q: string, ...a: unknown[]) => docs.prepare(q).all(...(a as never[])) as Record<string, unknown>[];
  const columns = (t: string) => new Set(all(`PRAGMA table_info(${t})`).map((c) => c.name as string));
  const firstOrg = new Map<string, string>();
  for (const m of await sql`SELECT user_id, workspace_id FROM workspace_members ORDER BY joined_at`) if (!firstOrg.has(m.user_id as string)) firstOrg.set(m.user_id as string, m.workspace_id as string);
  // The tables of packages/docs/server/db.ts that hold an organization's things, owners before what they own.
  const owned = ['folders', 'sheets', 'stored_files', 'images', 'public_links', 'agent_conversations', 'agent_messages', 'favorites']
    .filter((t) => all(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, t).length);
  const orgOf = (row: Record<string, unknown>) => (row.workspace_id as string | null) ?? firstOrg.get((row.owner_id ?? row.user_id) as string) ?? null;
  const files = (dir: string) => (existsSync(path.join(DOCS_DIR, dir)) ? readdirSync(path.join(DOCS_DIR, dir)) : []);
  const bodies = { sheets: files('sheets'), files: files('files'), images: files('images') };
  for (const w of workspaces) {
    const id = w.id as string;
    const rowsOf = new Map<string, Record<string, unknown>[]>();
    for (const t of owned) {
      const cols = columns(t);
      if (cols.has('workspace_id') || cols.has('owner_id') || cols.has('user_id')) rowsOf.set(t, all(`SELECT * FROM ${t}`).filter((r) => orgOf(r) === id).map((r) => (cols.has('workspace_id') ? { ...r, workspace_id: id } : r)));
    }
    // Conversation messages belong to their conversation.
    const conversations = new Set((rowsOf.get('agent_conversations') ?? []).map((r) => r.id));
    if (rowsOf.has('agent_messages')) rowsOf.set('agent_messages', all('SELECT * FROM agent_messages').filter((r) => conversations.has(r.conversation_id)));
    const owners = new Set([...rowsOf.values()].flat().map((r) => (r.owner_id ?? r.user_id) as string).filter(Boolean));
    if (!owners.size) continue;
    await send(`docs/${id}`, 'users', all('SELECT * FROM users').filter((u) => owners.has(u.id as string)));
    let n = 0;
    for (const [t, rows] of rowsOf) { n += rows.length; await send(`docs/${id}`, t, rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, toSqlite(v)])))); }
    // The bodies: a spreadsheet's file and its base, a stored file and its earlier version, a picture.
    const ids = [...(rowsOf.get('sheets') ?? []), ...(rowsOf.get('stored_files') ?? []), ...(rowsOf.get('images') ?? [])].flatMap((r) => [r.id as string, r.file as string].filter(Boolean));
    let uploaded = 0;
    for (const [dir, names] of Object.entries(bodies)) {
      for (const name of names.filter((f) => ids.some((x) => f === x || f.startsWith(`${x}.`)))) {
        uploaded++;
        if (!apply) continue;
        const res = await fetch(`${EDGE}/edge/admin/docs/${id}/file/${dir}/${encodeURIComponent(name)}`, { method: 'PUT', headers: { 'x-edge-secret': SECRET }, body: readFileSync(path.join(DOCS_DIR, dir, name)) });
        if (!res.ok) throw new Error(`docs file ${dir}/${name}: ${res.status} ${await res.text()}`);
      }
    }
    console.log(`docs of ${w.slug}: ${n} rows, ${uploaded} files`);
  }
}

console.log(`${apply ? 'sent' : 'would send'} ${sent} rows`);
await sql.end();
