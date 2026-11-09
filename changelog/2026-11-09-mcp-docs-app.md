# MCP Docs is its own package; the editors take a host

- `[desktop]` The standalone MCP Docs desktop app moves to `apps/mcp-docs` (Electron, the installer, the plugins, its release notes and version) over `@flow/docs`; the packaged app carries the Docs code beside `node_modules`, where Node can run its TypeScript. `docs/specs/docs-core.md` §4.3.
- `[web]` The Docs client's components read the desktop app's pieces (the file browser's name, the window) from one host context instead of globals.
- `[qa]` `docs-desktop-release.yml` builds from `apps/mcp-docs`; CI typechecks it.
