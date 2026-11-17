import { describe, expect, it } from 'vitest';
import { isMeetingChatFrameMessage, isMeetingChatShownMessage, meetingChatFramePath, parseMeetingChatFramePath } from './meetingChat';

describe('the meeting chat frame', () => {
  it('names Chat’s page for a member and for a guest, and reads it back', () => {
    const member = meetingChatFramePath({ channelId: 'c0ffee-1234', workspaceId: 'org-abc123', visitor: false });
    expect(member).toBe('/chat/meeting/c0ffee-1234?workspace=org-abc123');
    expect(parseMeetingChatFramePath('/chat/meeting/c0ffee-1234', '?workspace=org-abc123')).toEqual({ channelId: 'c0ffee-1234', workspaceId: 'org-abc123', visitor: false });
    const guest = meetingChatFramePath({ channelId: 'c0ffee-1234', workspaceId: null, visitor: true });
    expect(guest).toBe('/chat/meeting/c0ffee-1234?visitor=1');
    expect(parseMeetingChatFramePath('/chat/meeting/c0ffee-1234/', '?visitor=1')).toEqual({ channelId: 'c0ffee-1234', workspaceId: null, visitor: true });
  });

  it('is no other page', () => {
    expect(parseMeetingChatFramePath('/chat', '')).toBeNull();
    expect(parseMeetingChatFramePath('/chat/visit/abcdefabcdefabcdef', '')).toBeNull();
    expect(parseMeetingChatFramePath('/chat/meeting/../x', '')).toBeNull();
    expect(parseMeetingChatFramePath('/chat/meeting/', '')).toBeNull();
  });

  it('knows the page’s messages from anything else posted to the room', () => {
    expect(isMeetingChatFrameMessage({ type: 'flow:meeting-chat', event: 'message', mine: false })).toBe(true);
    expect(isMeetingChatFrameMessage({ type: 'flow:meeting-chat', event: 'message' })).toBe(false);
    expect(isMeetingChatFrameMessage({ type: 'other', event: 'message', mine: false })).toBe(false);
    expect(isMeetingChatFrameMessage('flow:meeting-chat')).toBe(false);
    expect(isMeetingChatFrameMessage(null)).toBe(false);
    expect(isMeetingChatShownMessage({ type: 'flow:meeting-chat', event: 'shown', shown: true })).toBe(true);
    expect(isMeetingChatShownMessage({ type: 'flow:meeting-chat', event: 'message', mine: true })).toBe(false);
    expect(isMeetingChatFrameMessage({ type: 'flow:meeting-chat', event: 'shown', shown: true })).toBe(false);
  });
});
