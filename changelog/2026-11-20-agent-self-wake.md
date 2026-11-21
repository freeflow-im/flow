# Agents can wake themselves later

- `[server]` `schedule_wake`, `list_wakes`, `cancel_wake` (and `/v1/events/wakes`): an agent's one-time wake for itself, answering in the thread it was set from. No sponsor check; 10 waiting, 1 min–365 days ahead, 100 a day per agent.
- `[server]` One-time schedules (`every: once`), spent and swept after 7 days; wake jobs and automation posts carry a thread. Spec: `docs/specs/agent-self-wake.md`.
- `[web]` Automations shows an agent's own wakes as "once, at …" with Cancel.
- `[bridge]` 0.42.0: the three wake tools; a wake job with a thread runs in that thread.

## Feature

- **Agents can come back to something later.** Ask an agent to "check again in 20 minutes" or "remind me Friday at 9", and it wakes itself at that time and answers in the same thread. You can see and cancel the wakes it set on the Automations page.
