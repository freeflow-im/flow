# Admin: the Event log

- `[web]` Organization settings gains an Event log section (owners and admins): the organization's event log newest first, with filters by type pattern, actor kind, channel and text, paging older, and each event's envelope on a click: who acted, through which agent (`via`), who asked (`invokedBy`), which job caused it.
- `[server]` `GET /v1/events` takes `before`: a page newest first from the head (0) or below a seq, `next` being the oldest seq returned; and `text`.

## Feature

- **See what happened in your organization.** Organization settings has a new Event log: every message, file change, calendar change and share, newest first, with who did it and, for an agent, who asked it to. Filter by type, by people or agents, by channel, or by words.
