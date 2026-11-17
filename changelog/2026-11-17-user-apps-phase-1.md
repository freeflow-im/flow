# User apps, phase 1: install an external app, with a tab, agent tools and events

- `[server]` An installed app's manifest is data per organization (Org object `user_apps`, `user_app_versions`, `user_app_grants`, `user_app_agents`); install, update, grant, remove and rotate under `/v1/workspaces/:id/apps` (owners and admins), checked by `checkUserAppManifest`.
- `[server]` Tool registry: app tools as `<app>__<tool>` at /mcp (new `apps:use` consent scope), in hosted agents' turns and at the bridge; the Org object checks scopes on every call and signs it to the app's server.
- `[server]` App events at `POST /v1/apps/:org/:name/events`, signed; published as `app.<name>.*`, visible only with one of the app's read scopes; `about` makes `self: true` match the account an event is about.
- `[web]` `[desktop]` Installed apps' tabs in every suite bar; `/apps/<name>` frames the app's screen with a v2 door key; Admin → Apps installs, shows the secret once, grants and removes; each member turns an app on for their own agents.
- `[bridge]` Lists and runs app tools; `app-guard` accepts the v2 token of an app tab. 0.40.0.
- `[qa]` `examples/user-apps/taskboard` and `packages/edge/test/e2e-user-apps.mjs` (35 checks on a local Worker).

## Feature

- **Install apps made outside FreeFlow.** An owner or admin pastes an app's address in Organization settings → Apps, sees what it asks for, and chooses who gets it. The app gets its own tab.
- **Agents can use installed apps.** Your organization's agents can use an installed app's tools, for example to find tasks on a task board and work on them. An app can wake an agent when something is assigned to it.
- **You decide whether your own agents use an app.** Turn an app on for your assistant and your other agents in Organization settings → Apps.
