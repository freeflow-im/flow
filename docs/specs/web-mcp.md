# Docs' MCP endpoint on the suite's host: app.freeflow.im/mcp

Agents (Claude Code, Codex, Cursor, claude.ai's connectors) connect to `https://app.freeflow.im/mcp` and work on the same
Docs files people see in FreeFlow Docs at `/workspace`. Built 2026-11-03 on the Worker (`packages/edge`). The ChatGPT
plugin's `/mcp` on `docs.freeflow.im` and `mcpdocs.freeflow.im` is a different server and stays on AWS
(decision_log 2026-11-03).

## OAuth, with the organization chosen on consent

Authorization happens before an organization is known, so its state lives in the **directory object**, not in a Docs
object: `src/directory/mcpOAuth.ts` (`McpOAuth`), the plugin's `OAuthServer` (`src/docs/plugin/server/oauth.ts`) moved to
the directory's SQLite (migration 5 of `src/directory/schema.ts`: `oauth_clients`, `oauth_pending`, `oauth_codes`,
`oauth_tokens`, `oauth_connections`, `oauth_device`). The Worker calls it through `Directory.oauth(method, args)`, which
returns OAuth errors as data (`OAuthAnswer`).

- **Same endpoints and rules as the plugin.** `/.well-known/oauth-authorization-server`,
  `/.well-known/oauth-protected-resource[/mcp[/v2]]` (also under `/mcp/.well-known/...`), `/oauth/register` (dynamic
  registration; an `https` client id is a client metadata document), `/oauth/authorize`, `/oauth/consent`,
  `/oauth/decision`, `/oauth/token` (code with PKCE S256, refresh rotation with reuse detection, the device grant),
  `/oauth/revoke`, `/oauth/device_authorization` and `/oauth/device`. Scopes `files:read` and `files:write`. Only hashes
  of codes and tokens are stored; access tokens last an hour (a device sign-in's a week), refresh tokens 30 days.
- **The issuer and resource are the request's origin**: `https://app.freeflow.im` and `https://app.freeflow.im/mcp` (on the
  rehearsal host, `edge.freeflow.im`'s).
- **Sign-in is FreeFlow's session** (the `sid` cookie only; a bearer token cannot approve an agent). Without one,
  `/oauth/authorize`, `/oauth/consent` and `/oauth/device` send the browser to `/?next=<the consent page>`, as `/workspace`
  does. There are no sign-in, sign-up or Google pages on this host.
- **Consent chooses the organization.** The page (`src/routes/mcpPages.ts`) lists the person's organizations from the
  directory's memberships, named by each organization's object, with the one they last connected an agent to preselected
  (else the first); one organization is still shown by name. It names the client and the scopes, and says the agent will
  read and edit that organization's Docs files: Organization files and the person's My files there.
- **The decision is protected** by the session cookie (SameSite=Lax: another site's form posts without it), the pending
  authorization's CSRF token in the form, the person signed in being the one the consent page was shown to, and an
  `Origin` header, when sent, being this host. The page cannot be framed. The chosen organization must be one of the
  person's (else 403, and the authorization stays pending).
- **The organization goes with the grant**: `org_id` on the code, its tokens and their refreshes, the connection and the
  device grant.

## /mcp

`src/routes/mcp.ts` authenticates the bearer token in the directory (`McpOAuth.authenticate`), which also re-checks that
the person is still a member of the token's organization and still has an account: if not, 401 with
`WWW-Authenticate: Bearer resource_metadata=".../.well-known/oauth-protected-resource/mcp", error="invalid_token"`, and
the refresh token stops working too. A request with no token gets the same challenge without the error.

The request then goes to that organization's Docs object (`Docs.mcp`), which runs the plugin's tools
(`src/docs/plugin/server/mcp.ts`) on its own stores (`src/docs/plugin/server/worker.ts`) as that person, with the
organization as the current one (`withDocsContext`):

- **Files**: the tools list and search the organization's Organization files and the person's My files there; a file by
  id is any of those (`FileService.who`, `roots`, `home` over `server/scope.ts`). New files and folders go in **My files**.
  Listed and created files say which (`root`) and carry their page, `https://app.freeflow.im/workspace/s/<id>` and the like.
- **Version**: `/mcp` serves the newest tools (version 2: folders, `search_files`, `read_file`, `upload_file`); `/mcp/v2`
  the same. The ChatGPT app is left out (`level: 'tools'`: no UI resource, no app-only tools).
- **Scopes**: a token without `files:write` gets only the tools annotated read-only.
- **Transport**: Streamable HTTP POST with JSON responses, stateless; the 2026-07-28 protocol (`server/discover`,
  `resultType`) as in `stateless.ts`. GET answers 405 (no stream).
- **Uploads**: `upload_file` returns `https://app.freeflow.im/mcp/import/<org>?ticket=...`; the ticket is kept in the Docs
  object's SQLite (`_mcp_tickets`), works once, for five minutes.
- The person is mirrored into the object's `users` on each request, as `/api` does, so files they make keep their owner.

## Managing connections

Docs' Settings, Connect your agent (`/api/settings/agents`), is answered by the Worker on the ported hosts from the
directory: every agent connected to the account (code flow and device sign-ins), with its organization's name, and
Disconnect revokes its tokens at once.

## Tests

`src/directory/mcpOAuth.test.ts` (the authorization server over node:sqlite), `src/index.test.ts` (which host serves
what), and `test/e2e-mcp.mjs` against `wrangler dev` (its header says how).
