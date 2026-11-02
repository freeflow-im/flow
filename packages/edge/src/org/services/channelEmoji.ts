// Channel emoji (#396): the small persistent glyph clients draw after a
// channel's name in the sidebar.
//
// It shares that slot with the activity indicator (channelIndicators.ts) and is
// its opposite in every other respect. The indicator is a claim about right now
// — in memory, per setter, TTL'd, cleared on disconnect. This is a decoration
// somebody set on purpose: one value per channel, in a column, unchanged until
// someone changes or clears it. Nothing here expires, and no failure path needs
// to reset it.
//
// The event rides a per-channel subject under the workspace wildcard, exactly
// like the indicator: the envelope carries channelId, so the gateway's
// visible() filter delivers only to people who can see the channel and a
// private channel's emoji stays private for free.
import { eq } from 'drizzle-orm';
import type { ChannelEmojiData } from '@flow/shared';
import { isSingleEmoji } from '@flow/shared';
import { publishEvent, subjectChannelEmoji } from '../bus.js';
import { db, schema } from '../db/index.js';
import { badRequest, forbidden } from '../lib/errors.js';
import { requireChannelAccess } from './channels.js';

const { channels } = schema;

/**
 * Set or clear a channel's emoji. Null, undefined and '' all clear it.
 *
 * Membership is the bar, not mere visibility: this writes a property everyone
 * in the channel sees, so a workspace member who merely *can* see a public
 * channel is not entitled to redecorate it. (requireChannelAccess alone lets
 * non-members through for public channels — that is right for reading, wrong
 * here.)
 *
 * Publishes only on a real change, so a client re-asserting the emoji it
 * already set puts nothing on the bus.
 */
export async function setChannelEmoji(
  channelId: string,
  userId: string,
  emoji: string | null | undefined,
): Promise<{ emoji: string | null }> {
  const { chan, isMember } = await requireChannelAccess(channelId, userId);
  if (!isMember) throw forbidden('only channel members can set the channel emoji');
  const next = emoji == null || emoji === '' ? null : emoji;
  // Belt and braces: the route validates via SetChannelEmojiBody, but this is
  // the only writer and other callers (tests, future internal callers) reach it
  // directly.
  if (next !== null && !isSingleEmoji(next)) {
    throw badRequest('invalid_emoji', 'emoji must be a single emoji (or empty to clear)');
  }
  const before = chan.emoji ?? null;
  if (before === next) return { emoji: next };
  await db.update(channels).set({ emoji: next }).where(eq(channels.id, channelId));
  const data: ChannelEmojiData = { channelId, emoji: next };
  publishEvent(subjectChannelEmoji(chan.workspaceId, channelId), {
    type: 'channel.emoji',
    workspaceId: chan.workspaceId,
    channelId,
    ts: new Date().toISOString(),
    data,
  });
  return { emoji: next };
}
