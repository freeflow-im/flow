# Meet phase 3b: meeting chat

- [server] Channel kind `meeting`: each Meet room (not a huddle) gets one private, nameless channel on its first join (`meetings.chat_channel_id`, migration `0012_meeting_chat`); the creator and each member who joins are its members. `MeetingDTO.chatChannelId`, `ChannelDTO.meeting`.
- [server] A date line per session (`systemKind: 'meeting_started'`, "Meeting started · Mon 16 Nov"), on the first join while RealtimeKit has no session, or `meeting.started`.
- [server] Left out of `GET …/channels`; listed by `GET /v1/workspaces/:id/meetings/chats` (live first, then newest). Its messages notify only direct @mentions.
- [server] Meet guests become visitors of the meeting chat: the guest join sets the `vsid` cookie and returns `chatChannelId`. A visit ends on `meeting.ended`, or when the next session starts. Visitor links stay public-channel only.
- [server] A stale or expired session cookie no longer stops someone joining a meeting link as a guest.
- [web] Meet's room has a Chat tab (with a dot for new messages): Chat's page `/chat/meeting/<channelId>` in a frame, the shared message list, thread and composer on the member's session or, for a guest, the visitor cookie. A huddle's tab shows its own conversation.
- [web] Chat's sidebar has Meetings (live first, with Join; mention badge); a meeting chat opens in the channel view titled by its meeting, with Open meeting / Join. Its socket events never add a sidebar row or an unread count.
- [web] The `meeting_started` line draws as a divider with its date.

## Feature

- **Chat in a meeting.** Meet has a Chat tab beside People: everyone in the meeting, guests included, can post, reply in threads, react and share files. A dot on the Chat button tells you something new was posted while it was closed. Guests see the chat from when they joined.
- **Meetings in Chat.** Chat's sidebar has Meetings: the chats of the meetings you joined, newest first, with a live meeting at the top and a Join button. Open one to read it as a channel, with a line for each time the meeting met. Only mentions of you count as unread there.
