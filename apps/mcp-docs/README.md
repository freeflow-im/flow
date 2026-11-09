# MCP Docs, the desktop app

The standalone MCP Docs: the Docs editors (`packages/docs`, `@flow/docs`) over a folder of real Word, PowerPoint, Excel,
Markdown and CSV files, with an MCP server for agents on this machine. Design: `docs/specs/docs-core.md`.

- `desktop/` — Electron: `main.js` (windows, menus, the local MCP server's OAuth, updates), which starts `desktop/server.ts`
  per folder; `docsRoot.js` finds the Docs code (the workspace link in a clone, `docs/` in the packaged app).
- `installer/` — `npx @freeflow-im/mcp-docs`, published to npm by the release workflow.
- `claude-plugin/`, `.claude-plugin/` — the Claude Code and Codex plugin and its marketplace entry.
- `release-notes/` — one file per version; `pnpm release -- <version>` tags `desktop-v<version>`, which
  `.github/workflows/docs-desktop-release.yml` builds and publishes to this repository's releases.

```sh
pnpm desktop                 # build the client, then open the current directory in the app
pnpm desktop -- ~/Documents  # or a folder you name
pnpm desktop:pack            # the packaged app, unsigned, in release/
pnpm test && pnpm typecheck
```

The packaged app carries the Docs code at `docs/` beside `node_modules` (electron-builder's `files` in `package.json`),
because Node strips types from no file under `node_modules` and the Docs server runs from its TypeScript sources.
