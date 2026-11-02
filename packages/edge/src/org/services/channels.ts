import { and, asc, eq, gt, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { HUDDLE_SYSTEM_KINDS } from '@flow/shared';
import type { ChannelDTO, ChannelIndicatorState, ChannelKind, HuddleParticipantDTO, NotifyLevel } from '@flow/shared';
import { db, schema } from '../db/index.js';
import { newId } from '../lib/ids.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { isUniqueViolation, requireMembership } from './workspaces.js';
import { postSystemMessage } from './messages.js';
import {
  clearChannelNotifications,
  clearChannelNotificationsForAll,
  markChannelNotificationsRead,
  markThreadNotificationsRead,
  notifyChannelInvite,
} from './notifications.js';
import { publishEvent, subjectMeta } from '../bus.js';
import { channelIndicators } from '../indicators.js';
import { huddleParticipantsMany, toParticipantDTOs } from '../huddles.js';

const { channels, channelMembers, messages, notifications, workspaceMembers } = schema;

type ChannelRow = typeof channels.$inferSelect;

export function toChannelDTO(
  c: ChannelRow,
  opts: {
    isMember: boolean;
    lastReadMsgId?: string | null | undefined;
    unreadCount?: number | undefined;
    unreadNotifications?: number | undefined;
    unreadThreadRootIds?: string[] | undefined;
    oldestUnreadThreadReply?: { rootId: string; replyId: string } | null | undefined;
    notifyLevel?: number | undefined;
    memberIds?: string[] | undefined;
    indicator?: ChannelIndicatorState | null | undefined;
    huddleParticipants?: HuddleParticipantDTO[] | undefined;
    memberCount?: number | undefined;
  },
): ChannelDTO {
  const dto: ChannelDTO = {
    id: c.id,
    workspaceId: c.workspaceId,
    name: c.name,
    kind: c.kind as ChannelKind,
    topic: c.topic,
    isPrivate: c.isPrivate,
    createdBy: c.createdBy,
    createdAt: c.createdAt.toISOString(),
    archivedAt: c.archivedAt?.toISOString() ?? null,
    isMember: opts.isMember,
    lastReadMsgId: opts.lastReadMsgId ?? null,
    unreadCount: opts.unreadCount ?? 0,
    unreadNotifications: opts.unreadNotifications ?? 0,
    unreadThreadRootIds: opts.unreadThreadRootIds ?? [],
    notifyLevel: (opts.notifyLevel ?? 1) as NotifyLevel,
    parentId: c.parentId,
  };
  // Read straight off the row, unlike indicator/huddle below: the emoji (#396)
  // is a column, so every DTO path already has it and no caller has to pass it.
  // Only sent when there is actually a thread to open (#327): absent means
  // "the main timeline is where the unreads are", which is every other path.
  if (opts.oldestUnreadThreadReply) dto.oldestUnreadThreadReply = opts.oldestUnreadThreadReply;
  if (c.emoji) dto.emoji = c.emoji;
  if (opts.memberIds) dto.memberIds = opts.memberIds;
  if (opts.memberCount !== undefined) dto.memberCount = opts.memberCount;
  // Only sent when something is actually showing: absent means "no spinner",
  // and every other DTO path (create, patch, join…) leaves it out entirely.
  if (opts.indicator) dto.indicator = opts.indicator;
  // Same absent-means-quiet convention as indicator, for the same reason:
  // every other DTO path (create, patch, join…) leaves this out entirely.
  if (opts.huddleParticipants?.length) dto.huddleParticipants = opts.huddleParticipants;
  return dto;
}

/** Member counts for standard channels (#588 browser) — one grouped query. */
async function standardMemberCounts(channelIds: string[]): Promise<Map<string, number>> {
  if (channelIds.length === 0) return new Map();
  const rows = await db
    .select({ channelId: channelMembers.channelId, n: sql<number>`count(*)` })
    .from(channelMembers)
    .where(inArray(channelMembers.channelId, channelIds))
    .groupBy(channelMembers.channelId);
  return new Map(channelIds.map((id) => [id, rows.find((r) => r.channelId === id)?.n ?? 0]));
}

/**
 * Unread top-level messages per joined channel, past each channel's own read
 * cursor, in one grouped query (this was one query per channel, and on a
 * remote database every one of them is a round trip).
 *
 * Membership lines (join/leave) never contribute to unread — they're courtesy
 * notices, not messages you need to catch up on. A *huddle* line is the
 * opposite (#436): "Missed huddle" is the only trace a call you weren't there
 * for leaves, and a missed call that doesn't mark the DM unread is one you
 * never find out about. So the exclusion is by kind, not by "is it a system
 * message". Neither do your own messages count: you can't have unread mail
 * from yourself, and the read cursor may not have caught up if you sent from
 * another client (#71).
 */
async function unreadMessageCounts(
  channelIds: string[],
  userId: string,
): Promise<Map<string, { n: number; oldest: string | null }>> {
  if (channelIds.length === 0) return new Map();
  const rows = await db
    // min() has no uuid overload, so the id goes through text — the hex
    // representation sorts the same way the uuid does.
    .select({
      channelId: messages.channelId,
      n: sql<number>`count(*)`,
      oldest: sql<string | null>`min(${messages.id})`,
    })
    .from(messages)
    .innerJoin(
      channelMembers,
      and(eq(channelMembers.channelId, messages.channelId), eq(channelMembers.userId, userId)),
    )
    .where(
      and(
        inArray(messages.channelId, channelIds),
        isNull(messages.threadRootId),
        isNull(messages.deletedAt),
        or(isNull(messages.systemKind), inArray(messages.systemKind, [...HUDDLE_SYSTEM_KINDS])),
        ne(messages.userId, userId),
        or(isNull(channelMembers.lastReadMsgId), gt(messages.id, channelMembers.lastReadMsgId)),
      ),
    )
    .groupBy(messages.channelId);
  return new Map(rows.map((r) => [r.channelId, { n: r.n, oldest: r.oldest }]));
}

async function dmMemberIds(channelIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (channelIds.length === 0) return out;
  const rows = await db
    .select({ channelId: channelMembers.channelId, userId: channelMembers.userId })
    .from(channelMembers)
    .where(inArray(channelMembers.channelId, channelIds))
    .orderBy(asc(channelMembers.userId));
  for (const r of rows) {
    const list = out.get(r.channelId) ?? [];
    list.push(r.userId);
    out.set(r.channelId, list);
  }
  return out;
}

/**
 * Sub-channels (#118): validate a proposed parent, or throw.
 *
 * None of this is expressible as a foreign key, which is why the column is a
 * bare self-reference and the rules live here. One level only — a child cannot
 * itself be a parent, because arbitrary depth turns the sidebar into a file
 * tree and nothing in the feature asks for that.
 *
 * A DM is a legitimate parent: the motivating case is an agent parking its logs
 * in a sub-channel of the DM it shares with you, so the noise stays next to the
 * conversation instead of in the workspace's channel list.
 */
async function requireValidParent(workspaceId: string, callerId: string, parentId: string): Promise<ChannelRow> {
  const parent = (await db.select().from(channels).where(eq(channels.id, parentId)).limit(1))[0];
  // Same 404 for "no such channel" and "channel in someone else's workspace" —
  // the caller is not a member there and shouldn't learn the id exists.
  if (!parent || parent.workspaceId !== workspaceId) throw notFound('parent channel not found');
  if (parent.archivedAt) throw badRequest('parent_archived', 'cannot nest under an archived channel');
  if (parent.parentId) throw badRequest('parent_is_child', 'sub-channels can only be one level deep');
  // Membership in the parent, not mere visibility: nesting under a channel is a
  // write to it, and for a DM the id alone must not be enough to attach to it.
  const mine = await db
    .select({ userId: channelMembers.userId })
    .from(channelMembers)
    .where(and(eq(channelMembers.channelId, parentId), eq(channelMembers.userId, callerId)))
    .limit(1);
  if (!mine.length) throw forbidden('you must be a member of the parent channel');
  return parent;
}

export async function createChannel(
  workspaceId: string,
  userId: string,
  name: string,
  topic?: string,
  isPrivate?: boolean,
  parentId?: string,
): Promise<ChannelDTO> {
  await requireMembership(workspaceId, userId);
  const parent = parentId ? await requireValidParent(workspaceId, userId, parentId) : undefined;

  // A child of a DM inherits that DM's membership and privacy. Both follow from
  // the same fact: the sub-channel belongs to the conversation, not to the
  // workspace. Seeding members is what makes the agent-logs case work at all —
  // otherwise the agent is alone in the channel it created for your benefit —
  // and forcing private keeps a two-person side-channel out of Browse.
  const underDm = !!parent && parent.kind !== 'standard';
  let memberIds = [userId];
  if (underDm) {
    const rows = await db
      .select({ userId: channelMembers.userId })
      .from(channelMembers)
      .where(eq(channelMembers.channelId, parent!.id));
    memberIds = [...new Set([userId, ...rows.map((r) => r.userId)])].sort();
  }

  const id = newId();
  try {
    await db.transaction(async (tx) => {
      await tx.insert(channels).values({
        id,
        workspaceId,
        name,
        topic: topic ?? null,
        isPrivate: underDm ? true : (isPrivate ?? false),
        createdBy: userId,
        parentId: parentId ?? null,
      });
      await tx.insert(channelMembers).values(memberIds.map((uid) => ({ channelId: id, userId: uid })));
    });
  } catch (err: unknown) {
    if (isUniqueViolation(err)) throw conflict('channel_exists', 'a channel with this name already exists');
    throw err;
  }
  const created = (await db.select().from(channels).where(eq(channels.id, id)).limit(1))[0]!;
  const dto = toChannelDTO(created, { isMember: true });
  const ts = new Date().toISOString();
  publishEvent(subjectMeta(workspaceId), {
    type: 'channel.created',
    workspaceId,
    channelId: id,
    ts,
    data: dto,
  });
  // Same contract as createDm: member.joined refreshes each participant's
  // gateway membership cache and their channel list. Only the seeded case has
  // anyone but the creator to tell.
  if (underDm) {
    for (const uid of memberIds) {
      publishEvent(subjectMeta(workspaceId), {
        type: 'member.joined',
        workspaceId,
        channelId: id,
        ts,
        data: { userId: uid, channelId: id, workspaceId },
      });
    }
  }
  return dto;
}

/**
 * DM upsert (phase2.md §1): one DM channel per member set per workspace.
 * The caller is implicitly a member; dm_key = sorted member ids joined with ':'.
 * Races resolve via the chan_dm_key unique index — loser re-selects the winner.
 */
export async function createDm(workspaceId: string, callerId: string, otherUserIds: string[]): Promise<ChannelDTO> {
  await requireMembership(workspaceId, callerId);
  const memberIds = [...new Set([callerId, ...otherUserIds])].sort();
  // every target must be a workspace member
  const memRows = await db
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), inArray(workspaceMembers.userId, memberIds)));
  if (memRows.length !== memberIds.length) {
    throw badRequest('bad_user', 'all DM recipients must be members of this workspace');
  }
  const dmKey = memberIds.join(':');
  const kind: ChannelKind = memberIds.length <= 2 ? 'dm' : 'group_dm';

  const fetchExisting = async (): Promise<ChannelRow | undefined> =>
    (
      await db
        .select()
        .from(channels)
        .where(and(eq(channels.workspaceId, workspaceId), eq(channels.dmKey, dmKey)))
        .limit(1)
    )[0];

  const existing = await fetchExisting();
  if (existing) {
    const mem = await db
      .select({ lastReadMsgId: channelMembers.lastReadMsgId, notifyLevel: channelMembers.notifyLevel })
      .from(channelMembers)
      .where(and(eq(channelMembers.channelId, existing.id), eq(channelMembers.userId, callerId)))
      .limit(1);
    return toChannelDTO(existing, {
      isMember: true,
      lastReadMsgId: mem[0]?.lastReadMsgId,
      notifyLevel: mem[0]?.notifyLevel,
      memberIds,
    });
  }

  const id = newId();
  try {
    await db.transaction(async (tx) => {
      await tx.insert(channels).values({
        id,
        workspaceId,
        name: null,
        kind,
        dmKey,
        isPrivate: true, // always private (phase2.md §1)
        createdBy: callerId,
      });
      await tx.insert(channelMembers).values(memberIds.map((uid) => ({ channelId: id, userId: uid })));
    });
  } catch (err: unknown) {
    if (isUniqueViolation(err)) {
      const winner = await fetchExisting();
      if (winner) return toChannelDTO(winner, { isMember: true, memberIds });
    }
    throw err;
  }

  const created = (await db.select().from(channels).where(eq(channels.id, id)).limit(1))[0]!;
  const dto = toChannelDTO(created, { isMember: true, memberIds });
  const ts = new Date().toISOString();
  // channel.created tells the creator's sockets; member.joined (one per member)
  // updates every participant's gateway membership cache and prompts clients to
  // refresh their channel list (same contract as channel joins).
  publishEvent(subjectMeta(workspaceId), {
    type: 'channel.created',
    workspaceId,
    channelId: id,
    ts,
    data: dto,
  });
  for (const uid of memberIds) {
    publishEvent(subjectMeta(workspaceId), {
      type: 'member.joined',
      workspaceId,
      channelId: id,
      ts,
      data: { userId: uid, channelId: id, workspaceId },
    });
  }
  return dto;
}

/** Joined + public channels of a workspace, with unread counts for joined ones. */
/**
 * The caller's channel list. `includeArchived` (#588, the channel browser) adds
 * archived *public standard* channels — read-only by design, so they carry no
 * unreads, spinners or huddles, and private/DM archives stay hidden.
 */
export async function listChannels(
  workspaceId: string,
  userId: string,
  opts: { includeArchived?: boolean } = {},
): Promise<ChannelDTO[]> {
  // The membership check and the list go out together; a non-member's
  // rejection still throws before anything from the list is returned.
  const [, rows] = await Promise.all([
    requireMembership(workspaceId, userId),
    db
      .select({
        c: channels,
        lastReadMsgId: channelMembers.lastReadMsgId,
        notifyLevel: channelMembers.notifyLevel,
        isMember: sql<boolean>`(${channelMembers.userId} IS NOT NULL)`,
      })
      .from(channels)
      .leftJoin(
        channelMembers,
        and(eq(channelMembers.channelId, channels.id), eq(channelMembers.userId, userId)),
      )
      .where(
        opts.includeArchived
          ? eq(channels.workspaceId, workspaceId)
          : and(eq(channels.workspaceId, workspaceId), isNull(channels.archivedAt)),
      )
      .orderBy(channels.name),
  ]);

  const visible = rows.filter((r) =>
    r.c.archivedAt ? r.c.kind === 'standard' && !r.c.isPrivate : !r.c.isPrivate || r.isMember,
  );
  const dmIds = visible.filter((r) => r.c.kind !== 'standard').map((r) => r.c.id);
  const liveJoinedIds = visible.filter((r) => r.isMember && !r.c.archivedAt).map((r) => r.c.id);

  // Everything below depends only on the rows above, so it goes out together:
  // each query is sub-millisecond in Postgres, and what a sequential chain
  // costs is one network round trip apiece.
  const [dmMembers, memberCounts, notifRows, threadRootRows, unreadByChannel] = await Promise.all([
    dmMemberIds(dmIds),
    standardMemberCounts(visible.filter((r) => r.c.kind === 'standard').map((r) => r.c.id)),
    // Unread notifications per channel — the number the sidebar badge shows
    // (operator ruling 2026-07-26; unread *messages* only embolden the row).
    // One grouped query for the whole list, served by notifications_unread_channel_idx.
    db
      .select({ channelId: notifications.channelId, n: sql<number>`count(*)` })
      .from(notifications)
      .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)))
      .groupBy(notifications.channelId),
    // Which threads are waiting on this user (#270) — the reply chip draws an
    // unread dot from this, so a thread reply that needs you is visible in the
    // transcript and not only in the sidebar number. One grouped query over the
    // same unread rows; thread notifications are few, so the lists stay short.
    // The reply id rides along (#327) so the same rows answer "which thread holds
    // the oldest unread reply" — ids are UUIDv7, so oldest-first is id order.
    db
      .select({ channelId: notifications.channelId, rootId: messages.threadRootId, replyId: messages.id })
      .from(notifications)
      .innerJoin(messages, eq(messages.id, notifications.messageId))
      .where(
        and(
          eq(notifications.userId, userId),
          isNull(notifications.readAt),
          sql`${messages.threadRootId} IS NOT NULL`,
        ),
      )
      .orderBy(asc(messages.id)),
    unreadMessageCounts(liveJoinedIds, userId),
  ]);
  const notifByChannel = new Map(notifRows.map((r) => [r.channelId, r.n]));

  const threadRootsByChannel = new Map<string, string[]>();
  const oldestUnreadReplyByChannel = new Map<string, { rootId: string; replyId: string }>();
  for (const r of threadRootRows) {
    if (!r.rootId) continue;
    const seen = threadRootsByChannel.get(r.channelId) ?? [];
    if (!seen.includes(r.rootId)) threadRootsByChannel.set(r.channelId, [...seen, r.rootId]);
    if (!oldestUnreadReplyByChannel.has(r.channelId)) {
      oldestUnreadReplyByChannel.set(r.channelId, { rootId: r.rootId, replyId: r.replyId });
    }
  }

  // Live activity spinners (#137) — in-memory, so this is a map lookup, not a
  // query. Riding the channel list means a client that just loaded (or came
  // back from a refresh) starts in the right state without a second call.
  const indicators = channelIndicators(visible.map((r) => r.c.id));
  // Live huddle rosters (Phase 1) — same reasoning: a map lookup, not a query,
  // so a client that just loaded shows an already-active huddle immediately.
  const huddles = huddleParticipantsMany(visible.map((r) => r.c.id));

  const result: ChannelDTO[] = [];
  for (const r of visible) {
    const archived = r.c.archivedAt !== null;
    let unreadCount = 0;
    let oldestUnreadTopLevel: string | null = null;
    if (r.isMember && !archived) {
      const unread = unreadByChannel.get(r.c.id);
      unreadCount = unread?.n ?? 0;
      oldestUnreadTopLevel = unread?.oldest ?? null;
    }
    // Auto-open target (#327): only when the channel's oldest unread is a reply.
    // An older unread top-level message means the main timeline already shows
    // the user what they missed, so the thread waits its turn (its chip keeps
    // the unread dot either way).
    const live = r.isMember && !archived;
    const oldestReply = live ? (oldestUnreadReplyByChannel.get(r.c.id) ?? null) : null;
    const oldestUnreadThreadReply =
      oldestReply && (!oldestUnreadTopLevel || oldestReply.replyId < oldestUnreadTopLevel)
        ? oldestReply
        : null;
    result.push(
      toChannelDTO(r.c, {
        isMember: r.isMember,
        lastReadMsgId: r.lastReadMsgId,
        unreadCount,
        unreadNotifications: live ? (notifByChannel.get(r.c.id) ?? 0) : 0,
        unreadThreadRootIds: live ? (threadRootsByChannel.get(r.c.id) ?? []) : [],
        oldestUnreadThreadReply,
        notifyLevel: r.notifyLevel ?? 1,
        memberIds: r.c.kind !== 'standard' ? (dmMembers.get(r.c.id) ?? []) : undefined,
        memberCount: memberCounts.get(r.c.id),
        indicator: archived ? null : (indicators.get(r.c.id) ?? null),
        huddleParticipants: archived ? [] : toParticipantDTOs(huddles.get(r.c.id) ?? []),
      }),
    );
  }
  return result;
}

/**
 * Channel access rule (spec §4 permissions): workspace member required;
 * private channels additionally require channel membership.
 */
export async function requireChannelAccess(channelId: string, userId: string) {
  const rows = await db.select().from(channels).where(eq(channels.id, channelId)).limit(1);
  const chan = rows[0];
  if (!chan) throw notFound('channel not found');
  await requireMembership(chan.workspaceId, userId);
  const mem = await db
    .select()
    .from(channelMembers)
    .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.userId, userId)))
    .limit(1);
  const isMember = mem.length > 0;
  if (chan.isPrivate && !isMember) throw notFound('channel not found'); // don't leak private channels
  return { chan, isMember };
}

/** Member user ids of a channel the caller can access (mention CTA, invite lists). */
export async function listMemberIds(channelId: string, callerId: string): Promise<string[]> {
  await requireChannelAccess(channelId, callerId);
  const rows = await db
    .select({ userId: channelMembers.userId })
    .from(channelMembers)
    .where(eq(channelMembers.channelId, channelId));
  return rows.map((r) => r.userId);
}

export async function joinChannel(channelId: string, userId: string): Promise<ChannelDTO> {
  const { chan, isMember } = await requireChannelAccess(channelId, userId);
  if (chan.kind !== 'standard') throw badRequest('dm_channel', 'cannot join a DM via channel endpoints');
  if (chan.archivedAt) throw badRequest('channel_archived', 'channel is archived');
  if (chan.isPrivate && !isMember) throw forbidden('cannot join a private channel without an invite');
  if (!isMember) {
    await db.insert(channelMembers).values({ channelId, userId }).onConflictDoNothing();
    publishEvent(subjectMeta(chan.workspaceId), {
      type: 'member.joined',
      workspaceId: chan.workspaceId,
      channelId,
      ts: new Date().toISOString(),
      data: { userId, channelId, workspaceId: chan.workspaceId },
    });
    await postSystemMessage(chan, userId, 'member_joined');
  }
  return toChannelDTO(chan, { isMember: true });
}

/**
 * Invite/add a member (phase2.md §5): private channels → any existing channel
 * member may add; public channels → any workspace member may add. Target must
 * be a workspace member. DMs never gain members this way (a wider group DM is
 * a new channel, §1).
 */
export async function addMember(channelId: string, actorId: string, targetUserId: string): Promise<void> {
  const { chan, isMember } = await requireChannelAccess(channelId, actorId);
  if (chan.kind !== 'standard') throw badRequest('dm_channel', 'DM membership is fixed; start a new group DM instead');
  if (chan.archivedAt) throw badRequest('channel_archived', 'channel is archived');
  if (chan.isPrivate && !isMember) throw forbidden('only channel members can invite to a private channel');
  const target = await db
    .select({ userId: workspaceMembers.userId })
    .from(workspaceMembers)
    .where(and(eq(workspaceMembers.workspaceId, chan.workspaceId), eq(workspaceMembers.userId, targetUserId)))
    .limit(1);
  if (!target[0]) throw badRequest('bad_user', 'user is not a member of this workspace');
  const inserted = await db
    .insert(channelMembers)
    .values({ channelId, userId: targetUserId })
    .onConflictDoNothing()
    .returning();
  if (inserted.length > 0) {
    publishEvent(subjectMeta(chan.workspaceId), {
      type: 'member.joined',
      workspaceId: chan.workspaceId,
      channelId,
      ts: new Date().toISOString(),
      data: { userId: targetUserId, channelId, workspaceId: chan.workspaceId },
    });
    // #303: the join line is the notification's anchor and its tap
    // destination, so the notification follows it rather than racing it.
    const line = await postSystemMessage(chan, targetUserId, 'member_joined');
    if (line) await notifyChannelInvite(chan, line, targetUserId, actorId);
  }
}

/**
 * Remove a member (phase2.md §5): self-removal is "leave"; removing someone
 * else requires workspace admin/owner (with channel access). Leaving is
 * allowed for group DMs but not 1:1 DMs (§1).
 */
export async function removeMember(channelId: string, actorId: string, targetUserId: string): Promise<void> {
  const { chan, isMember } = await requireChannelAccess(channelId, actorId);
  const self = actorId === targetUserId;
  if (chan.kind === 'dm') throw badRequest('dm_channel', 'cannot leave a 1:1 DM');
  if (chan.kind === 'group_dm' && !self) throw forbidden('group DM members can only remove themselves');
  if (self) {
    if (!isMember) throw badRequest('not_member', 'not a member of this channel');
    if (chan.kind === 'standard' && chan.name === 'general') throw badRequest('general_channel', 'cannot leave #general');
  } else {
    const actor = await requireMembership(chan.workspaceId, actorId);
    if (actor.role !== 'owner' && actor.role !== 'admin') throw forbidden('only owners and admins can remove members');
  }
  const deleted = await db
    .delete(channelMembers)
    .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.userId, targetUserId)))
    .returning();
  if (deleted.length > 0) {
    // Losing access retires the unread signal: these rows could never clear by
    // visiting again, so they'd count in Activity forever (issue #63 review).
    await clearChannelNotifications(targetUserId, chan);
    publishEvent(subjectMeta(chan.workspaceId), {
      type: 'member.left',
      workspaceId: chan.workspaceId,
      channelId,
      ts: new Date().toISOString(),
      data: { userId: targetUserId, channelId, workspaceId: chan.workspaceId },
    });
    await postSystemMessage(chan, targetUserId, 'member_left');
  }
}

/**
 * Rename / set topic (ui_nits item 5). Any channel member may edit — matches
 * Slack's default and the codebase's permissive rule for non-destructive ops
 * (decision_log 2026-07-19). Empty topic clears it; #general keeps its name.
 */
export async function updateChannel(
  channelId: string,
  actorId: string,
  patch: { name?: string | undefined; topic?: string | undefined },
): Promise<ChannelDTO> {
  const { chan, isMember } = await requireChannelAccess(channelId, actorId);
  if (chan.kind !== 'standard') throw badRequest('dm_channel', 'DMs have no name or topic');
  if (chan.archivedAt) throw badRequest('channel_archived', 'channel is archived');
  if (!isMember) throw forbidden('join the channel first');
  if (patch.name !== undefined && chan.name === 'general' && patch.name !== 'general') {
    throw badRequest('general_channel', 'cannot rename #general');
  }
  const set: { name?: string; topic?: string | null } = {};
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.topic !== undefined) set.topic = patch.topic === '' ? null : patch.topic;
  let updated: ChannelRow;
  try {
    updated = (await db.update(channels).set(set).where(eq(channels.id, channelId)).returning())[0]!;
  } catch (err: unknown) {
    if (isUniqueViolation(err)) throw conflict('channel_exists', 'a channel with this name already exists');
    throw err;
  }
  const dto = toChannelDTO(updated, { isMember });
  publishEvent(subjectMeta(chan.workspaceId), {
    type: 'channel.updated',
    workspaceId: chan.workspaceId,
    channelId,
    ts: new Date().toISOString(),
    data: dto,
  });
  return dto;
}

/** Archive (phase2.md §5): workspace admin/owner or the channel creator. Read-only afterwards. */
export async function archiveChannel(channelId: string, actorId: string): Promise<ChannelDTO> {
  const { chan, isMember } = await requireChannelAccess(channelId, actorId);
  if (chan.kind !== 'standard') throw badRequest('dm_channel', 'DMs cannot be archived');
  if (chan.name === 'general') throw badRequest('general_channel', 'cannot archive #general');
  const actor = await requireMembership(chan.workspaceId, actorId);
  const allowed = actor.role === 'owner' || actor.role === 'admin' || chan.createdBy === actorId;
  if (!allowed) throw forbidden('only owners, admins, or the channel creator can archive');
  if (chan.archivedAt) return toChannelDTO(chan, { isMember }); // idempotent
  const updated = await db
    .update(channels)
    .set({ archivedAt: new Date() })
    .where(eq(channels.id, channelId))
    .returning();
  const dto = toChannelDTO(updated[0]!, { isMember });
  // An archived channel leaves the sidebar, so its unread rows would count in
  // Activity forever with no visit to clear them — retire them for everyone.
  await clearChannelNotificationsForAll(updated[0]!);
  publishEvent(subjectMeta(chan.workspaceId), {
    type: 'channel.archived',
    workspaceId: chan.workspaceId,
    channelId,
    ts: new Date().toISOString(),
    data: dto,
  });
  return dto;
}

/** Per-user notify level (operator ruling, decision log 2026-07-18): 0=mute 1=mentions 2=all. */
export async function setNotifyLevel(channelId: string, userId: string, level: 0 | 1 | 2): Promise<void> {
  const { isMember } = await requireChannelAccess(channelId, userId);
  if (!isMember) throw forbidden('join the channel first');
  await db
    .update(channelMembers)
    .set({ notifyLevel: level })
    .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.userId, userId)));
}

/**
 * Advance the read cursor. Reading a channel also reads the notifications it
 * raised (issue #63) — `threadRootId` means "I'm looking at this thread", which
 * clears the thread's rows without moving the channel cursor (it only tracks
 * top-level messages).
 */
export async function markRead(
  channelId: string,
  userId: string,
  lastReadMsgId: string,
  threadRootId?: string,
): Promise<void> {
  const { chan, isMember } = await requireChannelAccess(channelId, userId);
  if (!isMember) throw forbidden('join the channel first');
  if (threadRootId) {
    await markThreadNotificationsRead(userId, chan, threadRootId);
    return;
  }
  // Forward only. A revisit (#533) re-sends the cursor the client already has,
  // which on a stale channel row can be older than the one the server holds —
  // and rewinding it would un-read messages the user has demonstrably seen.
  await db
    .update(channelMembers)
    .set({ lastReadMsgId })
    .where(
      and(
        eq(channelMembers.channelId, channelId),
        eq(channelMembers.userId, userId),
        or(isNull(channelMembers.lastReadMsgId), lt(channelMembers.lastReadMsgId, lastReadMsgId)),
      ),
    );
  await markChannelNotificationsRead(userId, chan, lastReadMsgId);
}
