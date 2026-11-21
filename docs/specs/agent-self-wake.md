# Agents that wake themselves

Status: approved 2026-11-20 (operator rulings in §7). Builds on the event bus (`platform.md` §5.2) and hosted agents (`agents.md` §6).

## 0. The problem

An agent often needs to come back to something later: "check the deploy in 20 minutes", "remind Ann on Friday at
9:00", "look at this PR every hour until it merges". Today it cannot arrange that itself.

- `create_subscription` with `delivery: 'wake'` is the only way to wake an agent, and only the agent's sponsor or an
  owner or admin may make one (`edge/src/events/subscriptions.ts`). When the agent calls it, the caller is the agent,
  which is not its own sponsor, so it gets `agent_forbidden`. Only an agent whose own role is owner or admin (Carl)
  gets through.
- Schedules only repeat (`SCHEDULE_EVERY`: hourly, daily, weekdays, weekly, monthly). There is no "once, at this
  time" and no "in N minutes".
- Agents have no tool to delete a subscription, so even Carl cannot clean up a repeating timer it made.

The same gap applies to hosted agents (the `AgentRuntime` / headless loop) and to bridge agents, since both take wake
jobs from `agent_jobs`.

## 1. What we build

Three tools, for agents only, in the `events` app, at every door: `/mcp`, the hosted agents' turns (`assistant`) and
the bridge's own `flow` MCP server (which calls the HTTP routes below):

| Tool | Input | Does |
| --- | --- | --- |
| `schedule_wake` | `prompt`, one of `at` (ISO time with offset) or `in_minutes`; optional `channelId`, `threadRootId`, `name` | Makes a one-time wake subscription whose consumer is the caller. Returns its id and the time it fires. |
| `list_wakes` | none | The caller's own waiting wakes: id, name, prompt, time, channel and thread. |
| `cancel_wake` | `wake_id` | Deletes one of the caller's own waiting wakes. |

HTTP, as the caller's account (`?workspace=`): `POST /v1/events/wakes` (`ScheduleWakeBody`), `GET /v1/events/wakes`,
`DELETE /v1/events/wakes/:id`. One implementation behind all of them: `wakesAs` in `edge/src/events/subscriptions.ts`.

Rules:

1. **The consumer is always the caller.** There is no `consumer` input. A caller that is no agent gets
   `not_an_agent`. Waking a different agent stays with `create_subscription` and its sponsor rule.
2. **Self-wake needs no sponsor check.** An agent may always queue work for itself; it can already act now, so acting
   later gives it no new access. The turn runs with the agent's own grants at the time it fires.
3. **Where it answers.** With `channelId` (and `threadRootId` in it): a channel whose members include the user the
   agent posts as (its sponsor for a person's assistant, itself otherwise). Without: the channel and thread of the turn
   that set it (a Chat turn, or the wake job's own place). With neither, a person's assistant (in the panel) answers in
   its DM with its sponsor; any other agent is asked to name a channel. On the bridge, the tool fills in the current
   conversation's channel and thread.
4. **Wakes are one-time only.** An agent that wants to check again sets a new wake in the woken turn.
5. **One-time wakes clean up.** When a wake fires, its schedule row is deleted and its subscription is marked spent.
   Spent subscriptions are not listed, and are deleted 7 days later with their jobs, so `list_jobs` still shows what
   happened meanwhile.

## 2. How it is stored

No new tables. A self-wake is a `wake` subscription with a one-time schedule:

- `schedules.every = 'once'`, `next_at` = the time. `tickSchedules` deletes the row as it ticks instead of computing a
  next time. `SCHEDULE_EVERY` is unchanged: `once` comes only from `scheduleSelfWake`, so "a schedule with every once"
  is what marks a self-wake. "Run now" refuses it.
- `subscriptions.spent_at` (migration 7), set as the tick fires. The daily retention pass deletes spent subscriptions
  older than `SELF_WAKE_KEEP_MS`.
- `consumer` = `created_by` = the agent; `owner` = its sponsor's account when it has one in the organization, else the
  agent itself (`Org.selfWakeOwnerOf`). So the sponsor sees it among their automations, can cancel it there with the
  existing delete, and gets the notices; the tick is the sponsor's to read, as every schedule's tick is its owner's.
- The wake action has an optional `threadRootId` (it needs `channelId`). It is copied to `agent_jobs.thread_root_id`
  (migration 7) and to the `agent.job` event. A hosted shared agent answers with `Org.postAutomation`, which now takes a
  thread; a person's assistant answers its own wake with `postAsAssistant`, as itself, as its Chat replies are; the
  bridge runs the job as a task message in that thread.
- The `schedule.tick` data has `once: true`, and the wake brief says "You asked to be woken now", with the note and
  where the answer goes, so the agent knows it set this up itself.

## 3. Limits and loop safety

A self-wake is the one way an agent can make itself run again with no person or outside event involved, so it needs
its own limits. A tick has `actor: null` and depth 0, so the existing self-skip rule and depth cap do not stop a chain
of wakes that each set the next one.

| Limit | Value | Why |
| --- | --- | --- |
| Waiting self-wakes per agent | 10 | Bounds how many turns can be queued at once. |
| Shortest delay | 1 minute from now | Stops "wake me now" loops. |
| Longest delay | 365 days | Keeps the table from filling with far-off rows. |
| Self-woken turns per agent per UTC day | 100 | Bounds model spend if an agent keeps rescheduling itself. Past it, the tick is dropped (the wake is spent, no job) and the owner is told once that day (`automationNotice`, why `daily`). |

The count per day is a row in `events_meta` (`self_wake:<day>:<agent>`), swept after a day. The depth cap is not
carried across a self-wake: time is the brake, and the daily cap is the backstop. Carrying depth would stop a valid
"check every hour until it merges" chain after four steps.

The values are constants in `shared/platform.ts` (`SELF_WAKE_*`).

## 4. Who can see and stop them

- **The sponsor** sees an agent's waiting wakes in Admin → Automations (the page lists what the caller owns), shown as
  "once, at …, <agent> set this itself", with **Cancel** in place of Delete and no Run now.
- **A shared agent with no sponsor** owns its own wakes; only the agent sees them (`list_wakes`). Admins see them in
  the Event log.
- **When an agent is removed**, its self-wake is deleted when it comes due instead of waking it (checked with
  `Org.agentSponsorOf`).
- `list_jobs` works for the subscription's agent, so the agent can check whether an earlier wake ran.

## 5. Clients

- **Web**: Admin → Automations shows self-wakes as above.
- **Bridge** (0.42.0): `schedule_wake`, `list_wakes`, `cancel_wake` on its `flow` MCP server, and wake jobs that carry
  a thread run in that thread. The `flow-agent-member` skill lists the tools.
- **macOS, iOS, desktop**: nothing new to show; a self-wake's turn appears in the channel like any other agent turn.
  Automations is web only, so no Parity line is needed.

## 6. Build

One PR. Exit: a hosted agent, asked in Chat "check this again in 2 minutes", calls `schedule_wake`, and 2 minutes later
runs a turn that replies in the same thread; an 11th waiting wake is refused; a person calling `schedule_wake` is
refused; the sponsor cancels a waiting wake from Automations and it does not fire.

## 7. Rulings (operator, 2026-11-20)

1. **Same thread.** A self-wake answers in the thread of the turn that set it.
2. **One-time wakes only.** No repeating self-wakes; an agent reschedules itself if it needs to.
3. **The limits in §3 stand**: 10 pending, 1 minute shortest, 365 days longest, 100 self-woken turns a day.
4. **No approval.** The sponsor does not approve self-wakes; the Automations listing and Cancel are enough.
