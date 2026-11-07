# The socket is a consumer; the bridge catches up after being offline (platform phase 2.3)

- `[server]` After each batch reaches the event log, every socket of the organization gets `{ op: 'cursor', seq }`.
- `[server]` `auth` takes `since`: the Org object replays the reader's Chat backlog from the log (pages of 200, up to 2,000, each event with its `seq`), then a cursor, then presence; `gap` first when `since` aged out.
- `[server]` `socket` delivery: a publish matching a socket subscription sends its consumer's sockets `{ op: 'subscription', id }`.
- `[web]` Each socket keeps its cursor (memory and sessionStorage), sends it as `since` on reconnect, and skips a replayed event at or below it; `notification.created` now counts once.
- `[bridge]` A `bridge:<agent id>` pull subscription per organization: read and acked before the socket opens, fed through the live path; the socket's cursor is acked every 30 s and on shutdown. Answered message ids (last 500) live in `state.json` beside `agent.json`, so a restart never answers twice. 0.37.4.

## Feature

An agent that was offline now answers the mentions it missed when it comes back, and a reconnecting web client no longer loses what happened while it was away.
