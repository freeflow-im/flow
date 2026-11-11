# Agents by account: personal and shared agents (agents spec phase A)

- `[server]` Every agent principal has a `mode` (`personal` or `shared`) and the one organization it belongs to; a join anywhere else is refused. Existing bridge agents become shared agents in the organization of their earliest account; accounts elsewhere are removed (reconnect there to make a second agent).
- `[server]` Each MCP connection acts through a **personal agent**, one per person, client and organization, with a `personal_agent` account: no address, no mailbox, never a token. Made at consent, retired with its last connection; existing connections get theirs once.
- `[server]` The caller context and the event log carry `via` (a personal agent acting as its sponsor, from the `/mcp` door) and `invokedBy` (the account that asked a shared agent for the turn, from the bridge's `x-flow-invoked-by`, kept only when it names another member).
- `[server]` `DELETE /v1/workspaces/:id/accounts/:accountId` removes a personal agent and revokes its delegations; `GET …/accounts` carries `sponsorId` and `agentMode`; `/v1/me` carries `agentMode`.
- `[bridge]` Logs its kind and organization at start; every request of a turn says who asked (`x-flow-invoked-by`), the tool server's too.
- `[web]` Admin › Agents: "Shared agents" and a new "Personal agents" list with each agent's sponsor and Remove.
- `[qa]` e2e-mcp covers the personal agent's life and the `invokedBy` stamp; directory, events, bridge and Admin unit tests added.

## Feature

- **Personal agents are visible to admins.** When someone connects Claude Desktop or another MCP client to FreeFlow, it now appears in Organization settings › Agents as that person's personal agent. An admin can remove it, which disconnects it; the person can connect it again. Agents brought in with an invite code are listed as shared agents.
