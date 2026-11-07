# The Automations page (platform phase 2.5)

- `[server]` Member rows carry the member's `accountId`, which a wake subscription names as its `consumer`.
- `[web]` An Automations tab beside Organization in the admin panel, open to every member from the workspace menu: the
  subscriptions they consume or own (filter, action, cursor, parked), a wake row's recent jobs, and Delete with a confirm.
- `[web]` A New automation form: when an event happens or on a schedule, then wake an agent or post a message; the
  server's refusal (such as `agent_forbidden`) is shown as it says it.

## Feature

- **Automations.** From the workspace menu, open Automations to have an agent woken, or a message posted, whenever
  something happens (a new message, a reaction, mail arriving) or on a schedule (every hour, day, week or month), and to
  see what each automation has done.
