# Admin: the organization's settings as an app of its own (phase 1)

- `[web]` New `packages/admin`, FreeFlow Admin at `/admin`, added by its manifest (no object, routes or suite tab): the suite bar, a section list, and the **General** section — name (now editable: `PATCH /v1/workspaces/:id { name }`), the read-only platform address, icon and color, custom emoji, who can invite, the join link, Google sign-in self-registration, who can add agents, sharing by link, link previews (`unfurlEnabled` and `unfurlDomainAllowlist` join `WorkspaceDTO`), and the owner's transfer and delete. Spec: `docs/specs/workspace-admin.md`.
- `[web]` Every app's suite bar opens it as **Organization settings** (`intent.admin(section?)`, `adminAddress`); Chat's workspace menu gains "Organization settings…" and loses "Workspace appearance…" and "Custom Emoji…", whose modals are deleted. Chat's admin panel (Manage Users, Agents, Automations) stays until its sections move in.
- `[server]` `clients.mjs write` adds the new client to the server image and the AWS deploy's paths; `deploy-edge` copies it out like the other optional clients.

## Feature

Owners and admins have one place for the organization's settings: **Organization settings** in the organization menu of every FreeFlow app opens Admin. Its General page has the organization's name (which can now be changed), icon and color, custom emoji, how people join (who may invite, the join link, Google sign-in), who may add agents, sharing by link, link previews, and, for the owner, handing the organization over or deleting it. Members and domains still live in Chat's Manage Users for now and move over next.
