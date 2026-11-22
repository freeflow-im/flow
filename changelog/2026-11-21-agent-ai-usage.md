# AI usage per agent: token counts and a Usage chart in Admin › Members

- `[server]` Each agent's model tokens are counted per hour in its organization (`org/agentUsage.ts`): hosted runtimes after every model call, whoever's key paid; `GET /v1/workspaces/:id/agents/:userId/usage?range=1d|7d|30d` (owners and admins) returns them in thousands, by hour or by day.
- `[bridge]` 0.43.0: reports each turn's tokens (Claude Code's `result` usage, Codex's `turn.completed`) to `POST …/agents/me/usage`.
- `[web]` Admin › Members: a **Usage** link beside every agent opens `/admin/members/<id>/usage`, with totals, input and output column charts, a table view, and 1 day / 7 days / 30 days.

## Feature

- **See how much each agent uses its AI model.** In Organization settings › Members, click **Usage** beside an agent to see the input and output tokens (in thousands) its model calls used over the last day, 7 days or 30 days.
