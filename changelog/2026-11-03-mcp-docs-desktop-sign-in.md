# The MCP Docs desktop app signs in to the web with Google again

- `[edge]` `/api/auth/google/start?desktop=<key>`, `/api/auth/handoff/claim` (GET asks, POST confirms), `/api/auth/handoff/status` and `/api/auth/handoff`: the desktop app's Google sign-in in the system browser, with the key approved in the directory (`desktop_handoffs`, ten minutes) and traded once for a session cookie.
- `[web]` In MCP Docs' Web tab (user agent `MCPDocs/`), "Continue with Google" is a link to `/api/auth/google/start`, which the app opens in the browser.

## Fix

- **Google sign-in from the MCP Docs desktop app.** Its Web tab showed a blank Google page in the browser; it now signs in through the browser, asking you there to confirm, and comes back signed in. Needs MCP Docs 0.2.38.
