// One person's Docs from one organization's Docs object to another's (POST /v1/admin/accounts/move, routes/admin.ts):
// the rows they own, as read from the source object (`Docs.ownedRows`, `Docs.grantsOn`), rewritten for the target. Pure,
// so the rules are unit-tested (move.test.ts); the route reads, copies the bodies in R2, writes and prunes.
//
// The rules: every row lands in the target organization (`workspace_id`), and in the person's My files there: what was
// shared with the source organization becomes private (its members are not the target's), and every folder moves to the
// root `me:<user>:<target>`, with any folder a moved file sits in made there when the person did not own it. Grants that
// name the source organization's people, channels or the organization itself are dropped and reported; link grants
// (anyone with the link) are kept. Favorites, recent opens and the old public links come along when they name a moved
// file or folder. Previews (they expire) and the assistant's rows left in Docs (the rollback copies) are not moved.

export type Row = Record<string, unknown>;

/** The tables read whole for the person (`Docs.ownedRows`); grants are read by object (`Docs.grantsOn`). */
export const OWNED_TABLES = ['users', 'folders', 'sheets', 'stored_files', 'images', 'public_links', 'favorites', 'recent_opens'] as const;
export type OwnedTable = (typeof OWNED_TABLES)[number];
/** The tables written to the target, in an order the foreign keys accept (users first). */
export const MOVED_TABLES = ['users', 'folders', 'sheets', 'stored_files', 'images', 'grants', 'public_links', 'favorites', 'recent_opens'] as const;
export type MovedTable = (typeof MOVED_TABLES)[number];

export type MoveSource = Record<OwnedTable | 'grants', Row[]>;

export interface MoveOptions {
  userId: string;
  from: string;
  to: string;
  /** The person's account in each organization: a kept grant made by the one is made by the other. */
  fromAccountId?: string | null;
  toAccountId?: string | null;
  /** created_at of a folder made in the target for a file whose folder the person did not own. */
  now?: string;
}

/** A grant that does not follow its object (it names the source organization, its people or its channels). */
export interface DroppedGrant { kind: string; id: string; principal: string; role: string }

/** A link grant kept, for the target organization's share index. */
export interface KeptLink { kind: string; id: string; principal: string; role: string; title: string; fileKind: string }

/** A body to copy, relative to the objects' prefix; `optional` ones (a sheet's base, a file's previous version) may not exist. */
export interface Body { path: string; optional: boolean; of: string }

export interface MovePlan {
  /** The rows to write to the target, per table. */
  rows: Record<MovedTable, Row[]>;
  bodies: Body[];
  dropped: DroppedGrant[];
  links: KeptLink[];
  /** Rows that were shared with the source organization and are private in the target. */
  madePrivate: number;
  /** Folders made in the target for moved files whose folder (or a folder above it) the person did not own. */
  foldersMade: number;
  /** Each moved object, by its key in the source (`sheet:<id>`, `file:<id>`, `image:<id>`, `folder:<root>/<path>`) and in the target. */
  objects: { key: string; target: string }[];
  /** What the prune removes from the source once its object is in the target (`dependsOn`, a source key). */
  source: {
    favorites: { ref: string; dependsOn: string }[];
    recent_opens: { ref: string; dependsOn: string }[];
    public_links: { token: string; dependsOn: string }[];
    grants: { kind: string; id: string; principal: string; dependsOn: string }[];
  };
}

/** What the prune deletes in the source, for the objects found in the target (`pruneSelection`). */
export interface PruneSelection {
  sheets: string[];
  stored_files: string[];
  images: string[];
  folders: { scope: string; path: string }[];
  favorites: string[];
  recent_opens: string[];
  public_links: string[];
  /** Every grant on a pruned object: out of the source organization's share index too. */
  grants: { kind: string; id: string; principal: string }[];
  bodies: string[];
  /** File ids and link tokens the directory should now place in the target organization. */
  indexIds: string[];
}

const str = (v: unknown): string => (v == null ? '' : String(v));

/** A folder path and the folders above it: 'a/b' → ['a/b', 'a']. */
export function withParents(path: string): string[] {
  const parts = path.split('/').filter(Boolean);
  return parts.map((_, i) => parts.slice(0, i + 1).join('/')).reverse();
}

/** A folder's name as an object (server/access.ts' folderObjectId). */
const folderKey = (root: string, path: string) => `folder:${root}/${path}`;

/** The grant principals that do not follow an object out of its organization. */
export const staysBehind = (principal: string): boolean => !principal.startsWith('link:');

/** The move's rewrite: see the top of this file. */
export function planDocsMove(source: MoveSource, o: MoveOptions): MovePlan {
  const { userId, from, to } = o;
  const root = `me:${userId}:${to}`;
  const mine = (r: Row) => str(r.owner_id) === userId;
  const rows: Record<MovedTable, Row[]> = { users: [], folders: [], sheets: [], stored_files: [], images: [], grants: [], public_links: [], favorites: [], recent_opens: [] };
  const plan: MovePlan = { rows, bodies: [], dropped: [], links: [], madePrivate: 0, foldersMade: 0, objects: [], source: { favorites: [], recent_opens: [], public_links: [], grants: [] } };
  /** Source key → target key, and what the share index calls it. */
  const moved = new Map<string, { target: string; title: string; fileKind: string }>();
  const by = (v: unknown) => (o.fromAccountId && str(v) === o.fromAccountId && o.toAccountId ? o.toAccountId : v);

  rows.users = source.users.filter((u) => str(u.id) === userId).slice(0, 1);

  // Folders: each to the same path in the person's root in the target; two of the person's roots may both have one.
  const paths = new Set<string>();
  for (const f of source.folders.filter(mine)) {
    const path = str(f.path);
    moved.set(folderKey(str(f.scope), path), { target: folderKey(root, path), title: path.split('/').pop() || 'Folder', fileKind: 'folder' });
    plan.objects.push({ key: folderKey(str(f.scope), path), target: folderKey(root, path) });
    if (Number(f.private) === 0) plan.madePrivate++;
    if (paths.has(path)) continue;
    paths.add(path);
    rows.folders.push({ ...f, workspace_id: to, private: 1, scope: root });
  }

  for (const s of source.sheets.filter(mine)) {
    const id = str(s.id);
    moved.set(`sheet:${id}`, { target: `sheet:${id}`, title: str(s.title), fileKind: str(s.kind) || 'sheet' });
    plan.objects.push({ key: `sheet:${id}`, target: `sheet:${id}` });
    if (Number(s.private) === 0) plan.madePrivate++;
    rows.sheets.push({ ...s, workspace_id: to, private: 1 });
    plan.bodies.push({ path: `data/sheets/${str(s.file)}`, optional: false, of: `sheet:${id}` }, { path: `data/sheets/${id}.base.json`, optional: true, of: `sheet:${id}` });
  }
  for (const f of source.stored_files.filter(mine)) {
    const id = str(f.id);
    moved.set(`file:${id}`, { target: `file:${id}`, title: str(f.filename), fileKind: 'file' });
    plan.objects.push({ key: `file:${id}`, target: `file:${id}` });
    if (Number(f.private) === 0) plan.madePrivate++;
    rows.stored_files.push({ ...f, workspace_id: to, private: 1 });
    plan.bodies.push({ path: `data/files/${id}`, optional: false, of: `file:${id}` }, { path: `data/files/${id}.prev`, optional: true, of: `file:${id}` });
  }
  for (const i of source.images.filter(mine)) {
    const id = str(i.id);
    plan.objects.push({ key: `image:${id}`, target: `image:${id}` });
    rows.images.push({ ...i, workspace_id: to });
    plan.bodies.push({ path: `data/images/${id}`, optional: false, of: `image:${id}` });
  }

  // A moved file in a folder the person did not own (an organization folder someone else made) would be in no folder
  // in the target: the folder is made there, in the person's root, as folders.create makes missing parents.
  const needed = new Set<string>();
  for (const r of [...rows.sheets, ...rows.stored_files]) for (const p of withParents(str(r.folder))) needed.add(p);
  for (const f of rows.folders) for (const p of withParents(str(f.path))) needed.add(p);
  for (const path of [...needed].sort()) {
    if (paths.has(path)) continue;
    paths.add(path);
    rows.folders.push({ owner_id: userId, workspace_id: to, private: 1, scope: root, path, created_at: o.now ?? new Date().toISOString() });
    plan.foldersMade++;
  }

  // Grants on moved objects: links kept (on the object's id in the target), the rest dropped.
  const grantKeys = new Set<string>();
  for (const g of source.grants) {
    const kind = str(g.object_kind), id = str(g.object_id), principal = str(g.principal);
    const m = moved.get(`${kind}:${id}`);
    if (!m) continue;
    plan.source.grants.push({ kind, id, principal, dependsOn: `${kind}:${id}` });
    if (staysBehind(principal)) {
      plan.dropped.push({ kind, id, principal, role: str(g.role) });
      continue;
    }
    const targetId = m.target.slice(kind.length + 1);
    if (grantKeys.has(`${kind}:${targetId}:${principal}`)) continue;
    grantKeys.add(`${kind}:${targetId}:${principal}`);
    rows.grants.push({ ...g, object_id: targetId, granted_by: by(g.granted_by) });
    plan.links.push({ kind, id: targetId, principal, role: str(g.role), title: m.title, fileKind: m.fileKind });
  }

  // The old public links (unread since grants, kept for one release): with their file.
  for (const l of source.public_links.filter(mine)) {
    const dependsOn = `${str(l.kind) === 'file' ? 'file' : 'sheet'}:${str(l.file_id)}`;
    if (!moved.has(dependsOn)) continue;
    rows.public_links.push({ ...l, workspace_id: to });
    plan.source.public_links.push({ token: str(l.token), dependsOn });
  }

  // Favorites and recent opens name a file by kind and id, a folder by its path (`folder:<path>` in My files,
  // `folder:@<organization>/<path>` in Organization files); in the target every moved folder is in My files.
  const refOf = (ref: string): { dependsOn: string; ref: string } | null => {
    if (ref.startsWith('folder:')) {
      const at = ref.slice('folder:'.length);
      const shared = /^@([^/]+)\/(.+)$/.exec(at);
      const candidates = shared ? (shared[1] === from ? [folderKey(`org:${from}`, shared[2]!)] : []) : [folderKey(`me:${userId}:${from}`, at), folderKey(`me:${userId}:`, at)];
      const dependsOn = candidates.find((k) => moved.has(k));
      return dependsOn ? { dependsOn, ref: `folder:${shared ? shared[2] : at}` } : null;
    }
    const i = ref.indexOf(':');
    if (i < 0) return null;
    const dependsOn = `${ref.slice(0, i) === 'file' ? 'file' : 'sheet'}:${ref.slice(i + 1)}`;
    return moved.has(dependsOn) ? { dependsOn, ref } : null;
  };
  for (const table of ['favorites', 'recent_opens'] as const) {
    const seen = new Set<string>();
    for (const r of source[table].filter((x) => str(x.user_id) === userId)) {
      const m = refOf(str(r.ref));
      if (!m) continue;
      plan.source[table].push({ ref: str(r.ref), dependsOn: m.dependsOn });
      if (seen.has(m.ref)) continue;
      seen.add(m.ref);
      rows[table].push({ ...r, ref: m.ref });
    }
  }
  return plan;
}

/** A target key (`sheet:<id>`, `folder:<root>/<path>`, ...) as its table and the id or (scope, path) it is found by. */
export function parseKey(key: string): { table: 'sheets' | 'stored_files' | 'images'; id: string } | { table: 'folders'; scope: string; path: string } | null {
  const i = key.indexOf(':');
  const kind = key.slice(0, i), rest = key.slice(i + 1);
  if (kind === 'sheet') return { table: 'sheets', id: rest };
  if (kind === 'file') return { table: 'stored_files', id: rest };
  if (kind === 'image') return { table: 'images', id: rest };
  if (kind === 'folder') {
    // A root key is `org:<id>` or `me:<user>:<org>`: ids have no '/', so the first '/' ends it.
    const j = rest.indexOf('/');
    return j > 0 ? { table: 'folders', scope: rest.slice(0, j), path: rest.slice(j + 1) } : null;
  }
  return null;
}

/** What the prune removes from the source: the moved objects found in the target (`present`, target keys), and what hangs off them. */
export function pruneSelection(plan: MovePlan, present: Iterable<string>): PruneSelection {
  const there = new Set(present);
  const verified = new Set(plan.objects.filter((o) => there.has(o.target)).map((o) => o.key));
  const sel: PruneSelection = { sheets: [], stored_files: [], images: [], folders: [], favorites: [], recent_opens: [], public_links: [], grants: [], bodies: [], indexIds: [] };
  for (const key of verified) {
    const k = parseKey(key);
    if (!k) continue;
    if (k.table === 'folders') sel.folders.push({ scope: k.scope, path: k.path });
    else {
      sel[k.table].push(k.id);
      sel.indexIds.push(k.id);
    }
  }
  sel.bodies = plan.bodies.filter((b) => verified.has(b.of)).map((b) => b.path);
  sel.favorites = plan.source.favorites.filter((f) => verified.has(f.dependsOn)).map((f) => f.ref);
  sel.recent_opens = plan.source.recent_opens.filter((f) => verified.has(f.dependsOn)).map((f) => f.ref);
  sel.public_links = plan.source.public_links.filter((l) => verified.has(l.dependsOn)).map((l) => l.token);
  sel.grants = plan.source.grants.filter((g) => verified.has(g.dependsOn)).map(({ kind, id, principal }) => ({ kind, id, principal }));
  for (const g of sel.grants) if (g.principal.startsWith('link:')) sel.indexIds.push(g.principal.slice('link:'.length));
  return sel;
}
