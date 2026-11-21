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

Three tools, for agents only, in the `events` app, on both doors (`mcp` and `assistant`):

| Tool | Input | Does |
| --- | --- | --- |
| `schedule_wake` | `prompt`, one of `at` (ISO time with offset) or `in_minutes`; optional `channelId`, `threadId`, `name` | Makes a one-time wake subscription whose consumer is the caller. Returns its id and the time it fires. |
| `list_wakes` | none | The caller's own pending wakes: id, name, prompt, time, channel and thread. |
| `cancel_wake` | `wake_id` | Deletes one of the caller's own wakes. |

Rules:

1. **The consumer is always the caller.** There is no `consumer` input. A person calling `schedule_wake` gets
   `not_an_agent`. Waking a different agent stays with `create_subscription` and its sponsor rule.
2. **Self-wake needs no sponsor check.** An agent may always queue work for itself; it can already act now, so acting
   later gives it no new access. The turn runs with the agent's own grants at the time it fires, not the grants it had
   when it scheduled.
3. **Where it runs.** `channelId` and `threadId` default to the channel and thread of the turn that scheduled it, so
   the answer lands in the same thread ("remind me here" works). The agent must be a member of the channel it names. A personal agent's wake runs only where its sponsor alone
   reads (its DM with the sponsor or its own channel), as all its turns do today (`agents.md` §1.1).
4. **Wakes are one-time only.** An agent that wants to check again schedules a new wake in the woken turn.
5. **One-time wakes clean up.** After a one-time wake fires, its schedule row is deleted and its subscription is
   marked spent. Spent subscriptions are deleted 7 days later, so `list_jobs` still shows what happened.

## 2. How it is stored

No new tables. A one-time wake is a subscription with a schedule, like a repeating one:

- `schedules` gets `every = 'once'` and `next_at = at`. `tickSchedules` deletes the row after the tick instead of
  computing the next time. `SCHEDULE_EVERY` stays as it is; `once` is accepted only from the new code path.
- `subscriptions` gets a `spent_at` column (nullable), set when a one-time tick fires. The daily retention pass in the
  alarm deletes spent subscriptions older than 7 days, and their jobs.
- `subscriptions.created_by` = the agent, `owner` = the agent, `consumer` = the agent. A new `self_wake` flag (or
  `owner = consumer` with `delivery = 'wake'`) marks these for the limits and the UI.
- The wake action gains an optional `threadId`. It is copied to the `agent_jobs` row and passed to
  `Org.postAutomation`, which today takes only a channel, so the woken turn's answer is a reply in that thread. Bridge
  agents get the thread in the job brief.
- The `schedule.tick` data gains `once: true` and the wake brief (changelog `2026-11-20-wake-brief.md`) says
  "You asked to be woken at <time>" with the prompt, so the agent knows it set this up itself.

People get the same one-time option in `create_subscription` (`schedule: {at}`), so the Automations page can offer
"once, at …" for any automation. This is cheap once the storage exists, but it is optional for the first PR.

## 3. Limits and loop safety

A self-wake is the one way an agent can make itself run again with no person or outside event involved, so it needs
its own limits. A tick has `actor: null` and depth 0, so the existing self-skip rule and depth cap do not stop a chain
of wakes that each schedule the next one.

| Limit | Value | Why |
| --- | --- | --- |
| Pending self-wakes per agent | 10 | Bounds how many turns can be queued at once. |
| Shortest delay | 1 minute from now | Stops "wake me now" loops. |
| Longest delay | 365 days | Keeps the table from filling with far-off rows. |
| Self-woken turns per agent per day | 100 | Bounds model spend if an agent keeps rescheduling itself. Past it, the tick is skipped and the sponsor (or the admins, for a shared agent) is told once that day, through the existing `notify` path. |

The depth cap is not carried across a self-wake: time is the brake, and the daily cap is the backstop. Carrying depth
would stop a valid "check every hour until it merges" chain (each turn scheduling the next) after four steps.

All four values are constants in `shared/platform.ts` so they are easy to change after we see real use.

## 4. Who can see and stop them

- **The sponsor** sees a personal or shared agent's pending wakes in the Automations page, grouped under the agent, and
  can cancel any of them.
- **Owners and admins** see and cancel a shared agent's wakes in the Admin app's Agents section.
- **When an agent is removed or suspended**, its self-wakes are deleted. Nothing deletes an agent's subscriptions
  today, so this is new work in step 2.
- `list_jobs` already works for the subscription's agent, so the agent can check whether an earlier wake ran.

## 5. Clients

- **Web**: the Automations page lists self-wakes under each agent with a Cancel button; the Admin Agents section the
  same for shared agents.
- **Bridge**: nothing to release. The tools are server tools on `/mcp`, and the bridge already takes wake jobs. The
  `flow-agent-member` skill text gains one line naming `schedule_wake`.
- **macOS, iOS, desktop**: nothing new to show; a self-wake's turn appears in the channel like any other agent turn.
  Automations is web only today, so no Parity line is needed.

## 6. Build (one PR, phases as commits)

1. Storage: `once` schedules, `spent_at`, the retention sweep, tests in `events/core.test.ts` and `schedule.test.ts`.
2. Thread: `threadId` on the wake action and the job, and `postAutomation` replying in a thread.
3. Tools: `schedule_wake`, `list_wakes`, `cancel_wake` in `shared/toolDefinitions/events.ts` and
   `edge/src/events/eventTools.ts`; the self-consumer path in `subscriptions.ts`; limits; tests for the forbidden,
   limit and personal-agent cases.
4. Brief: "you asked to be woken" in the wake brief; the daily-cap notice.
5. Web: Automations and Admin Agents listing with Cancel.
6. Docs: `platform.md` §5.2 and `agents.md` §8 updated; skill line; changelog entry.

Exit: a hosted agent, asked in Chat "check this again in 2 minutes", calls `schedule_wake`, and 2 minutes later runs a
turn that replies in the same thread; an 11th pending wake is refused; a person calling `schedule_wake` is refused; the sponsor
cancels a pending wake from the Automations page and it does not fire.

## 7. Rulings (operator, 2026-11-20)

1. **Same thread.** A self-wake answers in the thread of the turn that scheduled it.
2. **One-time wakes only.** No repeating self-wakes; an agent reschedules itself if it needs to.
3. **The limits in §3 stand**: 10 pending, 1 minute shortest, 365 days longest, 100 self-woken turns a day.
4. **No approval.** The sponsor does not approve self-wakes; the Automations listing and Cancel are enough.
