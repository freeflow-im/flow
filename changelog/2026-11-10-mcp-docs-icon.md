# MCP Docs: the app icon is back

- `[desktop]` electron-builder reads the icon from `build/` beside the app's manifest; the folder stayed in `packages/docs` when the app moved to `apps/mcp-docs`, so 0.2.40 shipped with Electron's default icon. Moved.
