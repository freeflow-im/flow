# Agents keep a memory

- [server] Every hosted agent has a `memory` tool (agents.md §6.1): small files under /memories in its runtime, modelled on Anthropic's memory tool but ours, for every provider; a shared agent has a team folder and each asker's own `you` folder.
- [server] Each request lists the agent's memory files; what a mail or wake turn writes is marked as from someone else's content.
- [server] `GET/PUT/DELETE /v1/workspaces/:id/agents/:userId/memory` for the Memory tab: a private agent's memory is its sponsor's alone.
- [web] Organization settings: Memory on each of your agents and each shared agent (read, edit, delete, forget everything); the panel shows "Remembered: …" when an agent saves something.

## Feature

Your agents now remember things between conversations: tell one your preferences once ("summaries in three bullet points") and it keeps them. See, correct or delete what each agent remembers under Organization settings → Your agents → Memory. A shared agent keeps what you tell it to yourself unless you ask it to share it with the team.
