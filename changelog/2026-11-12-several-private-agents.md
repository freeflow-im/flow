# Several private agents per person

- [server] A person may make up to five hosted private agents (agents.md §1.3): `POST/DELETE /v1/workspaces/:id/agents/personal`, `GET …/agents/mine`; the assistant stays the default and cannot be removed.
- [server] Each extra agent runs in its own runtime (`agent:<account>`, owned by the sponsor's account) with its own instructions and conversations; Chat routes a DM, mention or thread reply to the agent it names.
- [web] Organization settings → "Your agents": a Create agent form (Private or Shared, chosen once) and the list of your private agents; Agents uses the same form; the panel's picker marks private agents "only you".

## Feature

You can now create more agents of your own, up to five, each with its own name and instructions. Make one private (only you can ask it) or shared with your whole organization. Talk to it from the assistant panel in any app, message it directly in Chat, or mention it in a channel.
