# The assistant is its own object per account (platform phase 6.3)

- `[server]` New `Assistant` Durable Object (binding `ASSISTANT`, migration `v7`), one per account: it holds the chats, assistant settings and usage, and runs the model loop with the registry's tools.
- `[server]` Docs' tools reach the organization's Docs object over HTTP as the person (new small routes `/api/places/:id`, `/api/files/:id/pdf`, `/api/import/bytes`); Mail's and Calendar's reach the account's objects. The open app's browser tools come from the manifests' `assistant.pages`.
- `[server]` `/api/agent`, `/api/agent/turn`, `/api/agent/reset`, `/api/agent/permission` and `/api/settings/assistant` are served by the account's Assistant object; the Docs object keeps no assistant in the suite (the desktop app and standalone server keep theirs in-process).
- `[server]` Deploy: after it is live, run `POST /v1/admin/assistant/migrate` (header `x-edge-secret`) once to copy the chats, settings and usage from the Docs objects; it can run again, takes `{ organizations: [...] }`, and leaves the old rows as the rollback.

## Feature

- **One assistant wherever you work.** Your assistant's chats and settings follow you across Docs, Mail and Calendar in an organization.
