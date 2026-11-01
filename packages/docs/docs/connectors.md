# Connectors

Connectors bring data from external services (Brex to start) into spreadsheets. A user sets up a
**connection** on the Connectors page (`/connectors`, also File > Data connectors… in a sheet). After that the
assistant can list connections and pull a **dataset** into a tab.

## How it fits together

- `server/connectors/types.ts`: the `Connector` and `Dataset` interfaces, `ConnectorError`, `getJson` (GET with
  retry and backoff on 429 and 5xx, honouring `Retry-After`) and `fromMinorUnits` (cents to decimals for any currency).
- `server/connectors/service.ts`: the `CONNECTORS` registry and `ConnectorService`, which stores connections
  per user (credentials AES-256-GCM encrypted, see `secrets.ts`), tests them, runs dataset queries with a row
  cap (default 5000, `limit` up to 50,000), tracks status (`connected`, `error`, `needs_reauth`), caches results
  under a handle for 15 minutes, and implements the generic OAuth 2.0 code flow with PKCE and token refresh.
- `server/app.ts`: `/api/connectors`, `/api/connections` (create, test, edit, delete, fetch) and the OAuth
  routes `/api/connectors/:id/oauth/start` and `/api/connectors/oauth/callback`.
- Assistant tools: `list_connections` and `fetch_connector_data` run on the server; `ingest_connector_data`
  runs in the browser. It fetches through `/api/connections/:id/fetch` and writes every row in one undoable
  transaction. Values go through `toCellInput` (`shared/connectors.ts`), so numbers and ISO dates become real
  numbers and dates, and text that looks like a number stays text.

Credentials never leave the server. The API returns only a masked suffix (`••••a1b2`), and the tools refer to
connections by id. Connector errors carry a message for the user that never includes credentials.

## Adding a connector

1. Create `server/connectors/<name>.ts` exporting a `Connector`:
   - `id`, `name`, `icon` (a short text badge) and `description`.
   - `authTypes`: `['api_key']` with `fields` (mark secrets `secret: true`; they arrive in
     `ctx.credentials` under their `key`), and/or `['oauth2']` with `oauth: { authorizeUrl, tokenUrl, scopes,
     clientIdEnv, clientSecretEnv }`. OAuth gives you `ctx.credentials.access_token`, refreshed automatically.
     Register `<APP_URL>/api/connectors/oauth/callback` as the redirect URI with the provider, and set the two
     environment variables on the server.
   - `setupHelp`: how to create the key and which scopes to give it.
   - `test(ctx)`: one cheap authenticated request.
   - `datasets`: see below.
2. Add it to `CONNECTORS` in `server/connectors/service.ts`.
3. Add tests with a fake `fetch` (see `server/connectors.test.ts`).

## Adding a dataset

A dataset is `{ id, description, params, columns, fetch }`:

- `params`: a Zod object; describe every field, because Claude reads these descriptions. `limit` is added
  automatically. Unknown params are rejected.
- `columns`: name and type (`string`, `number`, `date`, `datetime`, `boolean`) of each column, in order.
- `fetch(ctx, params)`: returns `{ rows, truncated }`, with rows of primitives in column order. Stop at
  `ctx.maxRows` and set `truncated` when more rows exist. Use `ctx.fetch` (never the global `fetch`) so tests
  can fake it. For Brex-style cursor APIs, `paginate` in `brex.ts` does the paging.

Throw `ConnectorError` for problems the user should see. Code `auth` marks the connection as broken
(`needs_reauth` for OAuth), and `forbidden` marks it as missing a scope.
