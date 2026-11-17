# Meet phase 3b: meeting chat (server)

- [server] Channel kind `meeting`: each Meet room (not a huddle) gets one private, nameless channel on its first join (`meetings.chat_channel_id`, migration `0012_meeting_chat`); the creator and each member who joins are its members. `MeetingDTO.chatChannelId`, `ChannelDTO.meeting`.
- [server] A date line per session (`systemKind: 'meeting_started'`, "Meeting started · Mon 16 Nov"), on the first join while RealtimeKit has no session, or `meeting.started`.
- [server] Left out of `GET …/channels`; listed by `GET /v1/workspaces/:id/meetings/chats` (live first, then newest). Its messages notify only direct @mentions.
- [server] Meet guests become visitors of the meeting chat: the guest join sets the `vsid` cookie and returns `chatChannelId`. A visit ends on `meeting.ended`, or when the next session starts. Visitor links stay public-channel only.
