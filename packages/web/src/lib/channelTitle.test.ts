import { describe, expect, it } from 'vitest';
import type { ChannelDTO } from '@flow/shared';
import { dmTitle } from './channelTitle';

const names = { me: 'Me', a: 'Ada', b: 'Bo' };

const chan = (over: Partial<ChannelDTO>): ChannelDTO =>
  ({
    id: 'c1',
    workspaceId: 'w1',
    name: null,
    kind: 'standard',
    topic: null,
    isPrivate: false,
    createdBy: 'me',
    createdAt: '2026-01-01T00:00:00.000Z',
    archivedAt: null,
    isMember: true,
    lastReadMsgId: null,
    unreadCount: 0,
    ...over,
  }) as ChannelDTO;

describe('dmTitle', () => {
  it('names a 1:1 DM after the other member', () => {
    expect(dmTitle(chan({ kind: 'dm', memberIds: ['me', 'a'] }), names, 'me')).toBe('Ada');
  });

  it('names a group DM after every other member', () => {
    expect(dmTitle(chan({ kind: 'group_dm', memberIds: ['b', 'me', 'a'] }), names, 'me')).toBe(
      'Ada, Bo',
    );
  });

  it('names the self-DM after you', () => {
    expect(dmTitle(chan({ kind: 'dm', memberIds: ['me'] }), names, 'me')).toBe('Me (you)');
  });

  it('names a meeting chat after its meeting', () => {
    expect(dmTitle(chan({ kind: 'meeting', isPrivate: true, meeting: { code: 'kqd-wmzt-fra', title: 'Weekly sync' } }), names, 'me')).toBe('Weekly sync');
    expect(dmTitle(chan({ kind: 'meeting', isPrivate: true }), names, 'me')).toBe('Meeting');
  });
});
