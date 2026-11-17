import { describe, expect, it } from 'vitest';
import { chatFrameUrl, guestChat, memberChat, unseenAfter } from './chat';

describe('the room’s chat', () => {
  it('is the room’s chat channel for a member, or a huddle’s own conversation', () => {
    expect(memberChat({ chatChannelId: 'chan-meet', channelId: null, workspaceId: 'org-1abc' })).toEqual({ channelId: 'chan-meet', workspaceId: 'org-1abc', visitor: false });
    expect(memberChat({ chatChannelId: null, channelId: 'dm-ann-bob', workspaceId: 'org-1abc' })).toEqual({ channelId: 'dm-ann-bob', workspaceId: 'org-1abc', visitor: false });
    expect(memberChat({ chatChannelId: null, channelId: null, workspaceId: 'org-1abc' })).toBeNull();
  });

  it('is the meeting chat a guest visits, or none with visitors off', () => {
    expect(guestChat({ chatChannelId: 'chan-meet' })).toEqual({ channelId: 'chan-meet', workspaceId: null, visitor: true });
    expect(guestChat({ chatChannelId: null })).toBeNull();
  });

  it('shows Chat’s page for it in the frame', () => {
    expect(chatFrameUrl({ channelId: 'chan-meet', workspaceId: 'org-1abc', visitor: false })).toBe('/chat/meeting/chan-meet?workspace=org-1abc');
    expect(chatFrameUrl({ channelId: 'chan-meet', workspaceId: null, visitor: true })).toBe('/chat/meeting/chan-meet?visitor=1');
  });

  it('counts someone else’s messages while the Chat tab is closed', () => {
    const theirs = { type: 'flow:meeting-chat', event: 'message', mine: false };
    const mine = { ...theirs, mine: true };
    expect(unseenAfter(0, theirs, false)).toBe(1);
    expect(unseenAfter(1, theirs, false)).toBe(2);
    expect(unseenAfter(1, theirs, true)).toBe(1);
    expect(unseenAfter(0, mine, false)).toBe(0);
    expect(unseenAfter(0, { type: 'something-else' }, false)).toBe(0);
  });
});
