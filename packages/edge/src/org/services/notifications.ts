// Mentions + notifications (phase2.md §4, plus operator ruling adding group
// mentions — decision log 2026-07-18; phase 10 adds per-user alert prefs,
// status suppression, and the mention subkind).
//
// Notification rows are written in the same transaction as the message; events
// are published after commit on the per-user subject user.{userId}.notify
// (approved deviation from the workspace-scoped subject in the spec).
//
// Kinds: 0=mention (user or group mention), 1=dm, 2=thread_reply,
// 3=channel activity (notify_level=all), 4=reaction on one of my messages,
// 5=someone added me to a channel (#303).
// Precedence when a message qualifies a user several ways: dm > mention >
// thread_reply > activity — one row per (user, message). notify_level 0 (mute)
// suppresses everything, including DMs.
//
// Phase 10: rows are ALWAYS written — per-user prefs and status suppression
// only gate OS *alerts* (suppressAlert on the DTO), never the inbox.
//
// Issue #63: rows also carry their actor (message author, or the reactor for
// kind 4), and they go read either from the Activity feed or implicitly when
// the user visits the channel/thread they came from — see
// markChannelNotificationsRead / markThreadNotificationsRead. Every read path
// publishes `notification.read` with the fresh unread total so the native
// badges converge without polling.
import { and, desc, eq, isNull, lte, sql } from 'drizzle-orm';
import {
  GROUP_MENTION_RE,
  type NotificationDTO,
  type NotificationKind,
  type NotificationPage,
  type NotificationPrefs,
  type NotificationSubkind,
} from '@flow/shared';
import { db, schema, type Tx } from '../db/index.js';
import { newId } from '../lib/ids.js';
import { badRequest } from '../lib/errors.js';
import { publishEvent, subjectUserNotify } from '../bus.js';
import { isOnline } from '../presence.js';
import { toMessageDTO, type HydratedMessageRow } from './messages.js';
import { queueBadgeSync } from './badgeSync.js';
import { enqueuePendingPush } from './pushOutbox.js';
import { inList } from '../sqlList.js';

const { notifications, channelMembers, workspaceMembers, messages, channels, users } = schema;

type ChannelRow = typeof channels.$inferSelect;

export interface PlannedNotification {
  id: string;
  userId: string;
  kind: NotificationKind;
  subkind: NotificationSubkind | null;
}

/**
 * What a read pass flipped, plus the fresh unread total (badge source).
 * `unreadCount` is null when the pass was a no-op and the caller didn't need
 * the number — the channel read path runs on every cursor bump, so it doesn't
 * pay for a count it has nothing to publish with.
 */
interface ReadResult {
  ids: string[];
  unreadCount: number | null;
}

interface RecipientPlan {
  kind: NotificationKind;
  subkind: NotificationSubkind | null;
}

/** Prefs + status flag feeding the suppressAlert computation, per recipient. */
export interface AlertContext {
  prefs: NotificationPrefs;
  statusSuppressAlerts: boolean;
}

/**
 * The alert gate (phase 10). Rows exist regardless — this decides OS banners.
 * kind 3 (channel activity) never alerts; a suppressing status wins over
 * everything; legacy null subkind reads as a direct mention.
 */
export function suppressAlertFor(
  kind: NotificationKind,
  subkind: NotificationSubkind | null,
  ctx: AlertContext,
): boolean {
  if (kind === 3) return true;
  if (ctx.statusSuppressAlerts) return true;
  const key =
    kind === 1
      ? 'dm'
      : kind === 2
        ? 'threadReply'
        : kind === 4
          ? 'reaction'
          : kind === 5
            ? 'channelInvite'
            : subkind === 'here' || subkind === 'channel'
              ? 'groupMention'
              : 'mention';
  return ctx.prefs[key] === false;
}

/**
 * Decide who gets notified for a new message. Pure planning — no writes.
 * Also returns each recipient's alert context (prefs + status flag) so the
 * post-commit fan-out can compute suppressAlert without a second query.
 * @param mentions resolved user ids from the client (spec: server only validates
 *   workspace membership — no fuzzy name matching). Throws 400 on ids that are
 *   not workspace members; silently skips users who cannot see the channel.
 */
export async function computeRecipients(
  chan: ChannelRow,
  senderId: string,
  body: string,
  mentions: string[],
  threadRootId?: string,
): Promise<{ recipients: Map<string, RecipientPlan>; alertContext: Map<string, AlertContext> }> {
  // channel membership + notify levels in one query
  const memberRows = await db
    .select({ userId: channelMembers.userId, notifyLevel: channelMembers.notifyLevel })
    .from(channelMembers)
    .where(eq(channelMembers.channelId, chan.id));
  const memberLevel = new Map(memberRows.map((r) => [r.userId, r.notifyLevel]));

  const muted = (uid: string): boolean => memberLevel.get(uid) === 0;
  // priority: lower number wins (dm strongest). Kind 5 (channel invite) is
  // never proposed here — it isn't caused by a message — but the Record has to
  // be total, so it sits last.
  const PRIORITY: Record<NotificationKind, number> = { 1: 0, 0: 1, 2: 2, 3: 3, 4: 4, 5: 5 };
  const out = new Map<string, RecipientPlan>();
  const propose = (uid: string, kind: NotificationKind, subkind: NotificationSubkind | null = null): void => {
    if (uid === senderId || muted(uid)) return;
    const cur = out.get(uid);
    // direct mention beats a group mention for the same user in the same message
    if (cur === undefined || PRIORITY[kind] < PRIORITY[cur.kind]) out.set(uid, { kind, subkind });
  };

  if (chan.kind !== 'standard') {
    // any DM message notifies every other member (kind 1). Your personal DM
    // (a "DM" whose only member is you) therefore never notifies — `propose`
    // drops the sender, and there is nobody else (issue #63).
    for (const [uid] of memberLevel) propose(uid, 1);
    return finish(out);
  }

  // user mentions: validate workspace membership (400 on strangers)
  const uniqueMentions = [...new Set(mentions)];
  if (uniqueMentions.length > 0) {
    const wsRows = await db
      .select({ userId: workspaceMembers.userId })
      .from(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, chan.workspaceId), inList(workspaceMembers.userId, uniqueMentions)));
    const wsSet = new Set(wsRows.map((r) => r.userId));
    for (const uid of uniqueMentions) {
      if (!wsSet.has(uid)) throw badRequest('bad_mention', `mentioned user ${uid} is not a workspace member`);
      // private channels: only members can be notified (no membership leak)
      if (chan.isPrivate && !memberLevel.has(uid)) continue;
      propose(uid, 0, 'mention');
    }
  }

  // group mentions (operator ruling): <!channel>/<!everyone> → all channel
  // members; <!here> → currently-online channel members (single-node presence)
  const groupTokens = new Set([...body.matchAll(GROUP_MENTION_RE)].map((m) => m[1]));
  if (groupTokens.has('channel') || groupTokens.has('everyone')) {
    for (const [uid] of memberLevel) propose(uid, 0, 'channel');
  } else if (groupTokens.has('here')) {
    // online *in this workspace* (#364): a member connected only to another
    // workspace is not here.
    for (const [uid] of memberLevel) if (isOnline(uid, chan.workspaceId)) propose(uid, 0, 'here');
  }

  // thread replies notify prior participants (root author + repliers) who are
  // still channel members
  if (threadRootId) {
    const participants = await db
      .select({ userId: messages.userId })
      .from(messages)
      .where(
        and(
          sql`(${messages.id} = ${threadRootId} OR ${messages.threadRootId} = ${threadRootId})`,
          isNull(messages.deletedAt),
        ),
      )
      .groupBy(messages.userId);
    for (const p of participants) {
      if (memberLevel.has(p.userId)) propose(p.userId, 2);
    }
  }

  // notify_level=all: every message in the channel
  for (const [uid, level] of memberLevel) {
    if (level === 2) propose(uid, 3);
  }

  return finish(out);
}

/** One user's alert context (prefs + status flag). */
async function alertContextFor(userId: string): Promise<AlertContext> {
  const row = (
    await db
      .select({ prefs: users.notificationPrefs, suppress: users.statusSuppressAlerts })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1)
  )[0];
  return { prefs: row?.prefs ?? {}, statusSuppressAlerts: row?.suppress ?? false };
}

/** Load each recipient's alert context (prefs + status flag) in one query. */
async function finish(out: Map<string, RecipientPlan>): Promise<{
  recipients: Map<string, RecipientPlan>;
  alertContext: Map<string, AlertContext>;
}> {
  const ids = [...out.keys()];
  const rows = ids.length
    ? await db
        .select({ id: users.id, prefs: users.notificationPrefs, suppress: users.statusSuppressAlerts })
        .from(users)
        .where(inList(users.id, ids))
    : [];
  const alertContext = new Map<string, AlertContext>(
    rows.map((r) => [r.id, { prefs: r.prefs, statusSuppressAlerts: r.suppress }]),
  );
  return { recipients: out, alertContext };
}

/** Insert planned rows inside the message's transaction (phase2.md §4). */
export async function insertNotifications(
  tx: Tx,
  recipients: Map<string, RecipientPlan>,
  messageId: string,
  channelId: string,
  actorId: string,
): Promise<PlannedNotification[]> {
  const planned: PlannedNotification[] = [...recipients].map(([userId, p]) => ({ id: newId(), userId, ...p }));
  if (planned.length > 0) {
    await tx.insert(notifications).values(
      planned.map((p) => ({
        id: p.id,
        userId: p.userId,
        messageId,
        channelId,
        kind: p.kind,
        subkind: p.subkind,
        actorId,
      })),
    );
    // Push rides the same transaction (#247): a notification row that commits
    // without its outbox row is a push the phone never gets, and there is no
    // backfill path to recover it.
    await enqueuePendingPush(
      tx,
      planned.map((p) => ({ userId: p.userId, notificationId: p.id })),
    );
  }
  return planned;
}

/** Post-commit fan-out on the per-user notify subject. */
export function publishNotifications(
  planned: PlannedNotification[],
  alertContext: Map<string, AlertContext>,
  message: import('@flow/shared').MessageDTO,
  workspaceId: string,
  ts: string,
): void {
  for (const p of planned) {
    const ctx = alertContext.get(p.userId) ?? { prefs: {}, statusSuppressAlerts: false };
    const dto: NotificationDTO = {
      id: p.id,
      userId: p.userId,
      messageId: message.id,
      channelId: message.channelId,
      workspaceId,
      kind: p.kind,
      actorId: message.userId,
      reactionEmoji: null,
      subkind: p.subkind,
      suppressAlert: suppressAlertFor(p.kind, p.subkind, ctx),
      createdAt: ts,
      readAt: null,
      message,
    };
    publishEvent(subjectUserNotify(p.userId), {
      type: 'notification.created',
      workspaceId,
      channelId: message.channelId,
      ts,
      data: dto,
    });
  }
}

/**
 * GET /v1/me/notifications — newest first, cursor on id. The embedded message
 * preview carries the decrypted body but empty reactions/files (list rendering
 * doesn't need them; the channel view hydrates fully).
 */
export async function listNotifications(
  userId: string,
  before: string | undefined,
  limit: number,
  workspaceId?: string | undefined,
): Promise<NotificationPage> {
  const conds = [eq(notifications.userId, userId)];
  if (before) conds.push(sql`${notifications.id} < ${before}`);
  // Activity lives inside a workspace's sidebar, so it shows that workspace's
  // rows only. The notifications table has no workspace column — the channel
  // join that already hydrates workspaceId carries the predicate too.
  if (workspaceId) conds.push(eq(channels.workspaceId, workspaceId));
  const me = (await db.select({ prefs: users.notificationPrefs, suppress: users.statusSuppressAlerts }).from(users).where(eq(users.id, userId)).limit(1))[0];
  const ctx: AlertContext = { prefs: me?.prefs ?? {}, statusSuppressAlerts: me?.suppress ?? false };
  const rows = await db
    .select({ n: notifications, m: messages, workspaceId: channels.workspaceId })
    .from(notifications)
    .innerJoin(messages, eq(messages.id, notifications.messageId))
    .innerJoin(channels, eq(channels.id, notifications.channelId))
    .where(and(...conds))
    .orderBy(desc(notifications.id))
    .limit(limit + 1);
  const hasMore = rows.length > limit;
  // Two counts: the scoped one badges Activity inside this workspace, the total
  // badges the app icon (which must still speak for other workspaces).
  const [scopedUnread, totalUnread] = await Promise.all([
    unreadCount(userId, workspaceId),
    workspaceId ? unreadCount(userId) : undefined,
  ]);
  return {
    notifications: rows.slice(0, limit).map((r) => {
      const kind = r.n.kind as NotificationKind;
      const subkind = r.n.subkind as NotificationSubkind | null;
      return {
        id: r.n.id,
        userId: r.n.userId,
        messageId: r.n.messageId,
        channelId: r.n.channelId,
        workspaceId: r.workspaceId,
        kind,
        actorId: r.n.actorId ?? r.m.userId, // legacy rows: the author was the actor
        reactionEmoji: r.n.reactionEmoji,
        subkind,
        suppressAlert: suppressAlertFor(kind, subkind, ctx),
        createdAt: r.n.createdAt.toISOString(),
        readAt: r.n.readAt?.toISOString() ?? null,
        message: toMessageDTO(r.m as HydratedMessageRow),
      };
    }),
    hasMore,
    unreadCount: scopedUnread,
    totalUnreadCount: totalUnread ?? scopedUnread,
  };
}

/**
 * Reaction on one of my messages → kind 4 (issue #63). The actor is the
 * reactor, so the feed row reads "Bob reacted 👍 to your message".
 *
 * Skipped for self-reactions, muted channels, and any message whose author
 * can no longer see the channel (they left). The unique partial index makes
 * the same emoji from the same person idempotent: react → unreact → react
 * notifies once, and never re-raises a row the author already read.
 */
export async function notifyReaction(
  chan: ChannelRow,
  message: import('@flow/shared').MessageDTO,
  actorId: string,
  emoji: string,
): Promise<void> {
  const authorId = message.userId;
  if (authorId === actorId) return; // your own reaction on your own message
  const mem = await db
    .select({ notifyLevel: channelMembers.notifyLevel })
    .from(channelMembers)
    .where(and(eq(channelMembers.channelId, chan.id), eq(channelMembers.userId, authorId)))
    .limit(1);
  const level = mem[0]?.notifyLevel;
  if (level === undefined || level === 0) return; // gone, or muted this channel

  const id = newId();
  // Wrapped in a transaction so the push enqueue commits with the row (#247).
  // The conflict clause is why this has to be a transaction rather than two
  // statements: only the insert knows whether a row was actually written, and
  // enqueuing for a suppressed duplicate would push twice for one reaction.
  const row = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(notifications)
      .values({ id, userId: authorId, messageId: message.id, channelId: chan.id, kind: 4, actorId, reactionEmoji: emoji })
      .onConflictDoNothing()
      .returning({ id: notifications.id, createdAt: notifications.createdAt });
    const r = inserted[0];
    if (!r) return undefined; // already notified for this (author, message, actor, emoji)
    await enqueuePendingPush(tx, [{ userId: authorId, notificationId: r.id }]);
    return r;
  });
  if (!row) return;

  const ctx = await alertContextFor(authorId);
  const dto: NotificationDTO = {
    id: row.id,
    userId: authorId,
    messageId: message.id,
    channelId: chan.id,
    workspaceId: chan.workspaceId,
    kind: 4,
    actorId,
    reactionEmoji: emoji,
    subkind: null,
    suppressAlert: suppressAlertFor(4, null, ctx),
    createdAt: row.createdAt.toISOString(),
    readAt: null,
    message,
  };
  publishEvent(subjectUserNotify(authorId), {
    type: 'notification.created',
    workspaceId: chan.workspaceId,
    channelId: chan.id,
    ts: dto.createdAt,
    data: dto,
  });
}

/**
 * Someone added me to a channel → kind 5 (issue #303). Before this, being added
 * produced no signal at all beyond a new sidebar row, so an invite you weren't
 * watching for was found by accident.
 *
 * Only `addMember` calls this — joining a public channel yourself goes through
 * `joinChannel`, which deliberately does not, since you already know.
 *
 * The row anchors to the `member_joined` system message the caller just posted,
 * which is also where tapping the Activity row lands you. Nothing to write if
 * that line couldn't be posted (a non-standard channel): no anchor, no row.
 */
export async function notifyChannelInvite(
  chan: ChannelRow,
  message: import('@flow/shared').MessageDTO,
  invitedUserId: string,
  actorId: string,
): Promise<void> {
  if (invitedUserId === actorId) return; // added yourself — that's a join

  const id = newId();
  // Same transaction as its push enqueue (#247). The issue names only
  // insertNotifications and notifyReaction because kind 5 postdates the spec —
  // but it is a notification like any other, and leaving it out would make the
  // outbox cover four kinds out of five for no reason anyone could state.
  const row = await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(notifications)
      .values({ id, userId: invitedUserId, messageId: message.id, channelId: chan.id, kind: 5, actorId })
      .returning({ id: notifications.id, createdAt: notifications.createdAt });
    const r = inserted[0];
    if (!r) return undefined;
    await enqueuePendingPush(tx, [{ userId: invitedUserId, notificationId: r.id }]);
    return r;
  });
  if (!row) return;

  const ctx = await alertContextFor(invitedUserId);
  const dto: NotificationDTO = {
    id: row.id,
    userId: invitedUserId,
    messageId: message.id,
    channelId: chan.id,
    workspaceId: chan.workspaceId,
    kind: 5,
    actorId,
    reactionEmoji: null,
    subkind: null,
    suppressAlert: suppressAlertFor(5, null, ctx),
    createdAt: row.createdAt.toISOString(),
    readAt: null,
    message,
  };
  publishEvent(subjectUserNotify(invitedUserId), {
    type: 'notification.created',
    workspaceId: chan.workspaceId,
    channelId: chan.id,
    ts: dto.createdAt,
    data: dto,
  });
}

/**
 * This user's unread total — across every workspace, or within one when
 * `workspaceId` is given (the in-workspace Activity badge). Scoping needs the
 * channel join: notifications carry a channelId, not a workspaceId.
 */
export async function unreadCount(userId: string, workspaceId?: string | undefined): Promise<number> {
  const where = and(eq(notifications.userId, userId), isNull(notifications.readAt));
  const rows = workspaceId
    ? await db
        .select({ n: sql<number>`count(*)` })
        .from(notifications)
        .innerJoin(channels, eq(channels.id, notifications.channelId))
        .where(and(where, eq(channels.workspaceId, workspaceId)))
    : await db.select({ n: sql<number>`count(*)` }).from(notifications).where(where);
  return rows[0]?.n ?? 0;
}

/**
 * A hard-deleted message cascades its notification rows out of the database.
 * Reuse the existing notification.read convergence event so older clients
 * invalidate Activity and refresh their badges too. The ids name rows that
 * were retired rather than flipped to read, but the client response is the
 * same: refetch the server-authoritative list and count.
 */
export async function publishNotificationRetirements(
  retired: Array<{ id: string; userId: string }>,
  workspaceId: string,
  channelId: string,
): Promise<void> {
  if (retired.length === 0) return;
  const byUser = new Map<string, string[]>();
  for (const row of retired) byUser.set(row.userId, [...(byUser.get(row.userId) ?? []), row.id]);
  const readAt = new Date().toISOString();
  for (const [userId, ids] of byUser) {
    const total = await unreadCount(userId);
    publishEvent(subjectUserNotify(userId), {
      type: 'notification.read',
      workspaceId,
      channelId,
      ts: readAt,
      data: { ids, unreadCount: total, readAt },
    });
    // Same convergence, to devices instead of sockets (#248).
    queueBadgeSync(userId, total);
  }
}

/**
 * Flip the rows matched by `where` to read and tell every session of this user
 * (badge + Activity list). No rows changed → no event: the implicit
 * channel/thread paths run on every read-cursor bump and are usually no-ops.
 */
async function applyRead(
  userId: string,
  where: ReturnType<typeof and>,
  workspaceId = '',
  alwaysCount = false,
): Promise<ReadResult> {
  const readAt = new Date();
  const updated = await db
    .update(notifications)
    .set({ readAt })
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt), where))
    .returning({ id: notifications.id });
  const ids = updated.map((r) => r.id);
  if (ids.length === 0 && !alwaysCount) return { ids, unreadCount: null };

  const total = await unreadCount(userId);
  if (ids.length > 0) {
    publishEvent(subjectUserNotify(userId), {
      type: 'notification.read',
      workspaceId, // '' when the rows can span workspaces (Activity feed)
      ts: readAt.toISOString(),
      data: { ids, unreadCount: total, readAt: readAt.toISOString() },
    });
    // The phone has no socket to hear that event on — mirror it as a silent
    // badge push, coalesced and suppressed by services/badgeSync.ts (#248).
    queueBadgeSync(userId, total);
  }
  return { ids, unreadCount: total };
}

/**
 * POST /v1/me/notifications/read — `upToId` marks everything up to the cursor
 * read (opening the Activity feed), `id` marks a single row (clicking it).
 */
export async function markNotificationsRead(
  userId: string,
  body: { upToId?: string | undefined; id?: string | undefined; workspaceId?: string | undefined },
): Promise<ReadResult> {
  if (!body.upToId) return applyRead(userId, eq(notifications.id, body.id!), '', true);
  // A cursor sweep from a workspace-scoped Activity feed must stay inside that
  // workspace — otherwise opening Activity in one workspace silently reads
  // another's older rows, which the user never saw.
  const cursor = lte(notifications.id, body.upToId);
  const where = body.workspaceId
    ? and(
        cursor,
        sql`${notifications.channelId} IN (
          SELECT ${channels.id} FROM ${channels}
           WHERE ${channels.workspaceId} = ${body.workspaceId}
        )`,
      )
    : cursor;
  return applyRead(userId, where, body.workspaceId ?? '', true);
}

/**
 * Visiting a channel reads its notifications (issue #63): top-level messages at
 * or before the read cursor, **and every thread reply in the channel** (#533).
 *
 * Thread rows used to be excluded here — they live behind a click, so they were
 * left to markThreadNotificationsRead. But the sidebar badge counts *all* of a
 * channel's unread rows, so that split made the number structurally unclearable
 * from the channel view: N unread threads needed N thread openings, and the
 * auto-open mitigation (#327/#441) only jumps to one of them, only on the way
 * into a different channel. A badge you cannot clear by looking at the thing it
 * points at is worse than a reply marked read a beat early, so the visit sweeps
 * them. The reply chip's own unread dot (#270) still distinguishes threads that
 * wanted you, right up until the visit.
 *
 * That also subsumes the #270 exception it replaces — a thread hanging off a
 * system message has no affordance to open it, so before this its rows could
 * never clear at all; now they clear with every other thread row.
 */
export async function markChannelNotificationsRead(
  userId: string,
  chan: ChannelRow,
  lastReadMsgId: string,
): Promise<ReadResult> {
  const channelId = chan.id;
  return applyRead(
    userId,
    and(
      eq(notifications.channelId, channelId),
      sql`${notifications.messageId} IN (
        SELECT ${messages.id} FROM ${messages}
         WHERE ${messages.channelId} = ${channelId}
           AND (
             ${messages.threadRootId} IS NOT NULL
             OR ${messages.id} <= ${lastReadMsgId}
           )
      )`,
    ),
    chan.workspaceId,
  );
}

/**
 * Losing access reads everything (issue #63 review): when a user leaves or is
 * removed from a channel, its rows can never clear by visiting — mark them all
 * read (threads included). Read, not deleted: the inbox stays a complete
 * record (phase 10 principle); only the unread signal is retired.
 */
export async function clearChannelNotifications(userId: string, chan: ChannelRow): Promise<ReadResult> {
  return applyRead(userId, eq(notifications.channelId, chan.id), chan.workspaceId);
}

/**
 * Archiving retires the channel's unread signal for every member at once —
 * an archived channel disappears from the sidebar, so its rows would
 * otherwise count in Activity forever. One bulk update, then one
 * notification.read per affected user (each carries that user's fresh total).
 */
export async function clearChannelNotificationsForAll(chan: ChannelRow): Promise<void> {
  const readAt = new Date();
  const updated = await db
    .update(notifications)
    .set({ readAt })
    .where(and(eq(notifications.channelId, chan.id), isNull(notifications.readAt)))
    .returning({ id: notifications.id, userId: notifications.userId });
  const byUser = new Map<string, string[]>();
  for (const r of updated) byUser.set(r.userId, [...(byUser.get(r.userId) ?? []), r.id]);
  for (const [userId, ids] of byUser) {
    const total = await unreadCount(userId);
    publishEvent(subjectUserNotify(userId), {
      type: 'notification.read',
      workspaceId: chan.workspaceId,
      ts: readAt.toISOString(),
      data: { ids, unreadCount: total, readAt: readAt.toISOString() },
    });
    // Same convergence, to devices instead of sockets (#248).
    queueBadgeSync(userId, total);
  }
}

/** Opening a thread reads the notifications its replies (and root) raised. */
export async function markThreadNotificationsRead(
  userId: string,
  chan: ChannelRow,
  threadRootId: string,
): Promise<ReadResult> {
  return applyRead(
    userId,
    and(
      eq(notifications.channelId, chan.id),
      sql`${notifications.messageId} IN (
        SELECT ${messages.id} FROM ${messages}
         WHERE ${messages.id} = ${threadRootId} OR ${messages.threadRootId} = ${threadRootId}
      )`,
    ),
    chan.workspaceId,
  );
}
