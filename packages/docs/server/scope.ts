// Whose files a request sees (docs/specs/freeflow-suite.md §2.4, ruled 2026-11-02; who may open which is
// server/access.ts, on grants since platform phase 3.2). In the FreeFlow suite every
// Docs row carries the organization it belongs to (`workspace_id`, Flow's name for it) and whether it is private:
// Organization files are an organization's shared rows (`private = 0`), any member's to list, open and edit; My
// files are one user's private rows in that organization, plus their rows from before organizations
// (`workspace_id IS NULL`), which show in My files of whichever organization is selected. Without a host
// (standalone, the desktop app) there are no organizations: every row is private with no organization, and a
// plain user id stands for that user's files, as before.

/** A root of the library: an organization's shared files, or one user's private files (in an organization). */
export interface Scope {
  /** The user: who creates in it, and whose private files it lists. */
  ownerId: string;
  /** The organization (Flow's workspace id); null for the user's private files outside any (no host, the ChatGPT plugin). */
  workspaceId: string | null;
  /** My files (true) or Organization files (false, which needs workspaceId). */
  private: boolean;
}

/** A scope, or a user id for that user's private files in every organization (and none): the standalone app, the desktop app, the plugin. */
export type ScopeArg = Scope | string;

export const scopeOf = (s: ScopeArg): Scope => (typeof s === 'string' ? { ownerId: s, workspaceId: null, private: true } : s);

/** The columns every row that belongs to someone has (sheets, stored_files, folders). */
export interface Owned {
  owner_id: string;
  workspace_id: string | null;
  private: number;
}

/** A name for a scope, unique per root: a folder's path is unique within it (`folders.scope`). */
export function scopeKey(arg: ScopeArg): string {
  const s = scopeOf(arg);
  return s.private ? `me:${s.ownerId}:${s.workspaceId ?? ''}` : `org:${s.workspaceId}`;
}

/**
 * The rows of a scope, as a WHERE fragment over `owner_id`, `workspace_id` and `private` (with `alias.` when given)
 * and its parameters. Organization files: the organization's shared rows. My files in an organization: the user's
 * private rows there and their rows from before organizations. A plain user id: all of the user's private rows.
 */
export function scopeWhere(arg: ScopeArg, alias = ''): { sql: string; params: string[] } {
  const s = scopeOf(arg);
  const a = alias ? `${alias}.` : '';
  if (!s.private) {
    if (!s.workspaceId) throw new Error('Organization files need an organization');
    return { sql: `${a}workspace_id = ? AND ${a}private = 0`, params: [s.workspaceId] };
  }
  if (s.workspaceId) return { sql: `${a}owner_id = ? AND ${a}private = 1 AND (${a}workspace_id = ? OR ${a}workspace_id IS NULL)`, params: [s.ownerId, s.workspaceId] };
  return { sql: `${a}owner_id = ? AND ${a}private = 1`, params: [s.ownerId] };
}

/** The values a row made in a scope is written with. */
export const scopeColumns = (arg: ScopeArg): { owner_id: string; workspace_id: string | null; private: number } => {
  const s = scopeOf(arg);
  return { owner_id: s.ownerId, workspace_id: s.workspaceId, private: s.private ? 1 : 0 };
};

/**
 * Who asks for a row by its id: the user and the organizations they are a member of (the host's `organizationsOf`,
 * cached a minute). A plain user id is a user in no organization.
 */
export interface Viewer {
  userId: string;
  workspaces: ReadonlySet<string>;
  /** The user's account in the organization the request went to, and the channels they are in there (the host's
   * caller context, platform.md §3.6): what grants are matched against (server/access.ts). */
  accountId?: string;
  channelIds?: readonly string[];
}
export type ViewerArg = Viewer | string;

export const viewerOf = (v: ViewerArg): Viewer => (typeof v === 'string' ? { userId: v, workspaces: new Set() } : v);
export const viewerId = (v: ViewerArg): string => (typeof v === 'string' ? v : v.userId);

/** The scope a row is in, as the viewer who can access it sees it: where files made beside it go. Beside another's
 * private file shared with the viewer (server/access.ts) is the viewer's own files in that organization. */
export function scopeOfRow(row: Owned, viewer: ViewerArg): Scope {
  if (!row.private && row.workspace_id) return { ownerId: viewerId(viewer), workspaceId: row.workspace_id, private: false };
  if (row.owner_id !== viewerId(viewer)) return { ownerId: viewerId(viewer), workspaceId: row.workspace_id, private: true };
  return { ownerId: row.owner_id, workspaceId: row.workspace_id, private: true };
}

/** What the client is told of a row's scope (SheetMeta, StoredFile): its organization, and whether it is shared there. */
export const scopeMeta = (row: Partial<Owned>): { workspaceId?: string; shared?: true } => ({
  ...(row.workspace_id ? { workspaceId: row.workspace_id } : {}),
  ...(row.private === 0 ? { shared: true as const } : {}),
});

/** Whether a row is in a scope's root: what a move within a root (to a folder of it) checks. */
export function inScope(row: Owned, arg: ScopeArg): boolean {
  const s = scopeOf(arg);
  if (!s.private) return !row.private && row.workspace_id === s.workspaceId;
  return !!row.private && row.owner_id === s.ownerId && (!s.workspaceId || row.workspace_id === s.workspaceId || row.workspace_id === null);
}

/** The scope of a file the viewer opened, from what the client is told of it (see scopeMeta): where files made beside it go. */
export function scopeOfMeta(meta: { workspaceId?: string; shared?: true }, viewer: ViewerArg): ScopeArg {
  if (!meta.workspaceId) return viewerId(viewer);
  return { ownerId: viewerId(viewer), workspaceId: meta.workspaceId, private: !meta.shared };
}
