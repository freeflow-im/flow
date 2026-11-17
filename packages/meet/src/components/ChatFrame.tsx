// The Chat tab's body (docs/specs/meetings.md §9 3b): Chat's own page for the room's chat in a frame, the way the
// suite's side panels show one app in another (@flow/suite-bar SidePanel). Chat's message list, thread and composer
// stay Chat's: Meet draws none of them. The frame stays mounted while the tab is closed (invisible, its size kept, so
// it opens where it was), tells the room of each new message for the dot, and hears from the room when it shows.
import { useEffect, useRef } from 'react';
import { MEETING_CHAT_FRAME_MESSAGE, type MeetingChatShownMessage } from '@flow/shared';
import { chatFrameUrl, type RoomChat } from '../lib/chat';

export function ChatFrame({ chat, shown, onPosted }: { chat: RoomChat; shown: boolean; onPosted: (data: unknown) => void }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const posted = useRef(onPosted);
  posted.current = onPosted;

  useEffect(() => {
    const on = (e: MessageEvent) => {
      if (e.origin !== window.location.origin || e.source !== frame.current?.contentWindow) return;
      posted.current(e.data);
    };
    window.addEventListener('message', on);
    return () => window.removeEventListener('message', on);
  }, []);

  const tell = () => {
    const note: MeetingChatShownMessage = { type: MEETING_CHAT_FRAME_MESSAGE, event: 'shown', shown };
    frame.current?.contentWindow?.postMessage(note, window.location.origin);
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(tell, [shown]);

  return (
    <iframe
      ref={frame}
      title="Meeting chat"
      src={chatFrameUrl(chat)}
      onLoad={tell}
      data-testid="meeting-chat-frame"
      className={shown ? 'min-h-0 w-full flex-1 border-0' : 'pointer-events-none invisible absolute inset-0 h-full w-full border-0'}
      tabIndex={shown ? undefined : -1}
    />
  );
}
