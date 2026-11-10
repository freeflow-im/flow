# Prototype: the assistant uses web pages through a FreeFlow browser extension

- `[web]` New unpacked Chrome extension (`packages/browser-extension`, fixed id) that runs nine `browser_*` tools in the
  agent's own tab group; only FreeFlow pages may message it (`externally_connectable`). Not published.
- `[server]` The assistant offers the web tools only when the page's context says the extension is there (`browser: true`).
- `[web]` Workspace, Mail and Calendar panels pass `browser_*` calls to the extension (`browserBridge.ts`).
