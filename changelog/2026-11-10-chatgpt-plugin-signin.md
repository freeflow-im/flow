# ChatGPT plugin: sign-in works again across hosts

- `[server]` `[web]` The ChatGPT plugin's sign-in (Universal Docs on `docs.freeflow.im`, still the AWS server) is the suite's, handed across hosts: the plugin's new `/oauth/sign-in` forwards to the Worker's `/api/auth/cross-host`, which sends a signed-in person back to the plugin's `/oauth/handoff` with a one-time key; the server redeems it at `/api/auth/cross-host/exchange` (edge secret) and signs them in on the plugin's host, mirroring a person new to it into `users` under the directory's id. Why: a session cookie is per host, so since the Nov 2 cut-over the plugin never saw the sign-in on `app.freeflow.im`, and no new ChatGPT connection could complete.
- `[web]` The Worker's `PLUGIN_HOSTS` variable names the plugin's hosts the handoff may return to.

## Feature

- **Connecting Universal Docs in ChatGPT works again.** Signing in during the connection now completes, for new accounts and for anyone asked to sign in again. Existing connections were not affected.
