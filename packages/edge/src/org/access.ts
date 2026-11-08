// One function answers Chat (docs/specs/platform.md §4.2–§4.4, phase 3.4): the reader's role on a channel, an artifact
// or a file, from the grants library's `effectiveRole` over the object's container chain.
//
// The chain of an artifact is itself, then its channel. A file's is itself, then whatever makes it visible: each
// artifact it backs (then that artifact's channel), and each channel it is attached to a message in (through the
// message, then the channel). The highest role over those paths is the file's.
//
// Membership is an implicit grant: every channel container carries `channel:<id>` as editor, not stored, so a member
// reads, posts and manages the channel's artifacts as today, and a non-member gets nothing from it. A workspace owner
// or admin who is a member is `manager` on it (they rotate an app's secret, they share). A message in a public channel
// is readable by the organization (`org` as viewer), as reading the channel is today, which is how a public channel's
// attachments open for someone who has not joined it. The creator of an artifact, and the uploader of a file, is its
// `owner` (§4.3: a column, not a grant). Everything else is the `grants` table: explicit grants, on any link.
import { and, eq, inArray, isNull, min, or } from 'drizzle-orm';
import {
  accountPrincipal, atLeast, channelPrincipal, effectiveRole, grantFromRow, maxRole, ORG_PRINCIPAL,
  type ChainLink, type Grant, type GrantReader, type Role,
} from '@flow/shared/grants';
import { db, schema } from './db/index.js';
import { forbidden, notFound } from './lib/errors.js';
import { requireMembership } from './services/workspaces.js';

const { artifacts, channels, channelMembers, files, messageFiles, messages, workspaceMembers, grants } = schema;

/** The kinds of Chat object a grant can name. */
export type ChatObjectKind = 'channel' | 'artifact' | 'file';

/** Who asks, in one workspace: the grants library's reader (the account, the channels it is a member of) and its user. */
export interface ChatReader extends GrantReader {
  userId: string;
  workspaceId: string;
}

/** An object's chain, loaded: its workspace, its channel (an artifact's, or the channel itself), whether that channel
 * is private, its owner's user id, and each path from the object up to a channel, each link with its grants. */
export interface ChatChain {
  kind: ChatObjectKind;
  id: string;
  workspaceId: string;
  channelId: string | null;
  privateChannel: boolean;
  ownerUserId: string | null;
  paths: ChainLink[][];
}

const ADMIN_ROLES: ('owner' | 'admin')[] = ['owner', 'admin'];

/**
 * The reader for a user in a workspace: their account (or, for a member with none recorded, a placeholder no grant
 * names) and every channel there they are a member of. Not a member of the workspace: the 404 `requireMembership` gives.
 */
export async function readerFor(userId: string, workspaceId: string): Promise<ChatReader> {
  const m = await requireMembership(workspaceId, userId);
  const mine = await db
    .select({ id: channelMembers.channelId })
    .from(channelMembers)
    .innerJoin(channels, eq(channels.id, channelMembers.channelId))
    .where(and(eq(channelMembers.userId, userId), eq(channels.workspaceId, workspaceId)));
  return { userId, workspaceId, accountId: m.accountId ?? `user:${userId}`, channelIds: mine.map((r) => r.id) };
}

/** The stored grants on a set of objects, by `kind:id`. */
async function storedGrants(objects: { objectKind: string; objectId: string }[]): Promise<Map<string, Grant[]>> {
  const out = new Map<string, Grant[]>();
  if (objects.length === 0) return out;
  const rows = await db.select().from(grants).where(or(...objects.map((o) => and(eq(grants.objectKind, o.objectKind), eq(grants.objectId, o.objectId)))));
  for (const r of rows) {
    const key = `${r.objectKind}:${r.objectId}`;
    const g = grantFromRow({ object_kind: r.objectKind, object_id: r.objectId, principal: r.principal, role: r.role, granted_by: r.grantedBy, granted_at: r.grantedAt, expires_at: r.expiresAt });
    out.set(key, [...(out.get(key) ?? []), g]);
  }
  return out;
}

/** The channel container's link: its stored grants, membership as `channel:<id>` editor, and each owner or admin of
 * the workspace who is a member as manager (by account). */
async function channelLink(channelId: string, workspaceId: string, stored: Map<string, Grant[]>): Promise<ChainLink> {
  const managers = await db
    .select({ accountId: workspaceMembers.accountId })
    .from(channelMembers)
    .innerJoin(workspaceMembers, and(eq(workspaceMembers.userId, channelMembers.userId), eq(workspaceMembers.workspaceId, workspaceId)))
    .where(and(eq(channelMembers.channelId, channelId), inArray(workspaceMembers.role, ADMIN_ROLES)));
  const implicit = (principal: string, role: Role): Grant => ({ objectKind: 'channel', objectId: channelId, principal: principal as Grant['principal'], role, grantedBy: '', grantedAt: new Date(0).toISOString() });
  return {
    objectKind: 'channel',
    objectId: channelId,
    grants: [
      ...(stored.get(`channel:${channelId}`) ?? []),
      implicit(channelPrincipal(channelId), 'editor'),
      ...managers.filter((m) => m.accountId).map((m) => implicit(accountPrincipal(m.accountId!), 'manager')),
    ],
  };
}

/** The chain of a Chat object, or null when there is none (an artifact or channel that does not exist, a file that is
 * not ready or was deleted). */
export async function chainOf(kind: ChatObjectKind, id: string): Promise<ChatChain | null> {
  if (kind === 'channel') {
    const chan = (await db.select().from(channels).where(eq(channels.id, id)).limit(1))[0];
    if (!chan) return null;
    const stored = await storedGrants([{ objectKind: 'channel', objectId: id }]);
    return { kind, id, workspaceId: chan.workspaceId, channelId: id, privateChannel: chan.isPrivate, ownerUserId: null, paths: [[await channelLink(id, chan.workspaceId, stored)]] };
  }
  if (kind === 'artifact') {
    const row = (await db.select({ a: artifacts, isPrivate: channels.isPrivate }).from(artifacts).innerJoin(channels, eq(channels.id, artifacts.channelId)).where(eq(artifacts.id, id)).limit(1))[0];
    if (!row) return null;
    const { a } = row;
    const stored = await storedGrants([{ objectKind: 'artifact', objectId: id }, { objectKind: 'channel', objectId: a.channelId }]);
    const path = [{ objectKind: 'artifact', objectId: id, grants: stored.get(`artifact:${id}`) ?? [] }, await channelLink(a.channelId, a.workspaceId, stored)];
    return { kind, id, workspaceId: a.workspaceId, channelId: a.channelId, privateChannel: row.isPrivate, ownerUserId: a.createdBy, paths: [path] };
  }
  const f = (await db.select().from(files).where(and(eq(files.id, id), isNull(files.deletedAt), eq(files.status, 'ready'))).limit(1))[0];
  if (!f) return null;
  const pinned = await db.select({ id: artifacts.id, channelId: artifacts.channelId }).from(artifacts).where(eq(artifacts.fileId, id));
  const attached = await db
    .select({ channelId: messages.channelId, messageId: min(messages.id), isPrivate: channels.isPrivate })
    .from(messageFiles)
    .innerJoin(messages, eq(messages.id, messageFiles.messageId))
    .innerJoin(channels, eq(channels.id, messages.channelId))
    .where(eq(messageFiles.fileId, id))
    .groupBy(messages.channelId, channels.isPrivate);
  const stored = await storedGrants([
    { objectKind: 'file', objectId: id },
    ...pinned.map((p) => ({ objectKind: 'artifact', objectId: p.id })),
    ...[...new Set([...pinned, ...attached].map((p) => p.channelId))].map((c) => ({ objectKind: 'channel', objectId: c })),
  ]);
  const fileLink: ChainLink = { objectKind: 'file', objectId: id, grants: stored.get(`file:${id}`) ?? [] };
  const paths: ChainLink[][] = [];
  for (const p of pinned) paths.push([fileLink, { objectKind: 'artifact', objectId: p.id, grants: stored.get(`artifact:${p.id}`) ?? [] }, await channelLink(p.channelId, f.workspaceId, stored)]);
  for (const m of attached) {
    const open: Grant[] = m.isPrivate ? [] : [{ objectKind: 'message', objectId: m.messageId ?? '', principal: ORG_PRINCIPAL, role: 'viewer', grantedBy: '', grantedAt: new Date(0).toISOString() }];
    paths.push([fileLink, { objectKind: 'message', objectId: m.messageId ?? '', grants: open }, await channelLink(m.channelId, f.workspaceId, stored)]);
  }
  if (paths.length === 0) paths.push([fileLink]);
  return { kind, id, workspaceId: f.workspaceId, channelId: null, privateChannel: true, ownerUserId: f.userId, paths };
}

/** The reader's role on a loaded chain: the highest `effectiveRole` over its paths; null outside the reader's workspace. */
export function roleOnChain(reader: ChatReader, chain: ChatChain): Role | null {
  if (chain.workspaceId !== reader.workspaceId) return null;
  const ownerAccountId = chain.ownerUserId !== null && chain.ownerUserId === reader.userId ? reader.accountId : null;
  let best: Role | null = null;
  for (const path of chain.paths) best = maxRole(best, effectiveRole({ reader, ownerAccountId, chain: path }));
  return best;
}

/** The reader's role on a Chat object, or null for no access (or no object). */
export async function accessOf(reader: ChatReader, kind: ChatObjectKind, id: string): Promise<Role | null> {
  const chain = await chainOf(kind, id);
  return chain ? roleOnChain(reader, chain) : null;
}

const NOT_FOUND: Record<ChatObjectKind, string> = { channel: 'channel not found', artifact: 'artifact not found', file: 'file not found' };

/**
 * The user's role on a Chat object, at least `needed`, with the chain and the reader; throws otherwise, with the
 * answers Chat gave before: no object, or no role on one in a private channel (or a file), is a 404 that does not leak
 * it; no role on a public channel's artifact or channel is a 403 (join the channel first); a role too low is a 403.
 */
export async function requireRole(userId: string, kind: ChatObjectKind, id: string, needed: Role): Promise<{ role: Role; chain: ChatChain; reader: ChatReader }> {
  const chain = await chainOf(kind, id);
  if (!chain) throw notFound(NOT_FOUND[kind]);
  const reader = await readerFor(userId, chain.workspaceId);
  const role = roleOnChain(reader, chain);
  if (!role) {
    if (kind !== 'file' && !chain.privateChannel) throw forbidden(kind === 'artifact' ? 'join the channel to manage its artifacts' : 'join the channel first');
    throw notFound(NOT_FOUND[kind]);
  }
  if (!atLeast(role, needed)) throw forbidden(`you need to be ${needed === 'editor' ? 'an' : 'a'} ${needed} of this ${kind}`);
  return { role, chain, reader };
}

/** The stored (explicit) grants on one object. */
export async function grantsOn(kind: ChatObjectKind, id: string): Promise<Grant[]> {
  return (await storedGrants([{ objectKind: kind, objectId: id }])).get(`${kind}:${id}`) ?? [];
}
