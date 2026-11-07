# Wake jobs through a Queue, and schedules (platform phase 2.4)

- `[server]` Subscriptions take an `action`: `wake` (an agent, made by its sponsor or an owner/admin, else 403 `agent_forbidden`) files an `agent_jobs` row and an `agent.job` event on the agent; `post` posts into a channel as the owner.
- `[server]` Jobs go `delivered → running → done | failed` via `/v1/events/jobs/:id/{ack,extend,done}`, listed at `GET /v1/events/jobs?subscription=`; the `flow-jobs` Queue (DLQ `flow-jobs-dlq`) re-delivers an unacked job or lapsed lease, and parks it after three, telling the owner.
- `[server]` Loop safety: requests with `x-flow-job` stamp `causedBy` and depth; actions skip their consumer's own events and anything at depth 4 (`MAX_EVENT_DEPTH`).
- `[server]` Schedules (`hourly`, `daily@`, `weekly@`, `monthly@`) publish `schedule.tick` from the Events object's alarm. Scheduled messages are untouched; re-basing them on this is a follow-up.
- `[server]` `/mcp`: `create_subscription` takes wake/post actions and `schedule`; new `list_jobs`.
- `[bridge]` Handles `agent.job` (catch-up and a `bridge-jobs:` socket subscription): acks, runs it as a task turn with `x-flow-job` on every request, extends the lease every 5 min, reports done/failed; job ids dedupe in `state.json`. 0.37.5.

## Feature

An agent can now be woken by an event or on a schedule: its sponsor sets up an automation (say, "summarize every new message in #general", or "every morning at 9") and the agent runs it as a task, retried if it does not pick it up.
