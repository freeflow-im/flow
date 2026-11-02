// Self-service account deletion (App Store guideline 5.1.1(v)): DELETE /v1/me.
//
// Reuses the admin-removal machinery: leave every workspace via removeMemberDeep
// (sponsored agents go first, per the sponsor-departure cascade), then tombstone
// the user — row kept for message authorship, email vacated, every credential
// dropped. Unlike the admin path there is no "owner cannot be removed" guard:
// deletion must always be completable in-app, so a departing owner hands the
// workspace to its longest-standing human admin (falling back to the
// longest-standing human member). A workspace with nobody left to promote is
// simply left behind, same as the existing last-member behavior.
import { and, asc, eq, ne } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { forbidden, notFound } from '../lib/errors.js';
import { blobStore } from '../storage/index.js';
import { publishEvent, subjectMeta } from '../bus.js';
import { removeMemberDeep, removeSponsoredAgents, tombstoneUser } from './memberRemoval.js';
import { toMemberDTO } from './workspaces.js';

const { users, workspaceMembers } = schema;

const AVATAR_KEY_RE = /^[0-9a-f-]{36}-\d+\.webp$/;

/**
 * A departing owner's workspace passes to the longest-standing human admin,
 * else the longest-standing human member. Returns quietly when nobody is left.
 */
async function transferOwnership(workspaceId: string, departingOwnerId: string): Promise<void> {
  const candidates = await db
    .select({ userId: workspaceMembers.userId, role: workspaceMembers.role })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        ne(workspaceMembers.userId, departingOwnerId),
        eq(users.isBot, false),
        eq(users.isAgent, false),
      ),
    )
    .orderBy(asc(workspaceMembers.joinedAt));
  const successor = candidates.find((c) => c.role === 'admin') ?? candidates[0];
  if (!successor) return;
  await db
    .update(workspaceMembers)
    .set({ role: 'owner' })
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, successor.userId)));
  publishEvent(subjectMeta(workspaceId), {
    type: 'member.updated',
    workspaceId,
    ts: new Date().toISOString(),
    data: await toMemberDTO(workspaceId, successor.userId),
  });
}

/**
 * Delete the calling user's own account. Humans only — agents and bots have
 * their own lifecycles (removeAgent / deleteApp) driven by their sponsor.
 */
export async function deleteMyAccount(userId: string): Promise<void> {
  const [u] = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (!u || u.deletedAt) throw notFound('user not found');
  if (u.isBot || u.isAgent) throw forbidden('agent accounts are removed by their sponsor or a workspace admin');

  const memberships = await db
    .select({ workspaceId: workspaceMembers.workspaceId, role: workspaceMembers.role })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, userId));

  for (const m of memberships) {
    await removeSponsoredAgents(m.workspaceId, userId);
    if (m.role === 'owner') await transferOwnership(m.workspaceId, userId);
    await removeMemberDeep(m.workspaceId, userId);
  }

  await db.transaction(async (tx) => {
    await tombstoneUser(tx, userId, u.email);
  });

  // Best-effort blob cleanup — the DB row already dropped the reference.
  if (u.avatarUrl?.startsWith('/v1/avatars/')) {
    const key = u.avatarUrl.slice('/v1/avatars/'.length);
    if (AVATAR_KEY_RE.test(key)) await blobStore().delete(`avatars/${key}`).catch(() => {});
  }
}
