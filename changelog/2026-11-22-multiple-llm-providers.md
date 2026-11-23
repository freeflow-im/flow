# Multiple LLM providers and models per organization, with a default and per-agent pins (Taskboard task 26)

- `[server]` The `org:<id>` Assistant object keeps a list of provider+model entries and a default. The first read seeds the list from the organization's existing model. New routes: `/v1/workspaces/:id/assistant/models` and `…/keys/:provider`.
- `[server]` An agent's definition can carry a `modelId` pin. Each turn runs on the pinned entry, or on the default if that entry was removed or its provider has no key.
- `[web]` Admin › Agents: a **Models** card (add, make default, remove, saved keys) replaces "Model for every agent". Create agent, the agent Instructions editor and Your assistant › Model each get a model picker.

## Feature

- **More than one AI model.** Owners and admins can set up several providers and models in Admin › Agents and choose one as the default. When you create an agent you can pin it to one of them. If that model is removed later, the agent runs on the default.
