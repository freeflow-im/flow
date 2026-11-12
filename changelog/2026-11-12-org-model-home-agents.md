# One model per organization; Home's agent list

- `[server]` The model and API keys agents run on are the organization's (the `org:<id>` Assistant object); every assistant and hosted shared agent reads them at the start of a turn. Owners and admins set them (`PUT /v1/workspaces/:id/assistant/model`, 403 `not_admin` for others); personal keys saved before are no longer used.
- `[server]` "The built-in model" is offered only when the Worker has a platform key (it has none in production); with no organization model, an agent's Chat, mail and wake turns say "No model is set for this organization yet…" instead of "Something went wrong".
- `[web]` Admin: "Model for every agent" in Agents (owners and admins); Your assistant shows what it runs on. Saving a name or a member change tells Home (`flow:changed`), which reloads its member list at once.
- `[web]` Home's Agents list shows shared agents and your own assistant only, not other people's.
- `[qa]` e2e-admin: a member reads the model but cannot set it; a bad choice is refused.

## Feature

- Your organization's owners and admins choose the model every agent runs on, under Organization settings → Agents.
- Renaming your assistant shows at once in Home's sidebar, which lists your own assistant and the shared agents.
