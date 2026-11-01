// Emoji reactions (phase2.md §2). Unicode emoji, plus workspace custom emoji as
// `:shortcode:` (#175); idempotent add/remove; events on the channel's msg
// subject; aggregates computed per message page.
import { and, asc, eq, inArray } from 'drizzle-orm';
import { customEmojiCode, type ReactionAggDTO } from '@flow/shared';
import { resolveShortcodes } from './workspaceEmoji.js';
import { db, schema } from '../db/index.js';
import { badRequest, notFound } from '../lib/errors.js';
import { requireChannelAccess } from './channels.js';
import { notifyReaction } from './notifications.js';
import { toMessageDTO } from './messages.js';
import { publishEvent, subjectMsg } from '../bus.js';

const { reactions, messages } = schema;

async function loadMessage(messageId: string, userId: string) {
  const rows = await db.select().from(messages).where(eq(messages.id, messageId)).limit(1);
  const row = rows[0];
  if (!row) throw notFound('message not found');
  const { chan } = await requireChannelAccess(row.channelId, userId);
  if (chan.archivedAt) throw badRequest('channel_archived', 'channel is archived');
  if (row.deletedAt) throw badRequest('message_deleted', 'cannot react to a deleted message');
  return { row, chan };
}

export async function addReaction(messageId: string, userId: string, emoji: string): Promise<ReactionAggDTO[]> {
  const { row, chan } = await loadMessage(messageId, userId);
  // EmojiParam only checks the *shape* of a `:shortcode:` (#175). Resolving it
  // here keeps unknown codes out of the table — otherwise anyone could react
  // with arbitrary text that every client renders as literal `:whatever:`.
  const code = customEmojiCode(emoji);
  if (code !== null && !(await resolveShortcodes(chan.workspaceId, [code])).has(code)) {
    throw badRequest('unknown_emoji', `:${code}: is not a custom emoji in this workspace`);
  }
  const inserted = await db
    .insert(reactions)
    .values({ messageId, userId, emoji })
    .onConflictDoNothing()
    .returning();
  if (inserted.length > 0) {
    publishEvent(subjectMsg(chan.workspaceId, row.channelId), {
      type: 'reaction.added',
      workspaceId: chan.workspaceId,
      channelId: row.channelId,
      ts: new Date().toISOString(),
      data: { messageId, channelId: row.channelId, emoji, userId },
    });
    // Reactions on your own messages notify you (issue #63). Post-commit, and
    // never allowed to fail the reaction itself.
    await notifyReaction(chan, toMessageDTO(row), userId, emoji).catch(() => {});
  }
  return (await reactionsForMessages([messageId])).get(messageId) ?? [];
}

export async function removeReaction(messageId: string, userId: string, emoji: string): Promise<ReactionAggDTO[]> {
  const { row, chan } = await loadMessage(messageId, userId);
  const deleted = await db
    .delete(reactions)
    .where(and(eq(reactions.messageId, messageId), eq(reactions.userId, userId), eq(reactions.emoji, emoji)))
    .returning();
  if (deleted.length > 0) {
    publishEvent(subjectMsg(chan.workspaceId, row.channelId), {
      type: 'reaction.removed',
      workspaceId: chan.workspaceId,
      channelId: row.channelId,
      ts: new Date().toISOString(),
      data: { messageId, channelId: row.channelId, emoji, userId },
    });
  }
  return (await reactionsForMessages([messageId])).get(messageId) ?? [];
}

/**
 * Aggregated reactions for a message page (phase2.md §2: one grouped query per
 * page). Emoji groups ordered by first reaction; userIds in reaction order.
 */
export async function reactionsForMessages(messageIds: string[]): Promise<Map<string, ReactionAggDTO[]>> {
  const out = new Map<string, ReactionAggDTO[]>();
  if (messageIds.length === 0) return out;
  const rows = await db
    .select()
    .from(reactions)
    .where(inArray(reactions.messageId, messageIds))
    .orderBy(asc(reactions.createdAt));
  for (const r of rows) {
    const list = out.get(r.messageId) ?? [];
    let agg = list.find((a) => a.emoji === r.emoji);
    if (!agg) {
      agg = { emoji: r.emoji, count: 0, userIds: [] };
      list.push(agg);
    }
    agg.count += 1;
    agg.userIds.push(r.userId);
    out.set(r.messageId, list);
  }
  return out;
}
