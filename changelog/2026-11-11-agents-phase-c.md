# Hosted agents (agents spec phase C)

- `[server]` Every person's account brings their assistant: a hosted personal agent principal ("<name>'s assistant") with a `personal_agent` account, backfilled once; its runtime (the account's Assistant object) keeps a definition (name, instructions) that goes into every prompt; the person's turns carry `via` the assistant. `GET/PUT /api/agent/definition`, `GET /api/agent/agents`.
- `[server]` Hosted shared agents: `POST /v1/workspaces/:id/agents/hosted` makes one (a member under the sponsoring policy, runtime hosted, definition adopted); `GET/PUT …/agents/:userId/definition`. A panel turn naming one runs in its runtime as the agent, asked by the person, in the person's own conversation with it; a file the agent has no grant on is refused ("<name> can't see this page").
- `[server]` A wake job for a hosted agent is handed to its runtime at once: the job is acked, the prompt run as an async turn with the server tools, the answer posted in the channel as the agent (a personal agent as its sponsor, `via`), the job stepped to done or failed with the reason. The person's hosted assistant may be a wake consumer.
- `[web]` Docs' Settings: "Your assistant" (name, instructions). The assistant panel shows the assistant's name and, with hosted shared agents in the organization, a picker. Admin › Agents: "Make a hosted agent" and in-place instructions for hosted agents; hosted agents are marked.
- `[qa]` e2e-mcp covers the assistant with the account, the definition, a hosted shared agent made and talked to, the refusals, and wake jobs reaching both runtimes; directory, events, assistant and Admin unit tests.

## Feature

- **Your own assistant.** Everyone has an assistant in each organization, with a name and standing instructions you set in Settings. What it does for you is marked as done through your assistant.
- **Hosted agents for the team.** An admin or sponsor can make a shared agent that the platform runs, with a name and instructions. Anyone can talk to it from the assistant panel, share files with it, and wake it from an automation; it answers in the channel as itself.
