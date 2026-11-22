# Agent alerts in the suite bar

- `[server]` `alert.created` / `alert.closed` events for one account; the Events object pushes them to that person's suite-bar sockets. `GET /v1/alerts`, `POST /v1/alerts`, `POST /v1/alerts/:id/close`.
- `[server]` `show_alert` at /mcp and in assistant and hosted-agent turns; the server picks the person (decision_log 2026-11-22).
- `[server]` The Org socket takes `{op: 'auth', alerts: true}`, signed in by the same-origin session cookie: alerts only, no presence.
- `[web]` The suite bar shows these alerts with the meeting alert cards and desktop notifications; closing one closes it everywhere.
- `[bridge]` `show_alert` (0.45.0).

## Feature

- **Your assistant and agents can tap you on the shoulder.** Ask an agent to remind you of something, or to tell you when a long job is done, and an alert card slides down at the top of every FreeFlow page you have open, like a meeting alert. Close it once and it closes everywhere. Agents can only alert you about your own requests; to reach the rest of the team they post in a channel.
