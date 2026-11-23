# Agents remember what they did: Meet events, search_events, Meeting notes automation

- `[server]` Meet logs `meet.agent.joined` and `meet.ended` as the agent's own events; `meet.ended` comes once the
  transcript is saved, or without one 30 minutes after the agent left.
- `[server]` New `search_events` tool (/mcp and every agent turn): the event log, newest first, as the turn's account.
- `[server]` Meeting Notes now come from a built-in "Meeting notes" automation per agent (owned by its sponsor) that calls
  the new `save_meeting_notes` tool and writes a memory entry; the server-run Notes turn is gone.
- `[server]` `[web]` Automations can be edited: `PATCH /v1/events/subscriptions/:id` (name, prompt, message) and an Edit
  button in Admin › Automations.

## Feature

- **Agents remember meetings they attended.** After a meeting you sent your agent to, it saves its notes and keeps a
  short memory of the meeting, so you can ask about it later in any conversation.
- **Agents can look back at what they did.** Ask your agent about a message, file or meeting from another conversation
  and it searches its recent activity.
- **Edit an automation.** Change an automation's name or what the agent is asked to do, from the Automations list.
