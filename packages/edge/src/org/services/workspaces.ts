import sharp from '../lib/sharp';
import { z } from 'zod';
import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import {
  SIDEBAR_COLOR_IDS,
  WORKSPACE_POLICY_DEFAULTS,
  emailDomain,
  isSelfRegisterableDomain,
  type InviteDTO,
  type InviteResultDTO,
  type JoinLinkDTO,
  type JoinLinkPreviewDTO,
  type MemberRole,
  type WorkspaceDTO,
  type WorkspaceMemberDTO,
  type WorkspacePolicies,
} from '@flow/shared';
import { db, schema, type Tx } from '../db/index.js';
import { newId, presetWorkspaceId } from '../lib/ids.js';
import { hashToken, newLinkToken, newToken } from '../lib/tokens.js';
import { ApiError, badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { config } from '../config.js';
import { blobStore } from '../storage/index.js';
import { publishEvent, subjectMeta, subjectUserMeta, subjectUserNotify } from '../bus.js';
import { emailSender } from '../email/index.js';
import { visibleEmail } from './auth.js';
import { killAgentCredentials, removeMemberDeep, removeSponsoredAgents, tombstoneUser } from './memberRemoval.js';
import { postSystemMessage } from './messages.js';
import { accountFor, ensureAccount } from '../directoryLink.js';

const {
  workspaces,
  workspaceMembers,
  workspaceJoinLinks,
  invites,
  channels,
  channelMembers,
  notifications,
  files,
  users,
  oauthIdentities,
} = schema;

export function toWorkspaceDTO(
  w: typeof workspaces.$inferSelect,
  role?: MemberRole,
  unreadCount?: number,
  /** The caller's own address here, on "my workspaces". */
  address?: string | null,
): WorkspaceDTO {
  const dto: WorkspaceDTO = {
    id: w.id,
    slug: w.slug,
    name: w.name,
    sidebarColor: w.sidebarColor,
    avatarUrl: w.avatarUrl,
    googleSelfRegisterDomain: w.googleSelfRegisterDomain,
    createdBy: w.createdBy,
    createdAt: w.createdAt.toISOString(),
    policies: workspacePolicies(w),
  };
  if (role) dto.role = role;
  if (unreadCount !== undefined) dto.unreadCount = unreadCount;
  if (address) dto.address = address;
  return dto;
}

/** The organization's policies (platform.md §3.1), the defaults filling what was never set. */
export function workspacePolicies(w: Pick<typeof workspaces.$inferSelect, 'policies'>): WorkspacePolicies {
  return { ...WORKSPACE_POLICY_DEFAULTS, ...(w.policies ?? {}) };
}

/**
 * The gate on what a policy governs (platform.md §3.1): owners and admins always pass; a member passes unless the
 * policy says `admins`, which is a 403 `policy_forbids`.
 */
async function requirePolicy(workspaceId: string, userId: string, policy: 'inviteBy' | 'agentsBy', what: string) {
  const m = await requireMembership(workspaceId, userId);
  if (m.role === 'owner' || m.role === 'admin') return m;
  const w = (await db.select({ policies: workspaces.policies }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1))[0];
  if (!w || workspacePolicies(w)[policy] === 'admins') {
    throw new ApiError(403, 'policy_forbids', `only owners and admins can ${what} in this workspace`);
  }
  return m;
}

/** The refusal for what an agent may not do (platform.md §2.2, §3.3): own an organization, be an admin, sponsor an agent. */
export const agentForbidden = (message: string) => new ApiError(403, 'agent_forbidden', message);

/** Whether a user (this organization's copy) is an agent. */
export async function isAgentUser(userId: string): Promise<boolean> {
  return !!(await db.select({ isAgent: users.isAgent }).from(users).where(eq(users.id, userId)).limit(1))[0]?.isAgent;
}

/** `agentsBy` (platform.md §3.1): who may sponsor an agent into this workspace. */
export const requireAgentSponsorRights = (workspaceId: string, userId: string) =>
  requirePolicy(workspaceId, userId, 'agentsBy', 'add agents');

/** What a member row keeps of the joiner's account: its address (§3.2) and its id (the event log's `actor`, §5.2). */
export interface JoinAccount { address: string | null; accountId: string | null }

/**
 * The joiner's account (platform.md §3.2): the directory makes or reactivates it before the member row is written, so
 * the row can carry its address and id. Null for someone already a member, whose row and role stay as they are.
 */
export async function accountForJoin(workspaceId: string, userId: string, role: MemberRole = 'member'): Promise<JoinAccount | null> {
  if (await isWorkspaceMember(workspaceId, userId)) return null;
  const u = (await db.select({ displayName: users.displayName }).from(users).where(eq(users.id, userId)).limit(1))[0];
  const account = await ensureAccount(workspaceId, userId, role, u?.displayName ?? '');
  return { address: account?.address ?? null, accountId: account?.id ?? null };
}

/**
 * Guard for the Google domain self-register toggle (phase16 §5a/§7).
 *
 * Trust anchor: the setter's *own* verified Google email domain. We do not
 * prove they control the DNS domain — enabling `acme.com` requires holding a
 * Google account Google says is verified on `acme.com`. On top of that:
 * consumer domains are denied outright, and (unless FLOW_GOOGLE_REQUIRE_HD=0)
 * the account must be a Google Workspace account on that domain, so a personal
 * Gmail that merely spells a corporate address can't open the doors.
 */
async function assertMaySelfRegisterDomain(userId: string, domain: string): Promise<void> {
  if (!isSelfRegisterableDomain(domain)) {
    throw badRequest('domain_not_allowed', `${domain} cannot be opened to self-registration`);
  }
  const rows = await db
    .select()
    .from(oauthIdentities)
    .where(and(eq(oauthIdentities.userId, userId), eq(oauthIdentities.provider, 'google')));
  const match = rows.find((r) => emailDomain(r.email) === domain);
  if (!match) {
    throw forbidden(`you can only open a workspace to your own Google email domain`);
  }
  if (config.googleRequireHostedDomain && (match.hostedDomain ?? '').toLowerCase() !== domain) {
    throw forbidden(`${domain} must be a Google Workspace domain on your account`);
  }
}

/**
 * Workspace branding (phase 3.5 ruling 3): owner/admin sets the sidebar color
 * (curated preset id) for everyone; broadcast on meta so clients restyle live.
 */
export async function updateWorkspace(
  workspaceId: string,
  actorId: string,
  patch: {
    sidebarColor?: string | undefined;
    // phase 11 §10 — null allowlist clears it back to "all domains allowed"
    unfurlEnabled?: boolean | undefined;
    unfurlDomainAllowlist?: string[] | null | undefined;
    // phase 16 §5a — null turns domain self-registration off
    googleSelfRegisterDomain?: string | null | undefined;
    // platform.md §3.1 — any subset; the rest keep their values
    policies?: Partial<{ [K in keyof WorkspacePolicies]: WorkspacePolicies[K] | undefined }> | undefined;
  },
): Promise<WorkspaceDTO> {
  const m = await requireWorkspaceAdmin(workspaceId, actorId);
  const set: Partial<{
    sidebarColor: string;
    unfurlEnabled: boolean;
    unfurlDomainAllowlist: string[] | null;
    googleSelfRegisterDomain: string | null;
    policies: WorkspacePolicies;
  }> = {};
  if (patch.policies !== undefined) {
    const current = (await db.select({ policies: workspaces.policies }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1))[0];
    if (!current) throw notFound('workspace not found');
    const given = Object.fromEntries(Object.entries(patch.policies).filter(([, v]) => v !== undefined));
    // Stored whole, so the directory's copy (sent by the outbox) is whole too.
    set.policies = { ...workspacePolicies(current), ...given };
  }
  if (patch.sidebarColor !== undefined) {
    if (!SIDEBAR_COLOR_IDS.includes(patch.sidebarColor)) {
      throw badRequest('bad_color', `sidebarColor must be one of: ${SIDEBAR_COLOR_IDS.join(', ')}`);
    }
    set.sidebarColor = patch.sidebarColor;
  }
  if (patch.unfurlEnabled !== undefined) set.unfurlEnabled = patch.unfurlEnabled;
  if (patch.unfurlDomainAllowlist !== undefined) {
    set.unfurlDomainAllowlist = patch.unfurlDomainAllowlist === null
      ? null
      : patch.unfurlDomainAllowlist.map((d) => d.trim().toLowerCase()).filter(Boolean);
  }
  if (patch.googleSelfRegisterDomain !== undefined) {
    if (patch.googleSelfRegisterDomain === null) {
      set.googleSelfRegisterDomain = null;
    } else {
      const domain = patch.googleSelfRegisterDomain.trim().toLowerCase();
      await assertMaySelfRegisterDomain(actorId, domain);
      set.googleSelfRegisterDomain = domain;
    }
  }
  const updated = await db
    .update(workspaces)
    .set(set)
    .where(eq(workspaces.id, workspaceId))
    .returning();
  if (!updated[0]) throw notFound('workspace not found');
  const dto = toWorkspaceDTO(updated[0]);
  publishEvent(subjectMeta(workspaceId), {
    type: 'workspace.updated',
    workspaceId,
    ts: new Date().toISOString(),
    data: dto,
  });
  return toWorkspaceDTO(updated[0], m.role);
}

/**
 * Workspace avatar (#336). Deliberately the *user* avatar pipeline, not the
 * custom-emoji one: the bytes are square-cropped to a small webp and stored
 * under the same `avatars/` blob prefix, so the DTO carries a plain
 * `/v1/avatars/<key>` path that every client already knows how to fetch with
 * its auth header. A file id would have meant new URL plumbing in three
 * clients for an image that renders at 20-40px.
 */
const WORKSPACE_AVATAR_MIMES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** Same rationale as the custom-emoji cap: this is a 20-40px mark, and the
 * cost of a fat one is paid by every client on every render. */
const MAX_WORKSPACE_AVATAR_BYTES = 1024 * 1024;

const WORKSPACE_AVATAR_KEY_RE = /^[0-9a-f-]{36}-\d+\.webp$/;

async function requireWorkspaceAdmin(workspaceId: string, actorId: string) {
  const m = await requireMembership(workspaceId, actorId);
  if (m.role !== 'owner' && m.role !== 'admin') {
    throw forbidden('only owners and admins can change workspace settings');
  }
  return m;
}

/** Best-effort removal of the blob a replaced/cleared avatar pointed at. */
async function dropAvatarBlob(url: string | null): Promise<void> {
  if (!url?.startsWith('/v1/avatars/')) return;
  const key = url.slice('/v1/avatars/'.length);
  if (WORKSPACE_AVATAR_KEY_RE.test(key)) await blobStore().delete(`avatars/${key}`).catch(() => {});
}

async function saveWorkspaceAvatar(
  workspaceId: string,
  role: MemberRole,
  avatarUrl: string | null,
): Promise<WorkspaceDTO> {
  const before = (await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1))[0];
  if (!before) throw notFound('workspace not found');
  const updated = await db
    .update(workspaces)
    .set({ avatarUrl })
    .where(eq(workspaces.id, workspaceId))
    .returning();
  if (!updated[0]) throw notFound('workspace not found');
  await dropAvatarBlob(before.avatarUrl);
  const dto = toWorkspaceDTO(updated[0]);
  // Same broadcast the color picker uses, so every connected client restyles
  // its workspace mark live without a refresh.
  publishEvent(subjectMeta(workspaceId), {
    type: 'workspace.updated',
    workspaceId,
    ts: new Date().toISOString(),
    data: dto,
  });
  return toWorkspaceDTO(updated[0], role);
}

export async function setWorkspaceAvatar(
  workspaceId: string,
  actorId: string,
  data: Buffer,
  mimeType: string,
): Promise<WorkspaceDTO> {
  const m = await requireWorkspaceAdmin(workspaceId, actorId);
  if (!WORKSPACE_AVATAR_MIMES.has(mimeType)) {
    throw badRequest('bad_image', 'workspace avatar must be a PNG, JPEG, GIF or WebP image');
  }
  if (data.length > MAX_WORKSPACE_AVATAR_BYTES) {
    throw badRequest('file_too_large', `workspace avatar must be under ${MAX_WORKSPACE_AVATAR_BYTES / 1024}KB`);
  }
  let webp: Buffer;
  try {
    webp = await sharp(data)
      .resize({ width: config.avatarPx, height: config.avatarPx, fit: 'cover' }) // square crop
      .webp({ quality: 85 })
      .toBuffer();
  } catch {
    throw badRequest('bad_image', 'could not decode image');
  }
  const key = `${workspaceId}-${Date.now()}.webp`;
  await blobStore().put(`avatars/${key}`, webp);
  return saveWorkspaceAvatar(workspaceId, m.role, `/v1/avatars/${key}`);
}

/** Remove: back to the color/initial mark, exactly what a workspace that never
 * had an avatar renders. */
export async function clearWorkspaceAvatar(workspaceId: string, actorId: string): Promise<WorkspaceDTO> {
  const m = await requireWorkspaceAdmin(workspaceId, actorId);
  return saveWorkspaceAvatar(workspaceId, m.role, null);
}

export async function requireMembership(workspaceId: string, userId: string) {
  const rows = await db
    .select()
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
    .limit(1);
  const m = rows[0];
  if (!m) throw notFound('workspace not found'); // don't leak existence
  return m;
}

/** Create workspace: creator becomes owner, #general auto-created (spec §4).
 * `googleSelfRegisterDomain` (phase16 §5a) is offered at creation only to a
 * creator who signed in with Google, and validated the same way as the later
 * PATCH — the client never gets to name a domain that isn't its own. */
export async function createWorkspace(
  userId: string,
  name: string,
  slug: string,
  googleSelfRegisterDomain?: string | null,
): Promise<WorkspaceDTO> {
  // Role guard (AGENTS_DESIGN.md): agents are always plain members — creating
  // a workspace is the only path to owner/admin, so it is closed to them.
  const creator = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  if (creator[0]?.isAgent) throw forbidden('agents cannot create workspaces');
  const domain = googleSelfRegisterDomain ? googleSelfRegisterDomain.trim().toLowerCase() : null;
  if (domain) await assertMaySelfRegisterDomain(userId, domain);
  const wsId = presetWorkspaceId.getStore() ?? newId();
  const chanId = newId();
  // The creator is the organization's owner (platform.md §3.1), with an account and an address from the start.
  const account = await ensureAccount(wsId, userId, 'owner', creator[0]?.displayName ?? '');
  try {
    await db.transaction(async (tx) => {
      await tx
        .insert(workspaces)
        .values({ id: wsId, slug, name, createdBy: userId, googleSelfRegisterDomain: domain });
      await tx.insert(workspaceMembers).values({ workspaceId: wsId, userId, role: 'owner', address: account?.address ?? null, accountId: account?.id ?? null });
      await tx.insert(channels).values({
        id: chanId,
        workspaceId: wsId,
        name: 'general',
        topic: 'This is the beginning of the workspace.',
        createdBy: userId,
      });
      await tx.insert(channelMembers).values({ channelId: chanId, userId });
    });
  } catch (err: unknown) {
    if (isUniqueViolation(err)) throw conflict('slug_taken', 'workspace slug already in use');
    throw err;
  }
  const created = await db.select().from(workspaces).where(eq(workspaces.id, wsId)).limit(1);
  publishWorkspaceJoined(wsId, userId);
  return toWorkspaceDTO(created[0]!, 'owner', undefined, account?.address ?? null);
}

export async function getWorkspace(workspaceId: string, userId: string): Promise<WorkspaceDTO> {
  const m = await requireMembership(workspaceId, userId);
  const rows = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  if (!rows[0]) throw notFound('workspace not found');
  return toWorkspaceDTO(rows[0], m.role);
}

/**
 * Unread notifications per workspace for one user (#345) — the number the
 * sidebar rail badge shows. It counts the same unread rows the Activity feed
 * and the per-channel sidebar numbers count (operator ruling 2026-07-26: a
 * rendered count means "this needs you" — notifications, never raw unread
 * messages), so opening the Activity feed drains it and the three surfaces
 * always agree. One grouped query, served by notifications_unread_channel_idx.
 */
async function unreadByWorkspace(userId: string): Promise<Map<string, number>> {
  const rows = await db
    .select({ workspaceId: channels.workspaceId, n: sql<number>`count(*)` })
    .from(notifications)
    .innerJoin(channels, eq(channels.id, notifications.channelId))
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
    .groupBy(channels.workspaceId);
  return new Map(rows.map((r) => [r.workspaceId, r.n]));
}

/** Whether the user is a member of the workspace (the Workspace app's organization files, packages/docs/server/scope.ts). */
export async function isWorkspaceMember(workspaceId: string, userId: string): Promise<boolean> {
  const rows = await db
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
    .limit(1);
  return rows.length > 0;
}

/** The workspaces the user is a member of, by id and name, oldest membership first: the Workspace app's organizations. */
export async function workspaceNamesOf(userId: string): Promise<Array<{ id: string; name: string }>> {
  return db
    .select({ id: workspaces.id, name: workspaces.name })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(eq(workspaceMembers.userId, userId))
    .orderBy(workspaceMembers.joinedAt);
}

export async function myWorkspaces(userId: string): Promise<WorkspaceDTO[]> {
  const rows = await db
    .select({ w: workspaces, role: workspaceMembers.role, address: workspaceMembers.address })
    .from(workspaceMembers)
    .innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(eq(workspaceMembers.userId, userId))
    .orderBy(workspaceMembers.joinedAt);
  const unread = await unreadByWorkspace(userId);
  return rows.map((r) => toWorkspaceDTO(r.w, r.role, unread.get(r.w.id) ?? 0, r.address));
}

export async function listMembers(workspaceId: string, userId: string): Promise<WorkspaceMemberDTO[]> {
  await requireMembership(workspaceId, userId);
  const rows = await db
    .select({ m: workspaceMembers, u: users })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(eq(workspaceMembers.workspaceId, workspaceId))
    .orderBy(workspaceMembers.joinedAt);
  return rows.map((r) => ({
    userId: r.u.id,
    displayName: r.u.displayName,
    // #489: everyone stays on the roster (mentions, DMs, channel membership
    // all read it) — a privacy-mode member just travels without their address,
    // and carries the flag so the Directory knows to leave them out.
    email: visibleEmail(r.u, userId),
    privacyMode: r.u.privacyMode,
    avatarUrl: r.u.avatarUrl,
    statusEmoji: r.u.statusEmoji,
    statusText: r.u.statusText,
    title: r.u.title,
    isAgent: r.u.isAgent,
    isBot: r.u.isBot,
    // #357: the sponsor who vouched for this agent HERE; pre-#357 rows fall
    // back to the account-level sponsor.
    sponsorId: r.u.isAgent ? r.m.sponsorUserId ?? r.u.sponsorUserId : null,
    role: r.m.role,
    joinedAt: r.m.joinedAt.toISOString(),
    ...(r.m.address ? { address: r.m.address } : {}),
    ...(r.m.accountId ? { accountId: r.m.accountId } : {}),
  }));
}

/** `viewerId` is who will read the DTO — omitted where it goes to a whole
 * workspace (member.joined / member.updated events), which redacts. */
export async function toMemberDTO(
  workspaceId: string,
  userId: string,
  viewerId?: string,
): Promise<WorkspaceMemberDTO> {
  const rows = await db
    .select({ m: workspaceMembers, u: users })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId)))
    .limit(1);
  const r = rows[0];
  if (!r) throw notFound('member not found');
  return {
    userId: r.u.id,
    displayName: r.u.displayName,
    email: visibleEmail(r.u, viewerId),
    privacyMode: r.u.privacyMode,
    avatarUrl: r.u.avatarUrl,
    statusEmoji: r.u.statusEmoji,
    statusText: r.u.statusText,
    title: r.u.title,
    isAgent: r.u.isAgent,
    isBot: r.u.isBot,
    // #357: the sponsor who vouched for this agent HERE; pre-#357 rows fall
    // back to the account-level sponsor.
    sponsorId: r.u.isAgent ? r.m.sponsorUserId ?? r.u.sponsorUserId : null,
    role: r.m.role,
    joinedAt: r.m.joinedAt.toISOString(),
    ...(r.m.address ? { address: r.m.address } : {}),
    ...(r.m.accountId ? { accountId: r.m.accountId } : {}),
  };
}

/**
 * Admin panel: change a member's workspace role. Owner/admin only; the owner
 * role is immutable and can't be assigned here, and you can't change your own
 * role (no accidental self-lockout). Broadcasts member.updated on meta so every
 * client refreshes the roster — and the target's own client re-derives its role
 * (menu gating) from the refreshed workspace list.
 */
export async function setMemberRole(
  workspaceId: string,
  actorId: string,
  targetId: string,
  role: Exclude<MemberRole, 'owner'>,
): Promise<WorkspaceMemberDTO> {
  const actor = await requireMembership(workspaceId, actorId);
  if (actor.role !== 'owner' && actor.role !== 'admin') throw forbidden('only owners and admins can manage members');
  if (targetId === actorId) throw badRequest('self_role', 'you cannot change your own role');
  const target = await requireMembership(workspaceId, targetId);
  if (target.role === 'owner') throw forbidden('the workspace owner role cannot be changed');
  if (role === 'admin' && (await isAgentUser(targetId))) throw agentForbidden('an agent cannot be an admin');
  await db
    .update(workspaceMembers)
    .set({ role })
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, targetId)));
  const dto = await toMemberDTO(workspaceId, targetId);
  publishEvent(subjectMeta(workspaceId), {
    type: 'member.updated',
    workspaceId,
    ts: new Date().toISOString(),
    data: dto,
  });
  return dto;
}

/**
 * Admin panel: remove a member from the workspace (and every channel there).
 * Owner/admin only; the owner can't be removed and you can't remove yourself.
 * Reuses removeMemberDeep, which publishes the member.left cascade.
 *
 * Last-workspace rule (decision_log 2026-07-21): if this was the member's only
 * workspace, the human user is tombstoned in the SAME transaction — deleted_at
 * set and the unique email vacated so the address is free to register again.
 * The row is kept so their past messages keep their author name. Bots/agents
 * are never tombstoned here — they have their own deleteApp / removeAgent
 * lifecycles, and dropping their user row would orphan apps/agent_tokens.
 */
export async function removeMember(workspaceId: string, actorId: string, targetId: string): Promise<void> {
  const actor = await requireMembership(workspaceId, actorId);
  if (actor.role !== 'owner' && actor.role !== 'admin') throw forbidden('only owners and admins can remove members');
  if (targetId === actorId) throw badRequest('self_remove', 'you cannot remove yourself');
  const target = await requireMembership(workspaceId, targetId);
  if (target.role === 'owner') throw forbidden('the workspace owner cannot be removed');
  const [u] = await db
    .select({ isBot: users.isBot, isAgent: users.isAgent, email: users.email })
    .from(users)
    .where(eq(users.id, targetId))
    .limit(1);
  const tombstoneEligible = !!u && !u.isBot && !u.isAgent;
  // Sponsor-departure cascade (AGENT_MEMBERS.md): their agents go with them.
  if (tombstoneEligible) await removeSponsoredAgents(workspaceId, targetId);
  await removeMemberDeep(workspaceId, targetId, async (tx) => {
    // removeMemberDeep has already deleted the target's row for THIS workspace
    // before `also` runs, so any remaining row means they're still elsewhere.
    if (!tombstoneEligible) return;
    const stillMember = await tx
      .select({ one: sql`1` })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, targetId))
      .limit(1);
    if (stillMember.length > 0) return;
    await tombstoneUser(tx, targetId, u.email);
  });
  // Removing an agent here (admin panel) must mean the same as the Agents
  // modal: revoke tokens + kill username/key, or the daemon lingers as an
  // authenticated zombie. Since #357 that is only true once its LAST membership
  // is gone — an agent that still belongs elsewhere keeps working there.
  if (u?.isAgent) {
    const stillMember = await db
      .select({ one: sql`1` })
      .from(workspaceMembers)
      .where(eq(workspaceMembers.userId, targetId))
      .limit(1);
    if (stillMember.length === 0) await killAgentCredentials(targetId);
  }
}

/**
 * Delete a workspace outright (#340 follow-up). Owner only, and only when they
 * are the **last human** in it — the sole owner would otherwise be stuck: they
 * cannot leave (nobody to transfer to) and nothing else can end the workspace.
 * Anyone with company still has to hand ownership over or clear the room first,
 * which keeps this from becoming a way to delete other people's history.
 *
 * Agents and bots do not count as company. They are the owner's own tooling,
 * and making someone remove their own bot before they can close an empty
 * workspace is busywork — but they must be *torn down*, not merely cascaded
 * away: `killAgentCredentials` and the app-row delete are what stop a daemon
 * re-authenticating against a workspace that no longer exists.
 *
 * Everything else rides the `workspaces` row's ON DELETE CASCADE (channels,
 * messages, members, invites, join links, emoji, artifacts, files).
 * Blobs have no cascade, so uploaded files, their thumbnails and the workspace
 * avatar are swept first, best-effort — a failed blob delete must not leave the
 * workspace half-deleted.
 */
export async function deleteWorkspace(workspaceId: string, actorId: string): Promise<void> {
  const m = await requireMembership(workspaceId, actorId);
  if (m.role !== 'owner') throw forbidden('only the workspace owner can delete a workspace');

  const others = await db
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(
      and(
        eq(workspaceMembers.workspaceId, workspaceId),
        ne(workspaceMembers.userId, actorId),
        eq(users.isBot, false),
        eq(users.isAgent, false),
      ),
    )
    .limit(1);
  if (others.length > 0) {
    throw conflict(
      'workspace_not_empty',
      'other members are still in this workspace — remove them or transfer ownership first',
    );
  }

  const [w] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
  if (!w) throw notFound('workspace not found');

  // Machine members first: revoke what they authenticate with while their
  // rows still exist. The cascade would drop the memberships but leave live
  // agent tokens pointing at nothing.
  const machines = await db
    .select({ userId: workspaceMembers.userId, isAgent: users.isAgent })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), ne(workspaceMembers.userId, actorId)));
  for (const machine of machines) {
    if (!machine.isAgent) continue;
    // #357: only the agent's last workspace kills its credentials. One that
    // also serves another workspace must survive this one's deletion.
    const elsewhere = await db
      .select({ one: sql`1` })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.userId, machine.userId), ne(workspaceMembers.workspaceId, workspaceId)))
      .limit(1);
    if (elsewhere.length === 0) await killAgentCredentials(machine.userId);
  }

  // Blobs, before the rows that name them disappear.
  const blobs = await db
    .select({ storageKey: files.storageKey, thumbKey: files.thumbKey })
    .from(files)
    .where(eq(files.workspaceId, workspaceId));
  const store = blobStore();
  for (const b of blobs) {
    await store.delete(b.storageKey).catch(() => {});
    if (b.thumbKey) await store.delete(b.thumbKey).catch(() => {});
  }
  await dropAvatarBlob(w.avatarUrl);

  await db.delete(workspaces).where(eq(workspaces.id, workspaceId));

  // Reuse the departure event rather than minting a new type: to every client
  // "this workspace is gone for me" is the same fact whether it was left or
  // deleted, and that path is already handled on web, macOS and iOS.
  publishEvent(subjectMeta(workspaceId), {
    type: 'member.left',
    workspaceId,
    ts: new Date().toISOString(),
    data: { userId: actorId, workspaceId },
  });
}

/**
 * Self-service departure (#340): the caller removes themselves from
 * `workspaceId`. Same cascade as the admin path — `removeMemberDeep` revokes
 * every channel membership, cleans up dead 1:1 DMs, retires the unread signal
 * and publishes `member.left` — and their messages stay, still attributed.
 *
 * Two deliberate differences from `removeMember` and from `deleteMyAccount`:
 *
 *  - **No tombstone.** Admin removal tombstones a member whose last workspace
 *    this was (decision_log 2026-07-21) — reasonable when someone else is
 *    ending your relationship with the product, wrong when you are only
 *    leaving one room. Leaving your last workspace must not silently delete
 *    your account; the account survives and the client lands on the empty
 *    state.
 *  - **No ownership transfer.** `deleteMyAccount` hands a departing owner's
 *    workspace to the longest-standing admin, because deletion has to be
 *    completable in-app. Leaving does not: the owner is refused and told to
 *    transfer ownership first (#340 leaves that flow for later).
 *
 * The sponsor-departure cascade still applies — the agents you sponsor here go
 * with you (AGENT_MEMBERS.md), same as every other way of leaving.
 */
export async function leaveWorkspace(workspaceId: string, userId: string): Promise<void> {
  const m = await requireMembership(workspaceId, userId);
  if (m.role === 'owner') {
    throw forbidden('the workspace owner cannot leave — transfer ownership first');
  }
  const [u] = await db
    .select({ isBot: users.isBot, isAgent: users.isAgent })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (u?.isBot || u?.isAgent) {
    throw forbidden('agent accounts are removed by their sponsor or a workspace admin');
  }
  await removeSponsoredAgents(workspaceId, userId);
  await removeMemberDeep(workspaceId, userId);
}

/**
 * The owner hands the organization to another person (platform.md §3.1): the target becomes `owner` and the caller
 * `admin`, in one transaction, so there is exactly one owner at every moment. Owner only; the target must be a person
 * who is a member. The directory's owner follows through the outbox (`owner`), and both roles through `join`.
 */
export async function transferWorkspaceOwnership(workspaceId: string, actorId: string, targetId: string): Promise<WorkspaceDTO> {
  const actor = await requireMembership(workspaceId, actorId);
  if (actor.role !== 'owner') throw forbidden('only the workspace owner can transfer ownership');
  if (targetId === actorId) throw badRequest('self_transfer', 'you already own this workspace');
  const target = (
    await db
      .select({ isAgent: users.isAgent, isBot: users.isBot, deletedAt: users.deletedAt })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, targetId)))
      .limit(1)
  )[0];
  if (!target) throw notFound('member not found');
  if (target.isAgent) throw agentForbidden('an agent cannot own an organization');
  if (target.isBot || target.deletedAt) throw badRequest('not_a_person', 'ownership can only go to a person');
  // An owner is never a guest (platform.md §3.3): an admin makes the account native first.
  if ((await accountFor(workspaceId, targetId))?.kind === 'guest') throw conflict('owner_not_guest', 'a guest cannot own an organization — make their account native first');
  await db.transaction(async (tx) => {
    await tx.update(workspaceMembers).set({ role: 'owner' }).where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, targetId)));
    await tx.update(workspaceMembers).set({ role: 'admin' }).where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, actorId)));
  });
  for (const id of [targetId, actorId]) {
    publishEvent(subjectMeta(workspaceId), {
      type: 'member.updated',
      workspaceId,
      ts: new Date().toISOString(),
      data: await toMemberDTO(workspaceId, id),
    });
  }
  return getWorkspace(workspaceId, actorId);
}

// ---- Invites (issue #577: one call, many addresses) ----------------------
//
// A batch must not be all-or-nothing: a typo in the fourth address cannot cost
// the other nine their invite. So the per-address work below reports an outcome
// instead of throwing, and only the legacy single-`email` wrapper turns those
// outcomes back into the conflicts current macOS/iOS clients expect.

/** Same rule zod's `.email()` applies, checked per address so a bad one is a
 * result rather than a 400 for the whole batch. */
function isEmailAddress(email: string): boolean {
  return z.string().email().max(320).safeParse(email).success;
}

/** The invite email (operator request 2026-07-20). Throws on send failure —
 * callers decide what that means. */
async function sendInviteEmail(workspaceId: string, inviterId: string, email: string, token: string): Promise<void> {
  const inviter = (await db.select().from(users).where(eq(users.id, inviterId)).limit(1))[0];
  const wsRow = (await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1))[0];
  await emailSender().send({
    to: email,
    subject: `${inviter?.displayName ?? 'Someone'} invited you to ${wsRow?.name ?? 'a workspace'} on Flow`,
    text:
      `${inviter?.displayName ?? 'Someone'} invited you to join the "${wsRow?.name ?? ''}" workspace on Flow.\n\n` +
      `Accept the invite here:\n\n` +
      `${config.webUrlBase}/invite/${token}\n\n` +
      `If you don't have a Flow account yet, you'll create one first and the ` +
      `invite is applied automatically. This link expires in ${config.inviteTtlDays} days ` +
      `and can only be used once.\n`,
  });
}

/**
 * Invite one address, permission already checked. Never throws for an outcome a
 * caller can report: a malformed address, an existing member, or a failed send
 * all come back as a status.
 *
 * The emailed link is always the web accept URL — the web app walks through
 * register-then-accept — while `inviteUrl` keeps the configured base (a deep
 * link on default local config).
 */
async function inviteOne(workspaceId: string, inviterId: string, rawEmail: string): Promise<InviteResultDTO> {
  const email = rawEmail.trim();
  if (!isEmailAddress(email)) return { email: rawEmail, status: 'invalid_email' };

  const already = await db
    .select({ one: sql`1` })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(users.email, email)))
    .limit(1);
  if (already.length > 0) return { email, status: 'already_member' };

  const token = newToken();
  const id = newId();
  const expiresAt = new Date(Date.now() + config.inviteTtlDays * 86400_000);
  // one pending invite per email: replace any prior (possibly expired) invite.
  // Re-inviting is therefore a resend — a fresh token for the same address, not
  // a duplicate row and not an error.
  const replaced = await db
    .delete(invites)
    .where(and(eq(invites.workspaceId, workspaceId), eq(invites.email, email), isNull(invites.acceptedAt)))
    .returning({ id: invites.id });
  const values = { id, workspaceId, email, tokenHash: hashToken(token), invitedBy: inviterId, expiresAt };
  try {
    await db.insert(invites).values(values);
  } catch (err: unknown) {
    // The pending-unique index fired despite the delete above: a concurrent
    // invite for the same address landed in between. Its raw token was handed
    // to whoever made that call and we cannot return it, so claim the slot —
    // delete again and retry once, and let a second failure surface.
    if (!isUniqueViolation(err)) throw err;
    await db.delete(invites).where(and(eq(invites.workspaceId, workspaceId), eq(invites.email, email), isNull(invites.acceptedAt)));
    await db.insert(invites).values(values);
  }

  // A failed send never fails the invite: the admin still gets the link.
  let emailSent = false;
  try {
    await sendInviteEmail(workspaceId, inviterId, email, token);
    emailSent = true;
  } catch (err) {
    console.error(`invite email failed for ${email}: ${(err as Error).message}`);
  }

  return {
    email,
    status: emailSent ? (replaced.length > 0 ? 'resent' : 'sent') : 'email_failed',
    id,
    inviteUrl: `${config.inviteUrlBase}${token}`,
    expiresAt: expiresAt.toISOString(),
  };
}

/** The gate on inviting, checked once per call: owners and admins, and members too unless the organization's
 * `inviteBy` policy says `admins` (platform.md §3.1). An agent or bot is never let in by the policy. */
async function requireInviteRole(workspaceId: string, inviterId: string): Promise<void> {
  const m = await requireMembership(workspaceId, inviterId);
  if (m.role === 'owner' || m.role === 'admin') return;
  const u = (await db.select({ isAgent: users.isAgent, isBot: users.isBot }).from(users).where(eq(users.id, inviterId)).limit(1))[0];
  if (!u || u.isAgent || u.isBot) throw forbidden('only owners and admins can invite');
  await requirePolicy(workspaceId, inviterId, 'inviteBy', 'invite');
}

/**
 * Owner/admin only. Invites every address independently and reports each one,
 * so a mix of valid, malformed and already-member addresses partially succeeds.
 * Addresses are de-duplicated case-insensitively (emails are citext), so the
 * same person pasted twice gets one invite and one result.
 */
export async function createInvites(workspaceId: string, inviterId: string, emails: string[]): Promise<InviteResultDTO[]> {
  await requireInviteRole(workspaceId, inviterId);
  const seen = new Set<string>();
  const results: InviteResultDTO[] = [];
  for (const raw of emails) {
    const key = raw.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(await inviteOne(workspaceId, inviterId, raw));
  }
  return results;
}

/**
 * Legacy single-address invite (`{ email }`) — the shape current macOS/iOS
 * clients send, unchanged by batching: an already-member address is still a
 * 409, not a result.
 *
 * Returns invite URL with raw token (shown once).
 */
export async function createInvite(workspaceId: string, inviterId: string, email: string): Promise<InviteDTO> {
  await requireInviteRole(workspaceId, inviterId);
  const r = await inviteOne(workspaceId, inviterId, email);
  if (r.status === 'already_member') throw conflict('already_member', 'user is already a member of this workspace');
  // Unreachable through the route (zod validates the legacy `email` field), but
  // the service is called directly by tests and scripts.
  if (r.status === 'invalid_email') throw badRequest('invalid_email', 'not a valid email address');
  return {
    id: r.id!,
    workspaceId,
    email: r.email,
    inviteUrl: r.inviteUrl!,
    expiresAt: r.expiresAt!,
    emailSent: r.status !== 'email_failed',
  };
}

/**
 * Accept an invite → join the workspace + auto-join #general.
 *
 * Two ways in, one row and one code path (#359): the emailed link carries the
 * raw `token`, while an in-app invitation addressed to a known user carries its
 * `inviteId` — its token was minted and hashed but never shown to anyone, so id
 * is the only handle the invitee has. An id only opens the invite addressed to
 * the caller; anything else reads as "not found".
 */
export async function acceptInvite(
  userId: string,
  by: { token?: string | undefined; inviteId?: string | undefined },
): Promise<WorkspaceDTO> {
  const inv = await findInvite(userId, by);
  if (!inv) throw notFound('invite not found');
  if (inv.acceptedAt) throw conflict('invite_used', 'invite already accepted');
  if (inv.declinedAt) throw conflict('invite_declined', 'invite was declined');
  if (inv.expiresAt < new Date()) throw badRequest('invite_expired', 'invite has expired');

  const account = await accountForJoin(inv.workspaceId, userId);
  const joined = await db.transaction(async (tx) => {
    await tx.update(invites).set({ acceptedAt: new Date() }).where(eq(invites.id, inv.id));
    return enrollInWorkspace(tx, inv.workspaceId, userId, 'member', undefined, account);
  });

  if (joined) await announceJoin(inv.workspaceId, userId);
  if (inv.invitedUserId) publishInviteEnded(userId, inv.workspaceId, inv.id);
  const ws = await db.select().from(workspaces).where(eq(workspaces.id, inv.workspaceId)).limit(1);
  return toWorkspaceDTO(ws[0]!, 'member');
}

/**
 * Decline an in-app workspace invitation (#359). Quiet by design: no membership,
 * no announcement, nothing said to the inviter — declining is not a message.
 * The row stays as history and stops blocking a future invite.
 */
export async function declineInvite(userId: string, inviteId: string): Promise<void> {
  const inv = await findInvite(userId, { inviteId });
  if (!inv) throw notFound('invite not found');
  if (inv.acceptedAt) throw conflict('invite_used', 'invite already accepted');
  if (inv.declinedAt) return; // idempotent
  await db.update(invites).set({ declinedAt: new Date() }).where(eq(invites.id, inv.id));
  publishInviteEnded(userId, inv.workspaceId, inv.id);
}

async function findInvite(userId: string, by: { token?: string | undefined; inviteId?: string | undefined }) {
  if (by.token !== undefined) {
    return (await db.select().from(invites).where(eq(invites.tokenHash, hashToken(by.token))).limit(1))[0];
  }
  if (by.inviteId === undefined) return undefined;
  return (
    await db
      .select()
      .from(invites)
      .where(and(eq(invites.id, by.inviteId), eq(invites.invitedUserId, userId)))
      .limit(1)
  )[0];
}

/** Tell the invitee's other sessions the card is gone (accepted or declined). */
function publishInviteEnded(userId: string, workspaceId: string, inviteId: string): void {
  publishEvent(subjectUserNotify(userId), {
    type: 'workspace.invited',
    workspaceId,
    ts: new Date().toISOString(),
    data: { inviteId },
  });
}

// ---- Persistent workspace join links (issue #85) --------------------------
//
// The emailed invite above is one-address, one-use. This is the other half of
// the job Slack splits the same way: a link an admin drops in a doc or a group
// chat and leaves there. Exactly one is live per workspace — generating a new
// one revokes the old — and unlike invites it never expires on its own.

/** The gate shared by every join-link operation: the same rule as invites. */
async function requireInviteRights(workspaceId: string, userId: string): Promise<void> {
  await requireInviteRole(workspaceId, userId);
}

/** The shareable URL: the slug is in there so the link reads as the workspace
 * it joins, not an opaque blob (issue #85). */
function joinUrl(slug: string, token: string): string {
  return `${config.webUrlBase}/join/${slug}/${token}`;
}

async function joinLinkRow(workspaceId: string) {
  return (await db.select().from(workspaceJoinLinks).where(eq(workspaceJoinLinks.workspaceId, workspaceId)).limit(1))[0];
}

/** Owner/admin only. The live link, or `joinUrl: null` when there isn't one. */
export async function getJoinLink(workspaceId: string, userId: string): Promise<JoinLinkDTO> {
  await requireInviteRights(workspaceId, userId);
  const row = await joinLinkRow(workspaceId);
  if (!row) return { workspaceId, joinUrl: null };
  const ws = (await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1))[0]!;
  return {
    workspaceId,
    joinUrl: joinUrl(ws.slug, row.token),
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Owner/admin only. Mint the workspace's join link, replacing any existing one
 * — "one at a time" is the point, so regenerating IS the way to revoke a link
 * that leaked while keeping the door open.
 */
export async function createJoinLink(workspaceId: string, userId: string): Promise<JoinLinkDTO> {
  await requireInviteRights(workspaceId, userId);
  const ws = (await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1))[0];
  if (!ws) throw notFound('workspace not found');
  // Deliberately shorter than the house 32-byte token: this one is read by
  // people, not just machines. See newLinkToken.
  const token = newLinkToken();
  const row = (
    await db
      .insert(workspaceJoinLinks)
      .values({ workspaceId, token, createdBy: userId })
      .onConflictDoUpdate({
        target: workspaceJoinLinks.workspaceId,
        set: { token, createdBy: userId, createdAt: new Date() },
      })
      .returning()
  )[0]!;
  return {
    workspaceId,
    joinUrl: joinUrl(ws.slug, token),
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Owner/admin only. Kills the link outright — the URL 404s from here on.
 * Idempotent: revoking when there is no link is a no-op, not an error. */
export async function revokeJoinLink(workspaceId: string, userId: string): Promise<JoinLinkDTO> {
  await requireInviteRights(workspaceId, userId);
  await db.delete(workspaceJoinLinks).where(eq(workspaceJoinLinks.workspaceId, workspaceId));
  return { workspaceId, joinUrl: null };
}

/**
 * Unauthenticated: name the workspace behind a join link so the landing page
 * can say "Join Acme" before the visitor has an account. Holding the token is
 * the authorization — it already grants membership.
 */
export async function previewJoinLink(token: string): Promise<JoinLinkPreviewDTO> {
  const row = (await db.select().from(workspaceJoinLinks).where(eq(workspaceJoinLinks.token, token)).limit(1))[0];
  if (!row) throw notFound('this join link is no longer valid');
  const ws = (await db.select().from(workspaces).where(eq(workspaces.id, row.workspaceId)).limit(1))[0];
  if (!ws) throw notFound('this join link is no longer valid');
  return { workspaceId: ws.id, slug: ws.slug, name: ws.name };
}

/**
 * Redeem a join link → join the workspace (+ #general), same enrollment path
 * as an invite accept. Idempotent for someone who is already a member: they
 * just land in the workspace, and nobody gets a second "joined" message.
 */
export async function redeemJoinLink(userId: string, token: string): Promise<WorkspaceDTO> {
  const row = (await db.select().from(workspaceJoinLinks).where(eq(workspaceJoinLinks.token, token)).limit(1))[0];
  if (!row) throw notFound('this join link is no longer valid');
  const ws = (await db.select().from(workspaces).where(eq(workspaces.id, row.workspaceId)).limit(1))[0];
  if (!ws) throw notFound('this join link is no longer valid');

  const account = await accountForJoin(ws.id, userId);
  const joined = await db.transaction(async (tx) => enrollInWorkspace(tx, ws.id, userId, 'member', undefined, account));
  if (joined) await announceJoin(ws.id, userId);

  const m = (
    await db
      .select()
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, ws.id), eq(workspaceMembers.userId, userId)))
      .limit(1)
  )[0];
  return toWorkspaceDTO(ws, m?.role ?? 'member');
}

/**
 * The join primitive shared by every path into a workspace that isn't
 * "create it" (invite accept, phase16 domain self-registration): the member row
 * plus #general membership, inside the caller's transaction. Returns false when
 * the user was already a member, so callers can skip announcing a no-op join.
 */
export async function enrollInWorkspace(
  tx: Tx,
  workspaceId: string,
  userId: string,
  role: MemberRole = 'member',
  /** Agents only (#357): who vouched for this agent in THIS workspace. */
  sponsorUserId?: string,
  /** The account's address and id, from `accountForJoin` before the transaction (platform.md §3.2). */
  account?: JoinAccount | null,
): Promise<boolean> {
  const inserted = await tx
    .insert(workspaceMembers)
    .values({ workspaceId, userId, role, sponsorUserId: sponsorUserId ?? null, address: account?.address ?? null, accountId: account?.accountId ?? null })
    .onConflictDoNothing()
    .returning({ userId: workspaceMembers.userId });
  const general = await tx
    .select()
    .from(channels)
    .where(and(eq(channels.workspaceId, workspaceId), eq(channels.name, 'general')))
    .limit(1);
  if (general[0]) {
    await tx.insert(channelMembers).values({ channelId: general[0].id, userId }).onConflictDoNothing();
  }
  return inserted.length > 0;
}

/** Broadcast a completed join: the roster event for everyone, plus the
 * per-user nudge that lets the joiner's live sockets subscribe. */
/** New workspace member: broadcast `member.joined`, subscribe their sockets, and post the #general join line. Call only when the membership row is new. */
export async function announceJoin(workspaceId: string, userId: string, role: MemberRole = 'member'): Promise<void> {
  const u = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  publishEvent(subjectMeta(workspaceId), {
    type: 'member.joined',
    workspaceId,
    ts: new Date().toISOString(),
    data: {
      userId,
      displayName: u[0]?.displayName ?? '',
      // #489: a roster event reaches the whole workspace, so it carries no
      // hidden address.
      email: u[0] ? visibleEmail(u[0]) : '',
      avatarUrl: u[0]?.avatarUrl ?? null,
      isAgent: u[0]?.isAgent ?? false,
      role,
      joinedAt: new Date().toISOString(),
    },
  });
  publishWorkspaceJoined(workspaceId, userId);
  // The enrollment put them in #general silently; say so in the timeline, the
  // same "X joined the channel" line a Browse→Join or an agent's auto-join
  // posts. Best-effort inside postSystemMessage — never aborts the join.
  const general = await db
    .select({ id: channels.id, workspaceId: channels.workspaceId, kind: channels.kind })
    .from(channels)
    .where(and(eq(channels.workspaceId, workspaceId), eq(channels.name, 'general')))
    .limit(1);
  if (general[0]) await postSystemMessage(general[0], userId, 'member_joined');
}

/** Tell the joining user's live sockets so the gateway can subscribe them (they authed before joining). */
function publishWorkspaceJoined(workspaceId: string, userId: string): void {
  publishEvent(subjectUserMeta(userId), {
    type: 'workspace.joined',
    workspaceId,
    ts: new Date().toISOString(),
    data: { userId },
  });
}

export function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505'
    || (typeof err === 'object' && err !== null && 'cause' in err && isUniqueViolation((err as { cause?: unknown }).cause));
}
