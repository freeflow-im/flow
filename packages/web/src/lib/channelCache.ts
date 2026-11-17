// Live patches to the cached channel list. Kept out of the event switch in
// Main.tsx so the reducer half is testable on its own.
import type { ChannelDTO, ChannelEmojiData, ChannelIndicatorData, HuddleUpdatedData } from '@flow/shared';

/**
 * Apply a `channel.indicator` event (#137) to the cached list. Returns the same
 * array when nothing changed, so React Query keeps the old reference and the
 * sidebar doesn't re-render on a no-op — the server only publishes real
 * transitions, but an event for a channel this client hasn't loaded (or one
 * that's already in that state) still arrives.
 */
export function applyIndicator(channels: ChannelDTO[], data: ChannelIndicatorData): ChannelDTO[] {
  const cur = channels.find((c) => c.id === data.channelId);
  if (!cur || (cur.indicator ?? null) === data.state) return channels;
  return channels.map((c) => (c.id === data.channelId ? { ...c, indicator: data.state } : c));
}

/**
 * Apply a `channel.emoji` event (#396) — same same-reference no-op skip as
 * applyIndicator, for the same reason. `emoji: null` clears the glyph.
 */
export function applyChannelEmoji(channels: ChannelDTO[], data: ChannelEmojiData): ChannelDTO[] {
  const cur = channels.find((c) => c.id === data.channelId);
  if (!cur || (cur.emoji ?? null) === data.emoji) return channels;
  return channels.map((c) => (c.id === data.channelId ? { ...c, emoji: data.emoji } : c));
}

/** Same reasoning as applyIndicator, for `huddle.updated` (Phase 1): a
 * same-reference no-op skip, and the whole roster replaces at once (the
 * server sends the aggregate, not one joiner/leaver). */
export function applyHuddle(channels: ChannelDTO[], data: HuddleUpdatedData): ChannelDTO[] {
  const cur = channels.find((c) => c.id === data.channelId);
  if (!cur) return channels;
  const before = cur.huddleParticipants ?? [];
  const same =
    before.length === data.participants.length &&
    before.every((p, i) => p.userId === data.participants[i]?.userId && p.joinedAt === data.participants[i]?.joinedAt);
  if (same) return channels;
  return channels.map((c) => (c.id === data.channelId ? { ...c, huddleParticipants: data.participants } : c));
}

/**
 * Whether a message event is for a channel the channel list leaves out — a meeting's chat (Meet phase 3b). Its events
 * reach the socket like a private channel's, but it never gets a sidebar row or an unread count: the event only moves
 * the Meetings list (its newest message, its mentions). False while the list has not loaded: nothing to compare with.
 */
export function isUnlistedChannel(channels: ChannelDTO[] | undefined, channelId: string): boolean {
  return !!channels && !channels.some((c) => c.id === channelId);
}
