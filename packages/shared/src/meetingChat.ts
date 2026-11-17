// A meeting's chat inside Meet (docs/specs/meetings.md §9 3b). Meet's room shows the chat as Chat's own page in a frame,
// as the suite's side panels show one app inside another: Chat's page for it is `/chat/meeting/<channelId>`, which runs
// Chat's message list, thread and composer for a member (their session) or for a guest (the visitor cookie the guest
// join set). The page tells the room about each new message with a `postMessage`, for the dot on the Chat tab.
import { CHAT_PATH } from './addresses.js';

/** The `type` of every message the chat page posts to the room that frames it. */
export const MEETING_CHAT_FRAME_MESSAGE = 'flow:meeting-chat';

/** What the chat page tells the room: a message arrived (`mine` when the person in the room sent it). */
export interface MeetingChatFrameMessage {
  type: typeof MEETING_CHAT_FRAME_MESSAGE;
  event: 'message';
  mine: boolean;
}

/** What the room tells the chat page: whether the person can see it now (the Chat tab is open), so it reads it. */
export interface MeetingChatShownMessage {
  type: typeof MEETING_CHAT_FRAME_MESSAGE;
  event: 'shown';
  shown: boolean;
}

export interface MeetingChatFrameTarget {
  channelId: string;
  /** The organization the channel is in (a member's page reads its roster); a guest's page learns it from the visit. */
  workspaceId: string | null;
  /** A guest: the page reads and posts as the visitor the guest join made. */
  visitor: boolean;
}

const base = () => CHAT_PATH.replace(/\/$/, '');
const ID = /^[A-Za-z0-9_-]{6,64}$/;

/** Chat's page for a meeting's chat, for the room's frame. */
export function meetingChatFramePath(t: MeetingChatFrameTarget): string {
  const parts: string[] = [];
  if (t.workspaceId) parts.push(`workspace=${encodeURIComponent(t.workspaceId)}`);
  if (t.visitor) parts.push('visitor=1');
  const query = parts.join('&');
  return `${base()}/meeting/${encodeURIComponent(t.channelId)}${query ? `?${query}` : ''}`;
}

/** The chat a `/chat/meeting/<channelId>` page shows, or null for any other page. */
export function parseMeetingChatFramePath(pathname: string, search: string): MeetingChatFrameTarget | null {
  const prefix = `${base()}/meeting/`;
  if (!pathname.startsWith(prefix)) return null;
  const id = pathname.slice(prefix.length).replace(/\/$/, '');
  if (!ID.test(id)) return null;
  const q = new Map<string, string>();
  for (const pair of search.replace(/^\?/, '').split('&')) {
    const at = pair.indexOf('=');
    if (at > 0) q.set(pair.slice(0, at), pair.slice(at + 1));
  }
  const ws = q.get('workspace');
  return { channelId: id, workspaceId: ws && ID.test(ws) ? ws : null, visitor: q.get('visitor') === '1' };
}

/** Whether a `postMessage` payload is the chat page's. */
export function isMeetingChatFrameMessage(data: unknown): data is MeetingChatFrameMessage {
  const d = data as Partial<MeetingChatFrameMessage> | null;
  return !!d && typeof d === 'object' && d.type === MEETING_CHAT_FRAME_MESSAGE && d.event === 'message' && typeof d.mine === 'boolean';
}

/** Whether a `postMessage` payload is the room's "the chat shows now / no longer". */
export function isMeetingChatShownMessage(data: unknown): data is MeetingChatShownMessage {
  const d = data as Partial<MeetingChatShownMessage> | null;
  return !!d && typeof d === 'object' && d.type === MEETING_CHAT_FRAME_MESSAGE && d.event === 'shown' && typeof d.shown === 'boolean';
}
