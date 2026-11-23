# Meet agents: send an agent to record and write notes (Meet phase 5, Taskboard task 29)

- `[server]` `POST`/`GET`/`DELETE /v1/meetings/:id/agents`: send your own hosted agent or a shared hosted one; it joins RTK as `agent:<id>` (preset `flow_agent`), enters the meeting chat and starts recording.
- `[server]` New `MeetingAgent` Durable Object holds RTK's agent WebSocket and leaves once no person is in the room (4 h at most).
- `[server]` After the transcript is saved, each agent's model writes Notes (Assistant `meetingNotes`), saved in the meeting's Docs folder by its sender and linked in the chat as the agent.
- `[web]` `[desktop]` Meet room: "Send an agent" in People, an Agent label and Send away.
- Operator: run `packages/edge/scripts/rtk-presets.mjs` on the production RTK app to make `flow_agent`.

## Feature

- **Send an agent to a meeting.** In a Meet call, open People and send your assistant or one of your organization's shared agents. It records the meeting, and when the meeting ends it writes notes (a summary, decisions and action items) next to the recording in Docs › Meetings and links them in the meeting's chat. It cannot hear the call, but you can @mention it in the meeting's chat.
