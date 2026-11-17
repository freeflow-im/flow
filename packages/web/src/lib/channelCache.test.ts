import { describe, expect, it } from 'vitest';
import type { ChannelDTO, HuddleParticipantDTO } from '@flow/shared';
import { applyChannelEmoji, applyHuddle, applyIndicator, isUnlistedChannel } from './channelCache';

const chan = (
  id: string,
  indicator?: ChannelDTO['indicator'],
  huddleParticipants?: HuddleParticipantDTO[],
  emoji?: string | null,
): ChannelDTO => ({
  id,
  workspaceId: 'w1',
  name: id,
  kind: 'standard',
  topic: null,
  isPrivate: false,
  createdBy: 'u1',
  createdAt: '2026-07-29T00:00:00Z',
  archivedAt: null,
  isMember: true,
  lastReadMsgId: null,
  unreadCount: 0,
  unreadNotifications: 0,
  unreadThreadRootIds: [],
  notifyLevel: 1,
  parentId: null,
  ...(indicator !== undefined ? { indicator } : {}),
  ...(huddleParticipants !== undefined ? { huddleParticipants } : {}),
  ...(emoji !== undefined ? { emoji } : {}),
});

describe('applyIndicator', () => {
  it('turns the spinner on for the named channel only', () => {
    const out = applyIndicator([chan('a'), chan('b')], { channelId: 'a', state: 'busy' });
    expect(out.map((c) => c.indicator ?? null)).toEqual(['busy', null]);
  });

  it('turns it back off', () => {
    const out = applyIndicator([chan('a', 'busy')], { channelId: 'a', state: null });
    expect(out[0]!.indicator).toBeNull();
  });

  it('keeps the same array when the channel is unknown', () => {
    // Events arrive for channels this client may not have loaded yet.
    const list = [chan('a')];
    expect(applyIndicator(list, { channelId: 'gone', state: 'busy' })).toBe(list);
  });

  it('keeps the same array when the state already matches', () => {
    // Identity matters: a new array re-renders the whole sidebar for nothing.
    const list = [chan('a', 'busy')];
    expect(applyIndicator(list, { channelId: 'a', state: 'busy' })).toBe(list);
    const off = [chan('a')];
    expect(applyIndicator(off, { channelId: 'a', state: null })).toBe(off);
  });

  it('does not mutate the channel it replaces', () => {
    const original = chan('a');
    applyIndicator([original], { channelId: 'a', state: 'busy' });
    expect(original.indicator ?? null).toBeNull();
  });
});

describe('applyHuddle', () => {
  const alice: HuddleParticipantDTO = { userId: 'alice', joinedAt: '2026-08-20T00:00:00Z' };
  const bob: HuddleParticipantDTO = { userId: 'bob', joinedAt: '2026-08-20T00:01:00Z' };

  it('sets the roster for the named channel only', () => {
    const out = applyHuddle([chan('a'), chan('b')], { channelId: 'a', participants: [alice] });
    expect(out[0]!.huddleParticipants).toEqual([alice]);
    expect(out[1]!.huddleParticipants ?? []).toEqual([]);
  });

  it('replaces the whole roster, not just adds', () => {
    const out = applyHuddle([chan('a', undefined, [alice])], { channelId: 'a', participants: [bob] });
    expect(out[0]!.huddleParticipants).toEqual([bob]);
  });

  it('an empty roster means the huddle ended', () => {
    const out = applyHuddle([chan('a', undefined, [alice, bob])], { channelId: 'a', participants: [] });
    expect(out[0]!.huddleParticipants).toEqual([]);
  });

  it('keeps the same array when the channel is unknown', () => {
    const list = [chan('a')];
    expect(applyHuddle(list, { channelId: 'gone', participants: [alice] })).toBe(list);
  });

  it('keeps the same array when the roster already matches', () => {
    const list = [chan('a', undefined, [alice])];
    expect(applyHuddle(list, { channelId: 'a', participants: [alice] })).toBe(list);
  });

  it('does not mutate the channel it replaces', () => {
    const original = chan('a');
    applyHuddle([original], { channelId: 'a', participants: [alice] });
    expect(original.huddleParticipants ?? []).toEqual([]);
  });
});

describe('applyChannelEmoji', () => {
  it('sets the emoji on the named channel only', () => {
    const out = applyChannelEmoji([chan('a'), chan('b')], { channelId: 'a', emoji: '🔥' });
    expect(out.map((c) => c.emoji ?? null)).toEqual(['🔥', null]);
  });

  it('replaces one emoji with another, and clears on null', () => {
    const set = applyChannelEmoji([chan('a', undefined, undefined, '🚧')], { channelId: 'a', emoji: '✅' });
    expect(set[0]!.emoji).toBe('✅');
    expect(applyChannelEmoji(set, { channelId: 'a', emoji: null })[0]!.emoji).toBeNull();
  });

  it('keeps the same array when the channel is unknown', () => {
    const list = [chan('a')];
    expect(applyChannelEmoji(list, { channelId: 'gone', emoji: '🔥' })).toBe(list);
  });

  it('keeps the same array when the emoji already matches', () => {
    const list = [chan('a', undefined, undefined, '🔥')];
    expect(applyChannelEmoji(list, { channelId: 'a', emoji: '🔥' })).toBe(list);
    const none = [chan('a')];
    expect(applyChannelEmoji(none, { channelId: 'a', emoji: null })).toBe(none);
  });

  it('does not mutate the channel it replaces', () => {
    const original = chan('a');
    applyChannelEmoji([original], { channelId: 'a', emoji: '🔥' });
    expect(original.emoji ?? null).toBeNull();
  });
});

describe('isUnlistedChannel (a meeting chat’s events)', () => {
  it('is a channel the loaded list leaves out, and nothing before the list loads', () => {
    expect(isUnlistedChannel([chan('a'), chan('b')], 'm1')).toBe(true);
    expect(isUnlistedChannel([chan('a'), chan('m1')], 'm1')).toBe(false);
    expect(isUnlistedChannel(undefined, 'm1')).toBe(false);
  });
});
