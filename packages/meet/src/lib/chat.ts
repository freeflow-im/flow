// The room's chat (docs/specs/meetings.md §9 3b): which conversation the Chat tab shows, the address of Chat's page for
// it (shown in a frame, as the suite's side panels show one app in another), and the dot on the tab.
import { isMeetingChatFrameMessage, meetingChatFramePath, type MeetingDTO, type MeetingGuestJoinDTO } from '@flow/shared';

export interface RoomChat {
  channelId: string;
  /** The organization the chat is in, for a member's page; a guest's page learns it from the visit. */
  workspaceId: string | null;
  /** A guest: the page reads and posts as the visitor the guest join made. */
  visitor: boolean;
}

/**
 * A member's chat: the room's chat channel, or a huddle's own conversation (a huddle has no chat channel; its talk
 * stays in the DM or channel it was started from). Null before the room has a chat.
 */
export function memberChat(meeting: Pick<MeetingDTO, 'chatChannelId' | 'channelId' | 'workspaceId'>): RoomChat | null {
  const channelId = meeting.chatChannelId ?? meeting.channelId;
  return channelId ? { channelId, workspaceId: meeting.workspaceId, visitor: false } : null;
}

/** A guest's chat: the meeting chat they are a visitor of, or none (the organization has visitors off). */
export function guestChat(join: Pick<MeetingGuestJoinDTO, 'chatChannelId'>): RoomChat | null {
  return join.chatChannelId ? { channelId: join.chatChannelId, workspaceId: null, visitor: true } : null;
}

/** Chat's page for the room's chat. */
export const chatFrameUrl = (chat: RoomChat) => meetingChatFramePath(chat);

/**
 * The Chat tab's count of messages not seen yet, after something was posted to the room: a message from someone
 * else, while the tab is closed, adds one. Anything else (the person's own message, another page's post) changes
 * nothing.
 */
export function unseenAfter(unseen: number, data: unknown, chatOpen: boolean): number {
  if (!isMeetingChatFrameMessage(data) || data.mine || chatOpen) return unseen;
  return unseen + 1;
}
