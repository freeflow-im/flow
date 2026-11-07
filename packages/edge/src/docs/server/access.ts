// @ts-nocheck: copied from packages/docs, where it is typechecked under that package's settings (cloudflare-spikes.md).
// Who may do what with a file or folder (docs/specs/platform.md §4.3–§4.4, phase 3.2): the `grants` table of
// `@flow/shared/grants`, over Docs' three kinds of object: `sheet` (a row of `sheets`: spreadsheets, presentations,
// documents, Markdown), `file` (a row of `stored_files`) and `folder` (a row of `folders`, named by its root and
// path: `folderObjectId`). A file's container chain is the file, then each folder of its path up to its root's top.
//
// The owner column is a user id and grants name accounts (`account:<id>`), so the owner is matched on the user id
// here and the grants on the reader's account. A reader other than the owner needs to be a member of the row's
// organization: one Docs database serves every organization on the Node host. Without a host (the desktop app,
// the plugin) rows have no organization and no grants, so every row is its owner's only, as before.
//
// Organization files are the rows with an `org` grant: each row in an organization's root has one (written when
// the row is made there or moved there, removed when it leaves), and `private` is kept as the flag derived from it
// for the code that lists by it (server/scope.ts' scopeWhere) and for the standalone paths.
import { atLeast, effectiveRole, grantFromRow, grantSql, grantsForChainSql, ORG_PRINCIPAL, revokeSql, type ChainLink, type Grant, type GrantRow, type Role } from '@flow/shared/grants';
import type { DB } from './db.ts';
import { viewerOf, type Owned, type ViewerArg } from './scope.ts';

export type { Role };
export { atLeast };

/** Docs' kinds of object a grant may name. */
export type ObjectKind = 'sheet' | 'file' | 'folder';
export const OBJECT_KINDS: readonly ObjectKind[] = ['sheet', 'file', 'folder'];
export const isObjectKind = (k: unknown): k is ObjectKind => typeof k === 'string' && (OBJECT_KINDS as readonly string[]).includes(k);

/** The key of the root a row is in (the `folders.scope` of its folders, server/scope.ts' scopeKey). */
export const rootKeyOf = (row: Owned): string => (row.private || !row.workspace_id ? `me:${row.owner_id}:${row.workspace_id ?? ''}` : `org:${row.workspace_id}`);

/** A folder as an object: its root's key and its path ('' is the root's top). Folders have no id of their own. */
export const folderObjectId = (rootKey: string, path: string): string => `${rootKey}/${path}`;
export function parseFolderObjectId(id: string): { rootKey: string; path: string } | null {
  const i = id.indexOf('/');
  return i > 0 ? { rootKey: id.slice(0, i), path: id.slice(i + 1) } : null;
}

/** A folder path and the folders above it, deepest first, down to the root's top: 'a/b' → ['a/b', 'a', '']. */
const upward = (path: string): string[] => {
  const parts = path.split('/').filter(Boolean);
  return [...parts.map((_, i) => parts.slice(0, parts.length - i).join('/')), ''];
};

/** A row any kind of object can be read as. */
export interface ObjectRow extends Owned {
  /** A document's or stored file's id; absent for a folder. */
  id?: string;
  /** A document's or file's folder; a folder's own path. */
  folder?: string;
  path?: string;
  /** A folder's root key. */
  scope?: string;
}

/** The object, then its folders up to the root's top. */
export function chainOf(kind: ObjectKind, row: ObjectRow): { objectKind: string; objectId: string }[] {
  if (kind === 'folder') {
    const root = row.scope ?? rootKeyOf(row);
    return upward(row.path ?? '').map((p) => ({ objectKind: 'folder', objectId: folderObjectId(root, p) }));
  }
  const root = rootKeyOf(row);
  return [{ objectKind: kind, objectId: row.id! }, ...upward(row.folder ?? '').map((p) => ({ objectKind: 'folder', objectId: folderObjectId(root, p) }))];
}

/** The chain's grants, loaded in one query and grouped per object. */
function loadChain(db: DB, chain: { objectKind: string; objectId: string }[]): ChainLink[] {
  const st = grantsForChainSql(chain);
  const rows = db.prepare(st.sql).all(...st.params) as unknown as GrantRow[];
  return chain.map((c) => ({ ...c, grants: rows.filter((r) => r.object_kind === c.objectKind && r.object_id === c.objectId).map(grantFromRow) }));
}

/** The viewer's role on a row, or null for none (see the top of this file). */
export function roleOf(db: DB, viewer: ViewerArg, kind: ObjectKind, row: ObjectRow): Role | null {
  const v = viewerOf(viewer);
  if (row.owner_id === v.userId) return 'owner';
  if (!row.workspace_id || !v.workspaces.has(row.workspace_id)) return null;
  return effectiveRole({ reader: readerOf(v), ownerAccountId: null, chain: loadChain(db, chainOf(kind, row)) });
}

/** Who a viewer is to the grants (`@flow/shared/grants`' GrantReader). */
export const readerOf = (viewer: ViewerArg) => {
  const v = viewerOf(viewer);
  return { accountId: v.accountId ?? v.userId, channelIds: [...(v.channelIds ?? [])] };
};

/** An object's row by kind and id (a folder's id is its `folderObjectId`), or undefined. */
export function objectRow(db: DB, kind: ObjectKind, id: string): ObjectRow | undefined {
  if (kind === 'folder') {
    const f = parseFolderObjectId(id);
    return f ? (db.prepare('SELECT owner_id, workspace_id, private, scope, path FROM folders WHERE scope = ? AND path = ?').get(f.rootKey, f.path) as ObjectRow | undefined) : undefined;
  }
  return db.prepare(`SELECT id, owner_id, workspace_id, private, folder FROM ${kind === 'sheet' ? 'sheets' : 'stored_files'} WHERE id = ?`).get(id) as ObjectRow | undefined;
}

/** The viewer's role on an object, or null for none (and for no such object). */
export function access(db: DB, viewer: ViewerArg, kind: ObjectKind, id: string): Role | null {
  const row = objectRow(db, kind, id);
  return row ? roleOf(db, viewer, kind, row) : null;
}

/** Whether the viewer's role on the row allows what `need` allows. */
export const can = (db: DB, viewer: ViewerArg, kind: ObjectKind, row: ObjectRow, need: Role): boolean => atLeast(roleOf(db, viewer, kind, row), need);

const REFUSED: Record<Role, string> = {
  viewer: 'You cannot open this file.',
  editor: 'You can view this file but not change it.',
  manager: 'Only those who manage this file can change who it is shared with.',
  owner: 'Only the owner of this file can do that.',
};

/** An error the routes answer with its status (Fastify's, and the Worker's DocsApp). */
export const refused = (need: Role): Error & { statusCode: number } => Object.assign(new Error(REFUSED[need]), { statusCode: 403 });

/**
 * The stores' check: null when the viewer has no role on the row (it is as if it did not exist: a 404), the role when
 * it allows what `need` allows; a role too low for it is a 403 (thrown).
 */
export function allowed(db: DB, viewer: ViewerArg, kind: ObjectKind, row: ObjectRow, need: Role): Role | null {
  const role = roleOf(db, viewer, kind, row);
  if (!role) return null;
  if (!atLeast(role, need)) throw refused(need);
  return role;
}

/** What a file's metadata says of the reader's role: nothing for its owner. */
export const roleMeta = (role: Role | null | undefined): { role?: Exclude<Role, 'owner'> } => (role && role !== 'owner' ? { role } : {});

// ---- the grants of one object ------------------------------------------------------------

/** The grants on the object itself (not those it inherits). */
export function grantsOn(db: DB, kind: ObjectKind, id: string): Grant[] {
  const st = grantsForChainSql([{ objectKind: kind, objectId: id }]);
  return (db.prepare(st.sql).all(...st.params) as unknown as GrantRow[]).map(grantFromRow).sort((a, b) => a.grantedAt.localeCompare(b.grantedAt));
}

export function grant(db: DB, kind: ObjectKind, id: string, principal: Grant['principal'], role: Role, by: string, expiresAt?: string): void {
  const st = grantSql({ objectKind: kind, objectId: id, principal, role, grantedBy: by, grantedAt: new Date().toISOString(), ...(expiresAt ? { expiresAt } : {}) });
  db.prepare(st.sql).run(...st.params);
}

export function revoke(db: DB, kind: ObjectKind, id: string, principal: string): void {
  const st = revokeSql(kind, id, principal);
  db.prepare(st.sql).run(...st.params);
}

/**
 * Keep a row's `org` grant in step with the root it is (now) in: an organization's root gives it one (editor, unless
 * it has one already), a private root none. Called wherever a row is made in a root or moved to another.
 */
export function syncOrgGrant(db: DB, kind: ObjectKind, id: string, row: Pick<Owned, 'workspace_id' | 'private'>, by: string): void {
  if (!row.private && row.workspace_id) {
    db.prepare("INSERT OR IGNORE INTO grants (object_kind, object_id, principal, role, granted_by, granted_at, expires_at) VALUES (?, ?, 'org', 'editor', ?, ?, NULL)").run(kind, id, by, Date.now());
  } else revoke(db, kind, id, ORG_PRINCIPAL);
}

/** A folder's object id changed (it moved to another root): its grants go with it. */
export function renameFolderObject(db: DB, from: string, to: string): void {
  db.prepare("UPDATE OR REPLACE grants SET object_id = ? WHERE object_kind = 'folder' AND object_id = ?").run(to, from);
}

/** The grants that name people and channels of the organization: they do not follow an object to another one. */
export function revokeMembers(db: DB, kind: ObjectKind, id: string): void {
  db.prepare("DELETE FROM grants WHERE object_kind = ? AND object_id = ? AND (principal LIKE 'account:%' OR principal LIKE 'channel:%')").run(kind, id);
}

// ---- links ------------------------------------------------------------------------------

/** The token of the object's live link grant, if it has one. */
export function linkTokenOf(db: DB, kind: ObjectKind, id: string): string | null {
  const row = db.prepare("SELECT principal FROM grants WHERE object_kind = ? AND object_id = ? AND principal LIKE 'link:%' AND (expires_at IS NULL OR expires_at > ?) ORDER BY granted_at LIMIT 1").get(kind, id, Date.now()) as { principal: string } | undefined;
  return row ? row.principal.slice('link:'.length) : null;
}

/** What a link's token opens: its object, while the grant is there and not expired. */
export function resolveLink(db: DB, token: string): { kind: ObjectKind; id: string; grantedBy: string } | null {
  const row = db.prepare('SELECT object_kind, object_id, granted_by FROM grants WHERE principal = ? AND (expires_at IS NULL OR expires_at > ?)').get(`link:${token}`, Date.now()) as { object_kind: string; object_id: string; granted_by: string } | undefined;
  return row && isObjectKind(row.object_kind) ? { kind: row.object_kind, id: row.object_id, grantedBy: row.granted_by } : null;
}

// ---- the migration from `private` and public links -----------------------------------------

/** Whether a row is shared with its organization: an `org` grant on it or on a folder above it (what `private` says). */
export function orgShared(db: DB, kind: ObjectKind, row: ObjectRow): boolean {
  if (!row.workspace_id) return false;
  return loadChain(db, chainOf(kind, row)).some((l) => l.grants.some((g) => g.principal === ORG_PRINCIPAL));
}

/**
 * The one-time move to grants (server/db.ts runs it once): every shared row (`private = 0`) of an organization gets
 * an `org` editor grant, private rows none; every public link becomes a `link:<token>` viewer grant on its file;
 * then `private` is written again as derived from the grants (a shared row of no organization becomes private).
 */
export function migrateToGrants(db: DB): void {
  const now = Date.now();
  const add = db.prepare('INSERT OR IGNORE INTO grants (object_kind, object_id, principal, role, granted_by, granted_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, NULL)');
  for (const [table, kind] of [['sheets', 'sheet'], ['stored_files', 'file']] as const) {
    for (const r of db.prepare(`SELECT id, owner_id FROM ${table} WHERE private = 0 AND workspace_id IS NOT NULL`).all() as { id: string; owner_id: string }[]) add.run(kind, r.id, ORG_PRINCIPAL, 'editor', r.owner_id, now);
  }
  for (const f of db.prepare('SELECT owner_id, scope, path FROM folders WHERE private = 0 AND workspace_id IS NOT NULL').all() as { owner_id: string; scope: string; path: string }[]) {
    add.run('folder', folderObjectId(f.scope, f.path), ORG_PRINCIPAL, 'editor', f.owner_id, now);
  }
  for (const l of db.prepare('SELECT token, owner_id, kind, file_id, created_at FROM public_links').all() as { token: string; owner_id: string; kind: string; file_id: string; created_at: string }[]) {
    add.run(l.kind === 'deck' ? 'sheet' : 'file', l.file_id, `link:${l.token}`, 'viewer', l.owner_id, Date.parse(l.created_at) || now);
  }
  recomputePrivate(db);
}

/** Write `private` again on every row as derived from the grants (orgShared). */
export function recomputePrivate(db: DB): void {
  for (const [table, kind] of [['sheets', 'sheet'], ['stored_files', 'file']] as const) {
    const set = db.prepare(`UPDATE ${table} SET private = ? WHERE id = ?`);
    for (const r of db.prepare(`SELECT id, owner_id, workspace_id, private, folder FROM ${table}`).all() as unknown as (ObjectRow & { id: string })[]) {
      const derived = orgShared(db, kind, r) ? 0 : 1;
      if (derived !== r.private) set.run(derived, r.id);
    }
  }
  const set = db.prepare('UPDATE folders SET private = ? WHERE scope = ? AND path = ?');
  for (const f of db.prepare('SELECT owner_id, workspace_id, private, scope, path FROM folders').all() as unknown as (ObjectRow & { scope: string; path: string })[]) {
    const derived = orgShared(db, 'folder', f) ? 0 : 1;
    if (derived !== f.private) set.run(derived, f.scope, f.path);
  }
}
