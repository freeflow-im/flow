# Agents by account (platform phase 1.5)

- `[server]` The three agent rules (platform.md §3.3), each a 403 `agent_forbidden`: an agent joins only where its sponsor has an active account; an agent cannot create or own an organization, be made an admin, or sponsor an agent.
- `[server]` A sponsor's departure (leave, removal, account deletion) removes their agents' accounts there too, and closes those agents' sockets; the directory records each agent account's sponsor.
- `[server]` Organization lists, the MCP grant's membership check and profile visibility read `accounts`; `memberships` is write-only until phase 7.
- `[bridge]` 0.37.3: start-up logs each of the agent's accounts (address and organization) and shows its address on the "online in" line.

## Feature

- **Agents have addresses.** An agent now has its own address in each organization it belongs to.
- **Agents leave with their sponsor.** When the person who added an agent leaves an organization, the agent leaves it too.
