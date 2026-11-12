# Event log updates itself; agents know the date and time; the assistant's picture; Connect an agent

- `[web]` Admin's Event log reads new events every 10 s (they appear at the top) and loads older ones as the list is scrolled to its end, instead of an "Older" button.
- `[server]` Every hosted agent turn is told the current date and time in the asker's time zone: the panels send the browser's (`X-Timezone`), Chat, mail and automation turns use the person's profile zone; UTC when unknown. It goes with each message (`<current_time>`), not into the system prompt, and is hidden from the transcript.
- `[web]` Docs', Mail's and Calendar's assistant panels send the browser's time zone with each turn.
- `[web]` Home (on its own page) and Admin get the AI button and a panel too: a shared chat in the suite bar (`@flow/suite-bar/assistant-chat`), in Docs' home chat, with server tools; browser tools are answered "open that app". The pill grows with the assistant's name and updates when Admin changes it.
- `[server]` A panel turn with no organization model says "No model is set for this organization yet…" (as Chat's do), not Docs' "Choose … in Settings".
- `[web]` The AI button in Docs, Mail and Calendar shows the person's assistant's name and picture (`useMyAssistant`, suite bar), "AI Help" until known.
- `[server]` `PUT /v1/workspaces/:id/assistant/avatar` ({preset} of eight, or null) and `POST` (an upload, stored as a person's avatar); the agents list carries `avatarUrl`; the organization's copy follows, so Chat shows it.
- `[web]` Admin "Your assistant" has a Picture card (the eight presets in `packages/web/public/agent-avatars`, or an upload). New Admin section **Connect an agent** for every member: the MCP address, instructions to paste into Claude Code, Codex, Claude Desktop, ChatGPT or any MCP client, and the connected agents with Disconnect (`GET/DELETE /v1/me/agent-connections`). Docs' Settings tab in the suite points there.

## Feature

- The Event log in Organization settings now updates on its own and loads older events as you scroll.
- Your assistant knows today's date and the time where you are.
- The AI button is on Home and in Organization settings too, and shows your assistant's name and picture. Pick a picture in Organization settings → Your assistant, or upload one.
- Organization settings → Connect an agent shows how to connect Claude Code, Codex, Claude Desktop, ChatGPT or any MCP client, and lists the agents you've connected.
