# Connecting an external agent: personal or shared (agents spec phase B)

- `[server]` The MCP consent page asks how to connect the client: as your personal agent (the default), as a new shared agent with a name (a member the organization's object makes, under its sponsoring policy, whose OAuth tokens are its own), or as one of your existing agents, so a new machine makes no duplicate. The device grant carries the choice too. The decision is checked before the agent is made, so a stale page leaves no orphan member.
- `[server]` A shared agent on `/mcp` acts as itself: its events say `invokedBy` the person whose client it is. The bridge door serves server tools alone, with the caller's kind.
- `[server]` Not built: the bridge's own "personal" mode. A bridge token that acted as its sponsor would be an unscoped delegation of the whole account with no confirm step, which the review of this phase showed; personal agents stay on `/mcp` (scoped OAuth) until the hosted runtime (phase C) can show the sponsor a confirm card.
- `[web]` Docs' Share dialog warns, when a shared agent is picked or listed, that everyone in the organization will be able to ask it. Chat's DM header with a shared agent says it is not private. Docs' Settings shows what each connection was connected as.
- `[qa]` e2e-mcp covers the three choices, the shared agent as a member, and the refusals; directory tests added.

## Feature

- **Choose what your agent is when you connect it.** The sign-in page for an MCP client now asks: your personal agent, which acts as you and only you can use, or a shared agent with its own name and address that everyone in the organization can ask. You can also pick an agent you already connected, so a new computer does not make a second one.
- **A shared agent keeps no secrets.** When you share a file with a shared agent, the Share dialog says that everyone in the organization will be able to ask it about the file. A direct message with a shared agent says it is not private.
