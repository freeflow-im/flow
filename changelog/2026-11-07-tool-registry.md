# The tool registry: each app registers once, three doors read it (platform phase 6.2)

- `[server]` Tool definitions live in `@flow/shared/tools` (written from the implementations by the registry test); the Worker's registry (`src/registry`) serves `/mcp` by scope and the assistant by open app, replacing their hand-kept lists.
- `[server]` The assistant offers only the open app's browser tools; Mail's and Calendar's refusal of Docs' tools is gone.
- `[server]` `GET /v1/tools?door=bridge` returns the bridge's tool definitions.
- `[bridge]` The `flow` MCP builds its tool list from `GET /v1/tools?door=bridge`, skipping (and logging) tools it does not implement, and falls back to its built-in list on an older server (0.37.9).
