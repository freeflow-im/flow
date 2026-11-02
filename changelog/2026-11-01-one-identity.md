# One identity: the Workspace app (MCP Docs) signs in with the suite

- `[server]` The Workspace app (`packages/docs`) runs inside this server when `WORKSPACE_DATA_DIR` is set (`src/workspace.ts`): its `/api/*` routes join as an encapsulated Fastify plugin, its client is served under `/workspace` (built with `BASE_PATH=/workspace/`), and the ChatGPT plugin (`/mcp`, `/oauth/*`) is served when `WORKSPACE_PLUGIN_URL` is set. Its own sign-in, sign-up and Google routes are gone when hosted; its `users` table mirrors this server's users as they are seen.
- `[server]` The session as a cookie beside the bearer (`lib/sessionCookie.ts`): every sign-in response also sets an httpOnly `sid` cookie (SameSite=Lax, Secure on https), `requireAuth` accepts it when there is no `Authorization` header, and logging out clears it. The browser-origin policy already refuses cross-site state changes, so the cookie is accepted wherever a bearer is.
- `[server]` Sign-in verifies the scrypt password hashes imported from the Workspace app and replaces them with argon2 on the first successful sign-in. `scripts/import-workspace-users.ts` imports its accounts (same ids; accounts with the same email are merged onto this server's user).
- `[server]` The request body limit is 100 MB (the Workspace app's spreadsheet saves are one JSON body each).
- `[server]` The suite's AWS image (`packages/server/deploy/aws/Dockerfile`) holds the Workspace app too (its sources, its client built for `/workspace`, Chromium for PDFs); the stack's `deploy.sh flow` turns it on once `/opt/mcpdocs/workspace-to-suite.sh` has moved the app over (`docs/ops/WORKSPACE_TO_SUITE.md`), and `WORKSPACE_LEGACY_HOSTS` sends the app's old host names to `/workspace`.
- `[web]` `/?next=<path>` sends a visitor to the sign-in and back to that path once signed in (the Workspace app and the plugin's OAuth pages use it).
- `[docs]` `buildApp` takes a `host` (Fastify instance, authenticate, signOut, userForCookie, basePath) and then wires itself into it instead of making its own server; the client reads its base path from Vite's `BASE_URL`; the plugin's OAuth sign-in page sends to the suite's sign-in and resumes at `/oauth/resume`.

## Feature

- **One account for Chat and Workspace.** Signing in to FreeFlow signs you in to your files too: the Workspace app (the former MCP Docs) lives at `/workspace` on the same site, with the same account, and signing out of either signs you out of both. Existing MCP Docs accounts move over with their passwords. (Both apps are still separate pages; the suite bar comes next.)
