import { and, asc, desc, eq, gt, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { HUDDLE_SYSTEM_KINDS } from '@flow/shared';
import type { FileDTO, MessageDTO, MessagePage, ReactionAggDTO, SystemMessageKind, UnfurlDTO } from '@flow/shared';
import { db, schema } from '../db/index.js';
import { newId } from '../lib/ids.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { decryptBody, encryptBody } from '../crypto/index.js';
import { requireChannelAccess } from './channels.js';
import { reactionsForMessages } from './reactions.js';
import { filesForMessages, reapFileIfUnreferenced, validateAttachments, toFileDTO } from './files.js';
import {
  computeRecipients,
  insertNotifications,
  publishNotificationRetirements,
  publishNotifications,
} from './notifications.js';
import { publishEvent, subjectMsg } from '../bus.js';
import { scheduleForMessage, unfurlsForMessages } from './unfurl/index.js';
import { requireMembership } from './workspaces.js';
import { expandMentions as expandMentionText } from '../lib/mentionExpansion.js';

const { messages, channelMembers, messageFiles, notifications, users, workspaceMembers } = schema;

type MessageRow = typeof messages.$inferSelect;
export type HydratedMessageRow = MessageRow;

/** Pure authorization rule kept exported so role semantics have a fast unit test. */
export function mayDeleteMessage(
  actorId: string,
  authorId: string,
  role: 'owner' | 'admin' | 'member',
  permanently: boolean,
  isSystem: boolean,
  allowOwnPermanentDelete = false,
): boolean {
  if (isSystem) return false;
  if (!permanently) return actorId === authorId;
  return role === 'owner' || role === 'admin' || (allowOwnPermanentDelete && actorId === authorId);
}

interface DtoExtras {
  reactions?: ReactionAggDTO[] | undefined;
  files?: FileDTO[] | undefined;
  replyParticipants?: string[] | undefined;
  unfurls?: UnfurlDTO[] | undefined;
  pin?: { pinnedAt: Date; pinnedBy: string | null } | undefined;
}

export function toMessageDTO(row: MessageRow, extras?: DtoExtras): MessageDTO {
  return {
    id: row.id,
    channelId: row.channelId,
    userId: row.userId,
    threadRootId: row.threadRootId,
    clientMsgId: row.clientMsgId,
    body: row.deletedAt ? '' : decryptBody(row),
    createdAt: row.createdAt.toISOString(),
    editedAt: row.editedAt?.toISOString() ?? null,
    deletedAt: row.deletedAt?.toISOString() ?? null,
    pinnedAt: extras?.pin?.pinnedAt.toISOString() ?? null,
    pinnedBy: extras?.pin?.pinnedBy ?? null,
    systemKind: (row.systemKind as MessageDTO['systemKind']) ?? null,
    scheduled: row.scheduled,
    replyCount: row.replyCount,
    lastReplyAt: row.lastReplyAt?.toISOString() ?? null,
    replyParticipantUserIds: extras?.replyParticipants ?? [],
    reactions: extras?.reactions ?? [],
    files: extras?.files ?? [],
    unfurls: extras?.unfurls ?? [],
  };
}

/** Reply-avatar stack cap (phase5.md item 7): first 4 distinct authors per thread. */
const REPLY_PARTICIPANTS_MAX = 4;

/**
 * First (up to) 4 distinct reply authors per thread root, in order of each
 * author's first reply (message ids are uuidv7 → time-ordered). Grouped query
 * over the roots on the page, same shape as reactions/files hydration.
 */
async function replyParticipantsForRoots(rows: MessageRow[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  const rootIds = rows.filter((r) => r.threadRootId === null && r.replyCount > 0).map((r) => r.id);
  if (rootIds.length === 0) return out;
  // Postgres has no min(uuid) aggregate; DISTINCT ON picks each author's
  // first reply instead, then JS orders authors by that reply and caps at 4.
  const grouped = await db
    .select({ rootId: messages.threadRootId, userId: messages.userId, firstId: sql<string>`min(${messages.id})` })
    .from(messages)
    .where(inArray(messages.threadRootId, rootIds))
    .groupBy(messages.threadRootId, messages.userId);
  grouped.sort((a, b) => (a.firstId < b.firstId ? -1 : 1));
  for (const r of grouped) {
    const list = out.get(r.rootId!) ?? [];
    if (list.length < REPLY_PARTICIPANTS_MAX) {
      list.push(r.userId);
      out.set(r.rootId!, list);
    }
  }
  return out;
}

/** Page hydration (phase2.md §2/§3): one grouped reactions query + one files join per page. */
async function hydrate(rows: MessageRow[]): Promise<MessageDTO[]> {
  const ids = rows.map((r) => r.id);
  const [reactions, files, participants, unfurls, pins] = await Promise.all([
    reactionsForMessages(ids),
    filesForMessages(ids),
    replyParticipantsForRoots(rows),
    unfurlsForMessages(ids),
    pinsForMessages(ids),
  ]);
  return rows.map((r) =>
    toMessageDTO(r, {
      reactions: reactions.get(r.id),
      files: files.get(r.id),
      replyParticipants: participants.get(r.id),
      unfurls: unfurls.get(r.id),
      pin: pins.get(r.id),
    }),
  );
}

async function pinsForMessages(
  messageIds: string[],
): Promise<Map<string, { pinnedAt: Date; pinnedBy: string | null }>> {
  const out = new Map<string, { pinnedAt: Date; pinnedBy: string | null }>();
  if (messageIds.length === 0) return out;
  const rows = await db
    .select()
    .from(schema.messagePins)
    .where(inArray(schema.messagePins.messageId, messageIds));
  for (const row of rows) {
    out.set(row.messageId, { pinnedAt: row.pinnedAt, pinnedBy: row.pinnedBy });
  }
  return out;
}

/** Workspace members an API-posted `@Name` can resolve to (#415). */
async function workspaceMentionCandidates(workspaceId: string): Promise<{ id: string; displayName: string }[]> {
  return db
    .select({ id: users.id, displayName: users.displayName })
    .from(workspaceMembers)
    .innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(and(eq(workspaceMembers.workspaceId, workspaceId), isNull(users.deletedAt)));
}

/**
 * Send message (spec write path): validate → insert (encrypted) + attach files
 * + write notification rows, one transaction → publish. Public channels:
 * auto-join on first post. Idempotent on (channel, clientMsgId).
 *
 * `opts.expandMentions` (#415) rewrites `@Display Name` to `<@userId>` before
 * anything else looks at the body, so an API-posted mention is indistinguishable
 * from a composer-typed one all the way down.
 */
export async function sendMessage(
  channelId: string,
  userId: string,
  clientMsgId: string,
  body: string,
  threadRootId?: string,
  fileIds?: string[],
  mentions?: string[],
  opts?: { expandMentions?: boolean; scheduled?: boolean },
): Promise<MessageDTO> {
  const { chan, isMember } = await requireChannelAccess(channelId, userId);
  if (chan.archivedAt) throw badRequest('channel_archived', 'channel is archived');
  if (!isMember) {
    // public channel, first post → auto-join (spec permission rules)
    await db.insert(channelMembers).values({ channelId, userId }).onConflictDoNothing();
  }

  // idempotency: return the existing row for a retried clientMsgId
  const existing = await db
    .select()
    .from(messages)
    .where(and(eq(messages.channelId, channelId), eq(messages.clientMsgId, clientMsgId)))
    .limit(1);
  if (existing[0]) return (await hydrate([existing[0]]))[0]!;

  if (threadRootId) {
    const roots = await db.select().from(messages).where(eq(messages.id, threadRootId)).limit(1);
    const root = roots[0];
    if (!root || root.channelId !== channelId) throw badRequest('bad_thread_root', 'thread root not found in this channel');
    if (root.threadRootId !== null) throw badRequest('bad_thread_root', 'replies must target the thread root (one level deep)');
    if (root.deletedAt) throw badRequest('bad_thread_root', 'cannot reply to a deleted message');
    // No client draws a thread affordance on a join/leave line, so a thread
    // hung off one is unreachable — and any notification it raises can never
    // be read by opening it (#270). Refuse the reply rather than build the trap.
    if (root.systemKind) throw badRequest('bad_thread_root', 'cannot reply to a system message');
  }

  const attachRows = await validateAttachments(fileIds ?? [], chan.workspaceId, userId);

  let mentionIds = mentions ?? [];
  if (opts?.expandMentions) {
    const expanded = expandMentionText(body, await workspaceMentionCandidates(chan.workspaceId));
    body = expanded.text;
    if (expanded.userIds.length > 0) mentionIds = [...new Set([...mentionIds, ...expanded.userIds])];
  }

  const { recipients, alertContext } = await computeRecipients(chan, userId, body, mentionIds, threadRootId);

  const id = newId();
  const enc = encryptBody(body);
  const now = new Date();

  let row: MessageRow | undefined;
  let planned: Awaited<ReturnType<typeof insertNotifications>> = [];
  await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(messages)
      .values({
        id,
        channelId,
        userId,
        threadRootId: threadRootId ?? null,
        clientMsgId,
        body: enc.body,
        bodyNonce: enc.bodyNonce,
        encKeyId: enc.encKeyId,
        encScheme: enc.encScheme,
        createdAt: now,
        // #419: this row was posted by a scheduled message, not typed. Nothing
        // else on the write path changes — clients render a badge off it.
        scheduled: opts?.scheduled === true,
      })
      .onConflictDoNothing({ target: [messages.channelId, messages.clientMsgId] })
      .returning();
    row = inserted[0];
    if (!row) return; // lost the race; handled below
    if (threadRootId) {
      // denormalized thread rollup on the root, same txn (spec design note)
      await tx
        .update(messages)
        .set({ replyCount: sql`${messages.replyCount} + 1`, lastReplyAt: now })
        .where(eq(messages.id, threadRootId));
    }
    if (attachRows.length > 0) {
      await tx.insert(messageFiles).values(attachRows.map((f) => ({ messageId: id, fileId: f.id })));
    }
    if (!threadRootId) {
      // Posting in a channel means you've seen what's above it — advance the
      // sender's read cursor so the channel doesn't badge on their other
      // clients (#71). `greatest` ignores NULLs and never moves it backwards.
      await tx
        .update(channelMembers)
        .set({ lastReadMsgId: sql`max(${channelMembers.lastReadMsgId}, ${id})` })
        .where(and(eq(channelMembers.channelId, channelId), eq(channelMembers.userId, userId)));
    }
    // notification rows in the same transaction (phase2.md §4)
    planned = await insertNotifications(tx, recipients, id, channelId, userId);
  });

  if (!row) {
    // lost a concurrent-insert race: fetch the winner (same clientMsgId)
    const winner = await db
      .select()
      .from(messages)
      .where(and(eq(messages.channelId, channelId), eq(messages.clientMsgId, clientMsgId)))
      .limit(1);
    return (await hydrate([winner[0]!]))[0]!;
  }

  const dto = toMessageDTO(row, { files: attachRows.map(toFileDTO) });
  publishEvent(subjectMsg(chan.workspaceId, channelId), {
    type: threadRootId ? 'thread.reply' : 'message.created',
    workspaceId: chan.workspaceId,
    channelId,
    ts: now.toISOString(),
    data: dto,
  });
  publishNotifications(planned, alertContext, dto, chan.workspaceId, now.toISOString());
  // §1: never blocks the send path — cards arrive later via message.updated.
  void scheduleForMessage(dto);
  return dto;
}

const SYSTEM_PREDICATE: Record<SystemMessageKind, string> = {
  member_joined: 'joined the channel',
  member_left: 'left the channel',
  // Huddle outcomes (#436) render as their own sentence, not "<Name> <predicate>"
  // — postHuddleSystemMessage builds those bodies and never reaches this table.
  huddle_missed: '',
  huddle_declined: '',
  huddle_ended: '',
  file_shared: '',
};

/**
 * Post an inline channel-event line ("Alice joined the channel") — a normal
 * `messages` row authored by the subject user, tagged with `systemKind` so
 * clients render it as a centered muted notice. Unlike sendMessage it creates
 * no notifications and no unfurls, and it never
 * throws into the caller's path: membership writes must not fail because the
 * courtesy notice couldn't be posted. Only standard channels get these.
 *
 * The body is the pre-rendered sentence so every client (and scroll-back
 * history) reads correctly without a live member lookup; the name reflects the
 * user at the moment of the event, which is what we want.
 *
 * Returns the posted message, or null when there wasn't one (a non-standard
 * channel, or a failure it swallowed). #303 hangs the channel-invite
 * notification off this row — every notification anchors to a message, and the
 * join line is both already there and the right tap destination.
 */
export async function postSystemMessage(
  chan: { id: string; workspaceId: string; kind: string },
  subjectUserId: string,
  kind: SystemMessageKind,
): Promise<MessageDTO | null> {
  if (chan.kind !== 'standard') return null;
  try {
    const who = await db
      .select({ displayName: schema.users.displayName })
      .from(schema.users)
      .where(eq(schema.users.id, subjectUserId))
      .limit(1);
    const name = who[0]?.displayName ?? 'Someone';
    const body = `${name} ${SYSTEM_PREDICATE[kind]}`;
    const id = newId();
    const now = new Date();
    const enc = encryptBody(body);
    const inserted = await db
      .insert(messages)
      .values({
        id,
        channelId: chan.id,
        userId: subjectUserId,
        threadRootId: null,
        clientMsgId: newId(),
        body: enc.body,
        bodyNonce: enc.bodyNonce,
        encKeyId: enc.encKeyId,
        encScheme: enc.encScheme,
        createdAt: now,
        systemKind: kind,
      })
      .returning();
    const row = inserted[0];
    if (!row) return null;
    const dto = toMessageDTO(row);
    publishEvent(subjectMsg(chan.workspaceId, chan.id), {
      type: 'message.created',
      workspaceId: chan.workspaceId,
      channelId: chan.id,
      ts: now.toISOString(),
      data: dto,
    });
    return dto;
  } catch (err) {
    // Best-effort: a failed courtesy line must not abort the join/leave.
    console.error('postSystemMessage failed', { channelId: chan.id, kind, err });
    return null;
  }
}

/**
 * The DM transcript line a huddle leaves behind (#436): "Missed huddle",
 * "Call declined", "Call ended · 4 min". Sibling of postSystemMessage, split
 * out because it differs on both halves of that function's contract:
 *
 * - it posts into **DMs and group DMs**, which postSystemMessage refuses (a
 *   join/leave line there would be nonsense; a missed call there is the whole
 *   point), and
 * - it **notifies**, through the ordinary DM path — a missed call that left no
 *   unread and no badge is a missed call you never learn about. `computeRecipients`
 *   gives every other member kind 1 (dm) and already drops anyone who muted
 *   the conversation, so muting a DM silences its call lines too, for free.
 *
 * A share's line (`file_shared`, services/shares.ts) goes the same way: in a DM it notifies the person shared with.
 *
 * Body is pre-rendered, like every system message, so scroll-back reads
 * correctly with no live lookup. Best-effort: a failed line must not fail the
 * call it describes.
 */
export async function postHuddleSystemMessage(
  chan: { id: string; workspaceId: string },
  authorId: string,
  kind: (typeof HUDDLE_SYSTEM_KINDS)[number] | 'file_shared',
  body: string,
): Promise<MessageDTO | null> {
  try {
    const chanRow = (await db.select().from(schema.channels).where(eq(schema.channels.id, chan.id)).limit(1))[0];
    if (!chanRow) return null;
    const { recipients, alertContext } = await computeRecipients(chanRow, authorId, body, []);

    const id = newId();
    const now = new Date();
    const enc = encryptBody(body);
    let row: MessageRow | undefined;
    let planned: Awaited<ReturnType<typeof insertNotifications>> = [];
    await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(messages)
        .values({
          id,
          channelId: chan.id,
          userId: authorId,
          threadRootId: null,
          clientMsgId: newId(),
          body: enc.body,
          bodyNonce: enc.bodyNonce,
          encKeyId: enc.encKeyId,
          encScheme: enc.encScheme,
          createdAt: now,
          systemKind: kind,
        })
        .returning();
      row = inserted[0];
      if (!row) return;
      planned = await insertNotifications(tx, recipients, id, chan.id, authorId);
    });
    if (!row) return null;

    const dto = toMessageDTO(row);
    const ts = now.toISOString();
    publishEvent(subjectMsg(chan.workspaceId, chan.id), {
      type: 'message.created',
      workspaceId: chan.workspaceId,
      channelId: chan.id,
      ts,
      data: dto,
    });
    publishNotifications(planned, alertContext, dto, chan.workspaceId, ts);
    return dto;
  } catch (err) {
    console.error('postHuddleSystemMessage failed', { channelId: chan.id, kind, err });
    return null;
  }
}

/** Single hydrated message; used by the unfurl worker to republish. */
export async function getMessageById(messageId: string): Promise<MessageDTO | null> {
  const rows = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
  if (!rows[0]) return null;
  return (await hydrate([rows[0]]))[0] ?? null;
}

/** Channel history: top-level messages, newest first, cursor on id (spec §2 index). */
export async function listMessages(
  channelId: string,
  userId: string,
  before: string | undefined,
  limit: number,
): Promise<MessagePage> {
  await requireChannelAccess(channelId, userId);
  const conds = [eq(messages.channelId, channelId), isNull(messages.threadRootId)];
  if (before) conds.push(lt(messages.id, before));
  const rows = await db
    .select()
    .from(messages)
    .where(and(...conds))
    .orderBy(desc(messages.id))
    .limit(limit + 1);
  const hasMore = rows.length > limit;
  return { messages: await hydrate(rows.slice(0, limit)), hasMore };
}

/** Every live message pinned in a channel, newest pin first. Reading follows
 * normal channel visibility; pinning and unpinning require membership. */
export async function listPinnedMessages(channelId: string, userId: string): Promise<MessageDTO[]> {
  await requireChannelAccess(channelId, userId);
  const pins = await db
    .select()
    .from(schema.messagePins)
    .where(eq(schema.messagePins.channelId, channelId))
    .orderBy(desc(schema.messagePins.pinnedAt));
  if (pins.length === 0) return [];

  const rows = await db
    .select()
    .from(messages)
    .where(and(
      inArray(messages.id, pins.map((p) => p.messageId)),
      eq(messages.channelId, channelId),
      isNull(messages.deletedAt),
    ));
  const hydrated = await hydrate(rows);
  const byId = new Map(hydrated.map((m) => [m.id, m]));
  return pins.flatMap((p) => {
    const message = byId.get(p.messageId);
    return message ? [message] : [];
  });
}

async function requirePinnableMessage(messageId: string, userId: string) {
  const rows = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
  const row = rows[0];
  if (!row) throw notFound('message not found');
  const { chan, isMember } = await requireChannelAccess(row.channelId, userId);
  if (chan.archivedAt) throw badRequest('channel_archived', 'channel is archived');
  if (!isMember) throw forbidden('join the channel to manage pinned messages');
  if (row.deletedAt) throw badRequest('message_deleted', 'cannot pin a deleted message');
  if (row.systemKind) throw badRequest('system_message', 'channel event messages cannot be pinned');
  return { row, chan };
}

/** Pin a message for everyone in its channel. Idempotent: pinning an already
 * pinned message keeps the original pinner and timestamp. */
export async function pinMessage(messageId: string, userId: string): Promise<MessageDTO> {
  const { row, chan } = await requirePinnableMessage(messageId, userId);
  const inserted = await db
    .insert(schema.messagePins)
    .values({ messageId, channelId: row.channelId, pinnedBy: userId })
    .onConflictDoNothing()
    .returning();
  const dto = (await hydrate([row]))[0]!;
  if (inserted.length > 0) {
    publishEvent(subjectMsg(chan.workspaceId, row.channelId), {
      type: 'message.updated',
      workspaceId: chan.workspaceId,
      channelId: row.channelId,
      ts: new Date().toISOString(),
      data: dto,
    });
  }
  return dto;
}

/** Remove a channel-wide pin. Idempotent; the message itself is unchanged. */
export async function unpinMessage(messageId: string, userId: string): Promise<MessageDTO> {
  const { row, chan } = await requirePinnableMessage(messageId, userId);
  const deleted = await db
    .delete(schema.messagePins)
    .where(eq(schema.messagePins.messageId, messageId))
    .returning();
  const dto = (await hydrate([row]))[0]!;
  if (deleted.length > 0) {
    publishEvent(subjectMsg(chan.workspaceId, row.channelId), {
      type: 'message.updated',
      workspaceId: chan.workspaceId,
      channelId: row.channelId,
      ts: new Date().toISOString(),
      data: dto,
    });
  }
  return dto;
}

/** Thread view: root + replies ascending, cursor after=<msgId>. */
export async function listThread(
  rootId: string,
  userId: string,
  after: string | undefined,
  limit: number,
): Promise<MessagePage & { root: MessageDTO }> {
  const roots = await db.select().from(messages).where(eq(messages.id, rootId)).limit(1);
  const root = roots[0];
  if (!root) throw notFound('message not found');
  if (root.threadRootId) throw badRequest('not_a_root', 'message is not a thread root');
  await requireChannelAccess(root.channelId, userId);

  const conds = [eq(messages.threadRootId, rootId)];
  if (after) conds.push(gt(messages.id, after));
  const rows = await db
    .select()
    .from(messages)
    .where(and(...conds))
    .orderBy(asc(messages.id))
    .limit(limit + 1);
  const hasMore = rows.length > limit;
  const [rootDto, replyDtos] = await Promise.all([hydrate([root]), hydrate(rows.slice(0, limit))]);
  return { root: rootDto[0]!, messages: replyDtos, hasMore };
}

/**
 * Only the author edits own messages (spec permission rules). Re-encrypts.
 * Edits do not create new notifications (deliberate: re-notifying on every
 * typo fix is noise; matches the write-time parse model).
 */
export async function editMessage(messageId: string, userId: string, body: string): Promise<MessageDTO> {
  const rows = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
  const row = rows[0];
  if (!row) throw notFound('message not found');
  const { chan } = await requireChannelAccess(row.channelId, userId);
  if (row.userId !== userId) throw forbidden('only the author can edit a message');
  if (row.deletedAt) throw badRequest('message_deleted', 'cannot edit a deleted message');

  const enc = encryptBody(body);
  const editedAt = new Date();
  const updated = await db
    .update(messages)
    .set({ body: enc.body, bodyNonce: enc.bodyNonce, encKeyId: enc.encKeyId, encScheme: enc.encScheme, editedAt })
    .where(eq(messages.id, messageId))
    .returning();
  const dto = (await hydrate([updated[0]!]))[0]!;
  publishEvent(subjectMsg(chan.workspaceId, row.channelId), {
    type: 'message.updated',
    workspaceId: chan.workspaceId,
    channelId: row.channelId,
    ts: editedAt.toISOString(),
    data: dto,
  });
  // §1: an edit can introduce new links. Already-attached and tombstoned
  // hashes are skipped inside, so this is safe to call on every edit.
  void scheduleForMessage(dto);
  return dto;
}

/**
 * Delete a message. Default is a soft delete: body overwritten with empty
 * ciphertext, row kept, `deletedAt` set (spec §2) — clients render a tombstone.
 *
 * `hard` fully removes the row (child reactions/files/notifications cascade)
 * and publishes `message.purged` so clients drop it with no tombstone. Owners
 * and admins may purge any message they can see. Session-authenticated agent
 * identities may purge their own ephemeral status rows for bridge compatibility; ordinary
 * members cannot turn their own soft deletes into permanent deletes. Purging a
 * root removes its complete thread, while purging one reply repairs the rollup.
 */
export async function deleteMessage(
  messageId: string,
  userId: string,
  opts?: { hard?: boolean; allowOwnPermanentDelete?: boolean },
): Promise<void> {
  const rows = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
  const row = rows[0];
  if (!row) {
    if (opts?.hard) return; // idempotent: already gone is the goal state
    throw notFound('message not found');
  }
  const { chan } = await requireChannelAccess(row.channelId, userId);
  const actor = await requireMembership(chan.workspaceId, userId);
  if (!mayDeleteMessage(
    userId,
    row.userId,
    actor.role,
    opts?.hard === true,
    row.systemKind !== null,
    opts?.allowOwnPermanentDelete === true,
  )) {
    throw forbidden(
      opts?.hard
        ? 'only workspace owners, admins, or the authoring automation can permanently delete a message'
        : 'only the author can delete a message',
    );
  }

  if (opts?.hard) {
    const purged = await db.transaction(async (tx) => {
      // Lock the target first. For roots, the self-FK makes concurrent reply
      // inserts wait and then fail once the root is deleted; the following
      // query therefore captures every committed row in the thread.
      const locked = await tx.select().from(messages).where(eq(messages.id, messageId));
      if (!locked[0]) {
        return {
          rows: [] as MessageRow[],
          fileIds: [] as string[],
          retired: [] as Array<{ id: string; userId: string }>,
        };
      }
      const targetRows = row.threadRootId
        ? locked
        : await tx
            .select()
            .from(messages)
            .where(or(eq(messages.id, messageId), eq(messages.threadRootId, messageId)));
      const targetIds = targetRows.map((m) => m.id);
      const fileRows = await tx
        .select({ fileId: messageFiles.fileId })
        .from(messageFiles)
        .where(inArray(messageFiles.messageId, targetIds));
      const retired = await tx
        .select({ id: notifications.id, userId: notifications.userId })
        .from(notifications)
        .where(inArray(notifications.messageId, targetIds));

      // ON DELETE CASCADE removes a root's replies and all message-owned child
      // rows atomically. A reply delete only touches that reply.
      await tx.delete(messages).where(eq(messages.id, messageId));
      // Fix the root's denormalized rollup if this was a thread reply
      // (participants are computed at query time, so they self-correct). The
      // delete above already ran in this txn, so the subquery sees survivors
      // only — lastReplyAt drops to the newest remaining reply, or NULL.
      if (row.threadRootId) {
        await tx
          .update(messages)
          .set({
            replyCount: sql`max(${messages.replyCount} - 1, 0)`,
            lastReplyAt: sql`(select max(m.created_at) from ${messages} m where m.thread_root_id = ${row.threadRootId})`,
          })
          .where(eq(messages.id, row.threadRootId));
      }
      return {
        // Replies first and root last keeps older clients' open thread caches
        // coherent before they receive the event that removes the root.
        rows: targetRows.sort((a, b) =>
          a.threadRootId && !b.threadRootId ? -1 : !a.threadRootId && b.threadRootId ? 1 : 0,
        ),
        fileIds: [...new Set(fileRows.map((f) => f.fileId))],
        retired,
      };
    });
    for (const fileId of purged.fileIds) await reapFileIfUnreferenced(fileId);
    await publishNotificationRetirements(purged.retired, chan.workspaceId, row.channelId);
    for (const removed of purged.rows) {
      publishEvent(subjectMsg(chan.workspaceId, row.channelId), {
        type: 'message.purged',
        workspaceId: chan.workspaceId,
        channelId: row.channelId,
        ts: new Date().toISOString(),
        data: toMessageDTO(removed),
      });
    }
    return;
  }

  if (row.deletedAt) return; // idempotent

  const enc = encryptBody('');
  const deletedAt = new Date();
  const updated = await db.transaction(async (tx) => {
    const rows = await tx
      .update(messages)
      .set({ body: enc.body, bodyNonce: enc.bodyNonce, encKeyId: enc.encKeyId, encScheme: enc.encScheme, deletedAt })
      .where(eq(messages.id, messageId))
      .returning();
    // A deleted message should not linger in the channel's pinned list.
    await tx.delete(schema.messagePins).where(eq(schema.messagePins.messageId, messageId));
    return rows;
  });
  publishEvent(subjectMsg(chan.workspaceId, row.channelId), {
    type: 'message.deleted',
    workspaceId: chan.workspaceId,
    channelId: row.channelId,
    ts: deletedAt.toISOString(),
    data: toMessageDTO(updated[0]!),
  });
}
