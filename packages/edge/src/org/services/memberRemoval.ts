// Deep workspace removal for bot-like members, generalized from deleteApp
// (AGENTS_DESIGN.md: remove-agent reuses app-removal semantics).
//
// Leaves the workspace + all channels THERE, deletes that workspace's 1:1 DMs
// outright (a DM whose only other member is gone renders as a broken self-DM;
// group DMs just lose the membership), keeps the user row so message
// authorship keeps its name, and publishes the same member.left events
// deleteApp always has. Channels and DMs in the member's other workspaces are
// untouched.
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import { publishEvent, subjectMeta } from '../bus.js';

const {
  channels,
  channelMembers,
  notifications,
  workspaceMembers,
  users,
  agentTokens,
  sessions,
  emailTokens,
  appLinkCodes,
  oauthIdentities,
  deviceTokens,
} = schema;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Remove `userId` from `workspaceId` and every channel there. `also` runs
 * inside the same transaction (deleteApp deletes the app row with it).
 */
export async function removeMemberDeep(
  workspaceId: string,
  userId: string,
  also?: (tx: Tx) => Promise<void>,
): Promise<void> {
  // The member's channels IN THIS WORKSPACE only. Members can belong to
  // several workspaces (humans always could; agents since #357), and leaving
  // one must not touch channel memberships or DMs in the others.
  const memberChannels = await db
    .select({ id: channels.id, kind: channels.kind })
    .from(channelMembers)
    .innerJoin(channels, eq(channels.id, channelMembers.channelId))
    .where(and(eq(channelMembers.userId, userId), eq(channels.workspaceId, workspaceId)));
  const dmIds = memberChannels.filter((c) => c.kind === 'dm').map((c) => c.id);
  // Human members of those DMs, captured before the cascade deletes the rows.
  const dmMembers = dmIds.length
    ? await db
        .select({ channelId: channelMembers.channelId, userId: channelMembers.userId })
        .from(channelMembers)
        .where(and(inArray(channelMembers.channelId, dmIds), ne(channelMembers.userId, userId)))
    : [];
  const channelIds = memberChannels.map((c) => c.id);
  await db.transaction(async (tx) => {
    if (dmIds.length) await tx.delete(channels).where(inArray(channels.id, dmIds));
    if (channelIds.length) {
      await tx
        .delete(channelMembers)
        .where(and(eq(channelMembers.userId, userId), inArray(channelMembers.channelId, channelIds)));
    }
    await tx
      .delete(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)));
    // Retire the leaver's unread signal in the channels it just lost — the
    // rows could never clear by visiting (issue #63 review). Read, not
    // deleted: the record survives. DM rows go with the channel cascade above.
    if (channelIds.length) {
      await tx
        .update(notifications)
        .set({ readAt: new Date() })
        .where(
          and(
            eq(notifications.userId, userId),
            isNull(notifications.readAt),
            inArray(notifications.channelId, channelIds),
          ),
        );
    }
    if (also) await also(tx);
  });
  const ts = new Date().toISOString();
  // Deleted DMs: tell each human member (their sockets drop the channel).
  for (const m of dmMembers) {
    publishEvent(subjectMeta(workspaceId), {
      type: 'member.left',
      workspaceId,
      channelId: m.channelId,
      ts,
      data: { userId: m.userId, channelId: m.channelId, workspaceId },
    });
  }
  // The member leaving its remaining channels, then the workspace (no
  // channelId → clients refresh the workspace member list).
  for (const c of memberChannels.filter((ch) => ch.kind !== 'dm')) {
    publishEvent(subjectMeta(workspaceId), {
      type: 'member.left',
      workspaceId,
      channelId: c.id,
      ts,
      data: { userId, channelId: c.id, workspaceId },
    });
  }
  publishEvent(subjectMeta(workspaceId), {
    type: 'member.left',
    workspaceId,
    ts,
    data: { userId, workspaceId },
  });
}

/**
 * Mark a user dead and free their address. Keeps the row (message authorship)
 * but rewrites the unique `email` so the original string is available to a
 * fresh registration, scrubs the password to an unusable sentinel, clears the
 * profile fields that would otherwise linger (avatar URL, status), and drops
 * every credential (sessions, email tokens, app-link codes, OAuth identities)
 * so nothing that account held can still authenticate or re-match on a
 * Google/Apple sign-in. The mangled email preserves the original for audit and
 * can never collide (the user id prefix is unique).
 *
 * Device tokens (#245) go here too, and the FK cascade is not enough on its
 * own: this path keeps the users row, so `ON DELETE CASCADE` never fires. A
 * token left behind would keep pushing this account's notifications to a
 * phone whose owner deleted the account.
 */
export async function tombstoneUser(tx: Tx, userId: string, email: string): Promise<void> {
  await tx
    .update(users)
    .set({
      deletedAt: new Date(),
      email: `tombstone+${userId}+${email}`,
      passwordHash: `!deleted:${userId}`,
      avatarUrl: null,
      statusEmoji: '',
      statusText: '',
    })
    .where(eq(users.id, userId));
  await tx.delete(sessions).where(eq(sessions.userId, userId));
  await tx.delete(emailTokens).where(eq(emailTokens.userId, userId));
  await tx.delete(appLinkCodes).where(eq(appLinkCodes.userId, userId));
  await tx.delete(oauthIdentities).where(eq(oauthIdentities.userId, userId));
  await tx.delete(deviceTokens).where(eq(deviceTokens.userId, userId));
}

/** Revoke an agent's tokens and null its username/key so it can never authenticate again. */
export async function killAgentCredentials(agentUserId: string): Promise<void> {
  await db
    .update(agentTokens)
    .set({ revokedAt: new Date() })
    .where(and(eq(agentTokens.userId, agentUserId), isNull(agentTokens.revokedAt)));
  await db.update(users).set({ agentUsername: null, agentKeyHash: null }).where(eq(users.id, agentUserId));
}

/**
 * Take an agent out of ONE workspace (#357). The membership and its channels go
 * immediately; the credentials only die with the agent's LAST membership,
 * because an agent that still belongs somewhere must still be able to log in
 * there. Fully removed, it is the same dead account it always was: username and
 * key nulled, tokens revoked, user row kept for authorship.
 */
export async function removeAgentFromWorkspace(workspaceId: string, agentUserId: string): Promise<void> {
  await removeMemberDeep(workspaceId, agentUserId);
  const left = await db
    .select({ one: sql`1` })
    .from(workspaceMembers)
    .where(eq(workspaceMembers.userId, agentUserId))
    .limit(1);
  if (left.length === 0) await killAgentCredentials(agentUserId);
}

/**
 * Sponsor-departure cascade (AGENT_MEMBERS.md): when a human leaves a
 * workspace, the agents they sponsor there go with them — orphaned agents
 * falling to an admin would recreate the accountability gap sponsorship
 * closes. Runs before the sponsor's own removal.
 *
 * Per-workspace since #357: the agents that leave are the ones this human
 * sponsors *here* (the membership's sponsor), and each is removed from this
 * workspace only. An agent someone else sponsors elsewhere is untouched, and
 * keeps its credentials.
 */
export async function removeSponsoredAgents(workspaceId: string, sponsorId: string): Promise<void> {
  const sponsored = await db
    .select({ userId: users.id })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        eq(users.isAgent, true),
        // Rows written before #357 carry the sponsor on the user row only; the
        // migration backfilled them, so the COALESCE is belt-and-braces for a
        // membership created by an older code path mid-deploy.
        sql`coalesce(${workspaceMembers.sponsorUserId}, ${users.sponsorUserId}) = ${sponsorId}`,
      ),
    );
  for (const a of sponsored) {
    await removeAgentFromWorkspace(workspaceId, a.userId);
  }
}
