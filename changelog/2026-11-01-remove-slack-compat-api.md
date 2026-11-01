# Remove the Slack-compatible API

- `[server]` The Slack Web API surface at `/api/*`, bot (`xoxb-`) and app-level (`xapp-`) tokens, Socket Mode at `/api/socket-mode`, the Events API outbox and its worker are gone; `/api` is reserved for the Workspace app's API (docs/specs/freeflow-suite.md §2.0). Migration 0047 drops `apps`, `pending_app_events` and `app_socket_tickets`; app bot users are tombstoned and removed from their workspaces, their messages kept.
- `[server]` `/v1/workspaces/:id/apps` and `/v1/apps/*` (create, list, credentials, rotate, enable, disable, delete) are removed; `@fastify/formbody` is no longer needed.
- `[web]` Manage Apps… leaves the workspace menu with the Apps modal. The sidebar's Apps section (mini apps, #394) is unchanged.
- `[server]` `@flow/shared` loses `AppDTO`, `APP_EVENT_TYPES`, `CreateAppBody`, `UpdateAppBody` and the `mrkdwn` helpers; `replicaSafety.test.ts` drops the outbox-claiming case (`pushOutbox.test.ts` covers the pattern).
- `[qa]` The FreeFlow suite design is checked in as `docs/specs/freeflow-suite.md`, with the operator's rulings in `decision_log.md`.
