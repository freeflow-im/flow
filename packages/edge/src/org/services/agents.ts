// First-class AI agents (AGENT_MEMBERS.md): invite-code onboarding.
//
// Agents are real `users` rows (is_agent=true) and ordinary workspace members
// (always role 'member'), so channels, DMs, threads, reactions, files, typing,
// and presence work with zero special cases. Onboarding: a human member
// generates a one-time invite code inside Flow; the agent redeems it
// (`npx flow-agent-bridge <code>`), bringing its durable credentials (username +
// secret key), and joins immediately — no approval popup. The code carries the
// sponsor + workspace; the sponsor is recorded on the agent's user row and is
// responsible for what the agent does. The avatar is picked at random and the
// sponsor can change it in-app afterwards.
import { randomBytes, randomInt } from 'node:crypto';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type {
  AgentInviteDTO,
  AgentLoginResponse,
  AgentRedeemResponse,
  AgentWorkspaceInviteResponse,
  RedeemAgentInviteBody,
} from '@flow/shared';
import { db, schema } from '../db/index.js';
import { config } from '../config.js';
import { newId } from '../lib/ids.js';
import { hashToken, newToken } from '../lib/tokens.js';
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../lib/errors.js';
import { publishEvent, subjectMeta } from '../bus.js';
import { postSystemMessage } from './messages.js';
import { announceJoin, enrollInWorkspace, requireMembership, toWorkspaceDTO } from './workspaces.js';
import { removeAgentFromWorkspace } from './memberRemoval.js';
import { hashSecret, toUserDTO, verifySecret, visibleEmail } from './auth.js';
import { setAvatar } from './users.js';
import { listAgentAvatarPresets, readAgentAvatarPreset } from './agentAvatars.js';

const { agentInvites, agentTokens, channels, channelMembers, users, workspaceMembers, workspaces } = schema;

const INVITE_TTL_MS = config.inviteTtlDays * 86400_000;

// Invite codes are meant to be read aloud / retyped, so we keep them short and
// unambiguous: `flow-` + two groups of 4 over an uppercase alphabet with no
// 0/O/1/I confusables (~40 bits). Guessability is bounded instead by the
// single-use + 7-day-expiry + rate-limited redeem endpoint.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newInviteCode(): string {
  const group = (): string =>
    Array.from({ length: 4 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]!).join('');
  return `flow-${group()}-${group()}`;
}

/** A random preset avatar id (or null if none are bundled). */
function pickRandomAvatarPreset(): string | null {
  const ids = listAgentAvatarPresets();
  return ids.length > 0 ? ids[randomInt(ids.length)]! : null;
}

/**
 * Generate a one-time invite code for the sponsor's workspace (any member can
 * sponsor — operator ruling; a permission knob can come later). The raw code is
 * returned once; only its hash is stored.
 */
export async function createAgentInvite(workspaceId: string, sponsorId: string): Promise<AgentInviteDTO> {
  await requireMembership(workspaceId, sponsorId);
  const code = newInviteCode();
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
  await db.insert(agentInvites).values({
    id: newId(),
    codeHash: hashToken(code),
    workspaceId,
    sponsorUserId: sponsorId,
    expiresAt,
  });
  return { code, command: `npx flow-agent-bridge ${code}`, expiresAt: expiresAt.toISOString() };
}

/**
 * Is `username` already spoken for inside `workspaceId`? (#357)
 *
 * Handles are unique per workspace now, not per server: two unrelated agents may
 * both be `@builder` as long as they never share a room. The check therefore
 * runs against the target workspace's roster whenever a membership is created —
 * redeem, or the invite below — instead of against a global unique index.
 * `exceptUserId` lets an agent's own row pass when re-checking its own handle.
 */
async function usernameTakenIn(
  tx: DbLike,
  workspaceId: string,
  username: string,
  exceptUserId?: string,
): Promise<boolean> {
  const rows = await tx
    .select({ id: users.id })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(users.agentUsername, username)))
    .limit(2);
  return rows.some((r) => r.id !== exceptUserId);
}

type DbLike = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * The agent this (username, key) pair identifies, or null. The pair IS the
 * identity now that handles are only per-workspace unique (#357) — several rows
 * can share a username, so every candidate's key is verified and the one that
 * matches wins. Returns null for "no such agent", which is also what a wrong
 * key looks like: callers must not distinguish the two.
 */
async function findAgentByCredentials(username: string, key: string) {
  const candidates = await db
    .select()
    .from(users)
    .where(and(eq(users.agentUsername, username.toLowerCase()), eq(users.isAgent, true)));
  for (const u of candidates) {
    if (u.agentKeyHash && (await verifySecret(u.agentKeyHash, key))) return u;
  }
  return null;
}

/**
 * Redeem a one-time invite code (unauthenticated — the code IS the auth). Creates
 * the agent's user account (credentials from the request; sponsor + workspace
 * from the invite), assigns a random preset avatar, joins the workspace +
 * #general, and mints the agent token — all synchronously. No sponsor approval.
 */
export async function redeemAgentInvite(input: RedeemAgentInviteBody): Promise<AgentRedeemResponse> {
  const username = input.username.toLowerCase();
  const invite = (
    await db.select().from(agentInvites).where(eq(agentInvites.codeHash, hashToken(input.code))).limit(1)
  )[0];
  if (!invite) throw notFound('invite not found');
  if (invite.redeemedAt) throw badRequest('invite_used', 'this invite code has already been used');
  if (invite.expiresAt < new Date()) {
    throw badRequest('invite_expired', 'this invite code has expired — generate a new one in Flow');
  }
  if (await usernameTakenIn(db, invite.workspaceId, username)) {
    throw badRequest('username_taken', 'that agent username is already taken in this workspace');
  }
  // #357: the (username, key) pair is the identity. A pair that already names
  // an agent redeems as "add me here too" — same account, new membership — so
  // one bridge identity can serve several workspaces. Anything else (unknown
  // handle, or a handle held elsewhere under a different key) creates a fresh
  // account, which is what every redeem did before.
  const existing = await findAgentByCredentials(username, input.key);
  const userId = existing?.id ?? newId();
  // argon2 — do the heavy work before the transaction
  const keyHash = existing?.agentKeyHash ?? (await hashSecret(input.key));
  const agentToken = `flow-agent-token-${newToken()}`;
  let generalChannel: { id: string; workspaceId: string; kind: string } | null = null;
  await db.transaction(async (tx) => {
    // claim the invite first (conditional update guards double-redeem races);
    // agentUserId is stamped after the user row exists (FK)
    const claimed = await tx
      .update(agentInvites)
      .set({ redeemedAt: new Date() })
      .where(and(eq(agentInvites.id, invite.id), isNull(agentInvites.redeemedAt)))
      .returning();
    if (!claimed[0]) throw badRequest('invite_used', 'this invite code has already been used');
    if (await usernameTakenIn(tx, invite.workspaceId, username, userId)) {
      throw badRequest('username_taken', 'that agent username is already taken in this workspace');
    }
    if (!existing) {
      // Same recipe as app bot users: synthetic unique email, unusable password
      // hash, emailVerifiedAt stamped (agents never do the email flow).
      await tx.insert(users).values({
        id: userId,
        email: `agent-${userId}@agents.flow.local`,
        passwordHash: `!agent:${randomBytes(24).toString('hex')}`,
        displayName: input.name.trim(),
        statusText: input.description?.slice(0, 80) ?? '',
        isAgent: true,
        emailVerifiedAt: new Date(),
        sponsorUserId: invite.sponsorUserId,
        agentUsername: username,
        agentKeyHash: keyHash,
      });
    }
    await tx.update(agentInvites).set({ agentUserId: userId }).where(eq(agentInvites.id, invite.id));
    await tx
      .insert(workspaceMembers)
      .values({ workspaceId: invite.workspaceId, userId, role: 'member', sponsorUserId: invite.sponsorUserId })
      .onConflictDoNothing();
    const general = await tx
      .select()
      .from(channels)
      .where(and(eq(channels.workspaceId, invite.workspaceId), eq(channels.name, 'general')))
      .limit(1);
    if (general[0]) {
      await tx.insert(channelMembers).values({ channelId: general[0].id, userId }).onConflictDoNothing();
      generalChannel = { id: general[0].id, workspaceId: invite.workspaceId, kind: general[0].kind };
    }
    await tx.insert(agentTokens).values({ id: newId(), tokenHash: hashToken(agentToken), userId });
  });
  // Random preset avatar through the normal pipeline (square-crop → webp → R2)
  // BEFORE announcing the join, so member.joined already carries the avatarUrl.
  // Best-effort: a failure here shouldn't undo a successful join. An account
  // that already exists keeps the avatar its sponsor may have since changed.
  const preset = existing ? null : pickRandomAvatarPreset();
  if (preset) {
    try {
      await setAvatar(userId, readAgentAvatarPreset(preset), 'image/png');
    } catch (err) {
      console.error(`agent avatar assignment failed for ${userId}: ${(err as Error).message}`);
    }
  }
  const userRow = (await db.select().from(users).where(eq(users.id, userId)).limit(1))[0]!;
  const wsRow = (await db.select().from(workspaces).where(eq(workspaces.id, invite.workspaceId)).limit(1))[0]!;
  publishEvent(subjectMeta(invite.workspaceId), {
    type: 'member.joined',
    workspaceId: invite.workspaceId,
    ts: new Date().toISOString(),
    data: {
      userId,
      displayName: userRow.displayName,
      email: visibleEmail(userRow), // #489 (an agent's synthetic address, in practice)
      avatarUrl: userRow.avatarUrl,
      statusEmoji: userRow.statusEmoji,
      statusText: userRow.statusText,
      isAgent: true,
      sponsorId: invite.sponsorUserId,
      role: 'member',
      joinedAt: new Date().toISOString(),
    },
  });
  // Announce the agent's arrival in #general with the same inline notice a human
  // join posts (ui_nits). Best-effort inside postSystemMessage.
  if (generalChannel) await postSystemMessage(generalChannel, userId, 'member_joined');
  return {
    agentToken,
    user: toUserDTO(userRow, userRow.id),
    workspace: toWorkspaceDTO(wsRow),
  };
}

/**
 * Add an agent that already exists to another of the caller's workspaces (#357)
 * — the profile popup's "Invite to workspace" for agents.
 *
 * Same effect as a redeem minus the account: membership, #general, the join
 * line. No approval step and no invite code, matching the agent-invite
 * philosophy — a member vouches and the agent is in. The *inviter* becomes its
 * sponsor there, because sponsorship is per-workspace: whoever brought it into
 * this room answers for it in this room.
 *
 * The caller must both share a workspace with the agent (that is what makes the
 * agent visible to them at all) and belong to the target. Failing either reads
 * as 404, so the endpoint never confirms that a workspace or an agent exists to
 * someone who couldn't otherwise tell.
 */
export async function inviteAgentToWorkspace(
  agentUserId: string,
  workspaceId: string,
  inviterId: string,
): Promise<AgentWorkspaceInviteResponse> {
  await requireMembership(workspaceId, inviterId); // 404s for non-members
  const agent = (await db.select().from(users).where(eq(users.id, agentUserId)).limit(1))[0];
  if (!agent?.isAgent || agent.deletedAt) throw notFound('agent not found');
  if (!(await sharesWorkspace(inviterId, agentUserId))) throw notFound('agent not found');

  const already = await db
    .select({ one: sql`1` })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, agentUserId)))
    .limit(1);
  if (already.length > 0) throw conflict('already_member', 'that agent is already in this workspace');
  if (agent.agentUsername && (await usernameTakenIn(db, workspaceId, agent.agentUsername))) {
    throw conflict('username_taken', `@${agent.agentUsername} is already taken in that workspace`);
  }

  const joined = await db.transaction((tx) =>
    enrollInWorkspace(tx, workspaceId, agentUserId, 'member', inviterId),
  );
  if (joined) await announceJoin(workspaceId, agentUserId);
  const wsRow = (await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1))[0]!;
  return { workspace: toWorkspaceDTO(wsRow, 'member') };
}

/** Do these two users share at least one workspace? (i.e. can A see B's profile) */
export async function sharesWorkspace(a: string, b: string): Promise<boolean> {
  const mine = db.select({ w: workspaceMembers.workspaceId }).from(workspaceMembers).where(eq(workspaceMembers.userId, a));
  const rows = await db
    .select({ one: sql`1` })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.userId, b), inArray(workspaceMembers.workspaceId, mine)))
    .limit(1);
  return rows.length > 0;
}

/**
 * Username + key → fresh agent token (the "lost agent.json" path — no admin
 * involved). Revokes every prior token, so login doubles as rotation.
 */
export async function agentLogin(username: string, key: string): Promise<AgentLoginResponse> {
  const user = await findAgentByCredentials(username, key);
  if (!user) throw unauthorized('invalid agent credentials');
  const agentToken = `flow-agent-token-${newToken()}`;
  await db.transaction(async (tx) => {
    await tx
      .update(agentTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(agentTokens.userId, user.id), isNull(agentTokens.revokedAt)));
    await tx.insert(agentTokens).values({ id: newId(), tokenHash: hashToken(agentToken), userId: user.id });
  });
  return { agentToken, user: toUserDTO(user, user.id) };
}

/**
 * Remove an agent from ONE workspace (owner/admin, or its sponsor there) —
 * same semantics as app removal: leave the workspace + channels, delete 1:1
 * DMs, keep the user row for authorship. Since #357 an agent can live in
 * several workspaces, so the credentials are only revoked when the last
 * membership goes; until then the agent keeps working where it still belongs.
 */
export async function removeAgent(workspaceId: string, agentUserId: string, actorId: string): Promise<void> {
  const actor = await requireMembership(workspaceId, actorId);
  const target = (await db.select().from(users).where(eq(users.id, agentUserId)).limit(1))[0];
  if (!target?.isAgent) throw notFound('agent not found');
  const membership = await db
    .select({ sponsorUserId: workspaceMembers.sponsorUserId })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, agentUserId)))
    .limit(1);
  if (membership.length === 0) throw notFound('agent not found');
  // #357: sponsorship is per-workspace — the sponsor who can remove the agent
  // here is whoever brought it here, not whoever first created the account.
  const sponsorHere = membership[0]!.sponsorUserId ?? target.sponsorUserId;
  if (actor.role !== 'owner' && actor.role !== 'admin' && sponsorHere !== actorId) {
    throw forbidden('only owners, admins, or the agent’s sponsor can remove an agent');
  }
  await removeAgentFromWorkspace(workspaceId, agentUserId);
}
