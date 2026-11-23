# Agents remember what they did: Meet events, search_events, a Meeting notes automation

- `[server]` Meet publishes `meet.agent_joined` and `meet.ended` (one per agent that attended, with attendees and transcript/recording links), also when there is no transcript.
- `[server]` New agent tool `search_events`: the agent's own events plus those of the person who started the turn, by type, time, actor and text.
- `[server]` Built-in "Meeting notes" automation on `meet.ended` replaces phase 5's headless Notes turn: notes go to the sender's My files, and the agent writes a memory entry.
- `[web]` Admin › Automations: Edit an automation's name and instruction (`PATCH /v1/events/subscriptions/:id`).

## Feature

- **Agents remember meetings and what they did.** Ask an agent about a meeting you sent it to, or anything it did earlier, from any conversation, and it can look it up.
- **Meeting notes land in your files.** After a meeting, the agent you sent saves its notes in your My files and tells you. It is an automation you can see, edit or delete in Automations.
- **Edit automations.** Change an automation's name or instruction without making it again.
