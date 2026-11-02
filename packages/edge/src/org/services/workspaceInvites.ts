// Invite someone you already work with into another of your workspaces (#359)
// — the people half of the profile popup's "Invite to workspace" (#358).
//
// Agents join instantly because their sponsor vouches for them (#357); people
// have to consent, so the same button produces an INVITATION. It is an ordinary
// row in `invites` — same table, same 7-day expiry, same accept path — with two
// differences: `invited_user_id` names the Flow user it is addressed to, and no
// email is sent. The raw token is minted and hashed as usual but shown to
// nobody, so the invitee accepts by invite id instead.
//
// The invitee learns about it two ways, both of them machinery that already
// exists: a DM from the inviter (which produces the normal DM notification,
// badge and push on every client), and `GET /v1/me/workspace-invites`, which is
// what draws the Accept / Decline card.
import { and, eq, gt, inArray, isNull } from 'drizzle-orm';
import type { PendingWorkspaceInviteDTO, UserWorkspaceInviteResponse, WorkspaceInviteTargetsDTO } from '@flow/shared';
import { db, schema } from '../db/index.js';
import { config } from '../config.js';
import { newId } from '../lib/ids.js';
import { hashToken, newToken } from '../lib/tokens.js';
import { conflict, notFound } from '../lib/errors.js';
import { publishEvent, subjectUserNotify } from '../bus.js';
import { requireMembership, toWorkspaceDTO } from './workspaces.js';
import { createDm } from './channels.js';
import { sendMessage } from './messages.js';

const { invites, users, workspaceMembers, workspaces } = schema;

const INVITE_TTL_MS = config.inviteTtlDays * 86400_000;

type InviteRow = typeof invites.$inferSelect;

/** Every workspace id `userId` belongs to. */
async function membershipIds(userId: string): Promise<string[]> {
  const rows = await db
    .select({ workspaceId: workspaceMembers.workspaceId })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, userId));
  return rows.map((r) => r.workspaceId);
}

/**
 * The picker behind "Invite to workspace" (#358): the viewer's workspaces minus
 * the ones the subject is already in. Works for agents and people alike — the
 * list is the same question either way, only the button behind it differs.
 *
 * Requires a shared workspace, which is exactly the condition that let the
 * viewer open this profile in the first place. Without one it is 404, not an
 * empty list: "who is this" must not be answerable by a stranger.
 */
export async function workspaceInviteTargets(subjectUserId: string, viewerId: string): Promise<WorkspaceInviteTargetsDTO> {
  const subject = (await db.select().from(users).where(eq(users.id, subjectUserId)).limit(1))[0];
  if (!subject || subject.deletedAt) throw notFound('user not found');
  const [mine, theirs] = await Promise.all([membershipIds(viewerId), membershipIds(subjectUserId)]);
  if (subjectUserId !== viewerId && !mine.some((w) => theirs.includes(w))) throw notFound('user not found');
  const candidates = mine.filter((w) => !theirs.includes(w));
  if (candidates.length === 0) return { workspaces: [] };
  const rows = await db
    .select({ w: workspaces, role: workspaceMembers.role })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(and(eq(workspaceMembers.userId, viewerId), inArray(workspaceMembers.workspaceId, candidates)))
    .orderBy(workspaceMembers.joinedAt);
  return { workspaces: rows.map((r) => toWorkspaceDTO(r.w, r.role)) };
}

/**
 * Invite a person into `workspaceId`. The caller must share a workspace with
 * them (so they can see the profile at all) and belong to the target; either
 * miss reads as 404 so the endpoint leaks neither the workspace nor the person.
 *
 * Idempotent: asking twice returns the invitation that is already pending
 * rather than sending a second one — with `created: false`, so the caller can
 * say "already invited" instead of claiming it just sent something.
 */
export async function inviteUserToWorkspace(
  targetUserId: string,
  workspaceId: string,
  inviterId: string,
): Promise<UserWorkspaceInviteResponse> {
  await requireMembership(workspaceId, inviterId); // 404s for non-members
  const target = (await db.select().from(users).where(eq(users.id, targetUserId)).limit(1))[0];
  if (!target || target.deletedAt) throw notFound('user not found');
  if (target.isAgent || target.isBot) throw conflict('not_a_person', 'agents are added directly, not invited');
  if (targetUserId === inviterId) throw conflict('self_invite', 'you are already in this workspace');

  const [mine, theirs] = await Promise.all([membershipIds(inviterId), membershipIds(targetUserId)]);
  if (!mine.some((w) => theirs.includes(w))) throw notFound('user not found');
  if (theirs.includes(workspaceId)) throw conflict('already_member', 'they are already in that workspace');

  const now = new Date();
  const pending = (
    await db
      .select()
      .from(invites)
      .where(
        and(
          eq(invites.workspaceId, workspaceId),
          eq(invites.email, target.email),
          isNull(invites.acceptedAt),
          isNull(invites.declinedAt),
          gt(invites.expiresAt, now),
        ),
      )
      .limit(1)
  )[0];
  if (pending) return { invite: await hydrate(pending), created: false };

  // An expired or declined row still occupies the (workspace, email) slot the
  // partial unique index guards only while pending — clear anything stale so a
  // re-invite after an expiry works.
  await db
    .delete(invites)
    .where(
      and(
        eq(invites.workspaceId, workspaceId),
        eq(invites.email, target.email),
        isNull(invites.acceptedAt),
        isNull(invites.declinedAt),
      ),
    );

  const row: InviteRow = (
    await db
      .insert(invites)
      .values({
        id: newId(),
        workspaceId,
        email: target.email,
        // Minted and hashed like any invite so the token column keeps its shape
        // and its unique index; nobody is ever shown this one.
        tokenHash: hashToken(newToken()),
        invitedBy: inviterId,
        invitedUserId: targetUserId,
        expiresAt: new Date(now.getTime() + INVITE_TTL_MS),
      })
      .returning()
  )[0]!;

  const dto = await hydrate(row);
  await notifyInvitee(dto, inviterId, targetUserId, mine, theirs);
  publishEvent(subjectUserNotify(targetUserId), {
    type: 'workspace.invited',
    workspaceId,
    ts: dto.createdAt,
    data: { inviteId: dto.id, invite: dto },
  });
  return { invite: dto, created: true };
}

/** My live invitations — what the Accept / Decline card is drawn from. */
export async function listMyWorkspaceInvites(userId: string): Promise<PendingWorkspaceInviteDTO[]> {
  const rows = await db
    .select({ i: invites, w: workspaces, inviter: users })
    .from(invites)
    .innerJoin(workspaces, eq(workspaces.id, invites.workspaceId))
    .innerJoin(users, eq(users.id, invites.invitedBy))
    .where(
      and(
        eq(invites.invitedUserId, userId),
        isNull(invites.acceptedAt),
        isNull(invites.declinedAt),
        gt(invites.expiresAt, new Date()),
      ),
    )
    .orderBy(invites.createdAt);
  return rows.map((r) => ({
    id: r.i.id,
    workspaceId: r.w.id,
    workspaceName: r.w.name,
    workspaceSlug: r.w.slug,
    workspaceAvatarUrl: r.w.avatarUrl,
    inviterId: r.inviter.id,
    inviterName: r.inviter.displayName,
    createdAt: r.i.createdAt.toISOString(),
    expiresAt: r.i.expiresAt.toISOString(),
  }));
}

/** An invite row plus the workspace and inviter names the card needs. */
async function hydrate(row: InviteRow): Promise<PendingWorkspaceInviteDTO> {
  const [w] = await db.select().from(workspaces).where(eq(workspaces.id, row.workspaceId)).limit(1);
  const [inviter] = await db.select().from(users).where(eq(users.id, row.invitedBy)).limit(1);
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    workspaceName: w?.name ?? '',
    workspaceSlug: w?.slug ?? '',
    workspaceAvatarUrl: w?.avatarUrl ?? null,
    inviterId: row.invitedBy,
    inviterName: inviter?.displayName ?? '',
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
  };
}

/**
 * The ping. A DM from the inviter in a workspace they already share, which
 * costs no new notification surface: it is a normal message, so it badges the
 * sidebar, lands in Activity and pushes to phones exactly like any other DM.
 * Best-effort — a failed DM must not undo a valid invitation, which the card
 * would show regardless.
 */
async function notifyInvitee(
  invite: PendingWorkspaceInviteDTO,
  inviterId: string,
  targetUserId: string,
  inviterWorkspaces: string[],
  targetWorkspaces: string[],
): Promise<void> {
  const shared = inviterWorkspaces.find((w) => targetWorkspaces.includes(w));
  if (!shared) return;
  try {
    const dm = await createDm(shared, inviterId, [targetUserId]);
    await sendMessage(
      dm.id,
      inviterId,
      newId(),
      `I invited you to the **${invite.workspaceName}** workspace — accept or decline it from your workspace list.`,
      undefined,
      undefined,
      [targetUserId],
    );
  } catch (err) {
    console.error(`workspace invite DM failed for ${targetUserId}: ${(err as Error).message}`);
  }
}
