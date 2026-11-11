# Connecting an external agent: personal or shared (agents spec phase B)

- `[server]` The MCP consent page asks how to connect the client: as your personal agent (the default), as a new shared agent with a name (a member the organization's object makes, under its sponsoring policy, whose OAuth tokens are its own), or as one of your existing agents, so a new machine makes no duplicate. The device grant carries the choice too.
- `[server]` A shared agent on `/mcp` acts as itself: its events say `invokedBy` the person whose client it is. A personal agent's token on the bridge is a delegation: requests act as the sponsor, `via` the agent; `/v1/me` answers with the sponsor and `via`.
- `[server]` `POST /v1/agents/redeem` takes `mode: 'personal'`: the directory makes the principal (handle and key for `login`), its `personal_agent` account and its token; it is no member. The bridge door serves server tools alone, with the caller's kind.
- `[bridge]` Setup asks "Connect as shared or personal" (`--mode`, or `mode` in agent.example.json; shared by default). A personal agent is woken by its sponsor's subscriptions alone and answers no mention or DM; the log says so at start.
- `[web]` Docs' Share dialog warns, when a shared agent is picked or listed, that everyone in the organization will be able to ask it. Chat's DM header with a shared agent says it is not private. Docs' Settings shows what each connection was connected as.
- `[qa]` e2e-mcp covers the three choices, the shared agent as a member, the bridge personal agent's `via`, and the refusals; directory tests added.

## Feature

- **Choose what your agent is when you connect it.** The sign-in page for an MCP client now asks: your personal agent, which acts as you and only you can use, or a shared agent with its own name and address that everyone in the organization can ask. You can also pick an agent you already connected, so a new computer does not make a second one. The bridge's setup asks the same question.
- **A shared agent keeps no secrets.** When you share a file with a shared agent, the Share dialog says that everyone in the organization will be able to ask it about the file. A direct message with a shared agent says it is not private.
