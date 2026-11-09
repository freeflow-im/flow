# Docs: one code base under the hosted app and the standalone MCP Docs

- `[server]` The Docs server reaches its machine only through `#runtime/*` (`packages/docs/server/runtime/`, Node and Workers sides); the Worker imports `@flow/docs` instead of its 17,800-line hand-made copy, which is deleted. `docs/specs/docs-core.md` phase 1.
- `[server]` The suite's additions to the assistant (every app's pages, Mail's and Calendar's tools, the registry) are one module, `packages/edge/src/docs/assistantTools.ts`, on three extension points of the core; Flow's `/mcp` door is `packages/edge/src/docs/mcp.ts`.
- `[server]` The MCP tools' definitions carry their parameter descriptions and limits again; the old copy's mixed zod versions had dropped them.
- `[desktop]` The MCP Docs desktop app and `npx @freeflow-im/mcp-docs` update from this repository's releases (`desktop-v*`); the plugin marketplaces stay in the old repository, read-only, until one sits at this repository's root. Hand-over steps in `BUILD.md`.

## Feature

- Agents connected to FreeFlow's MCP endpoint, and the assistant, now see each tool parameter's description and limits, so they fill tools in correctly more often.
