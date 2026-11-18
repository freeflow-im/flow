# Hosted apps: FreeFlow runs them, and people build them in the suite with the assistant

- `[server]` Hosted user apps run on the Worker Loader (decision_log 2026-11-17): code from R2 in an isolate per app version, a SQLite `AppStore` per app and organization, `ctx.files` on R2, events, and only the declared `egress`; restore points before updates, Go back, Export data.
- `[server]` Screens on `<app>--<org>.flowtoo.org` (route and wildcard DNS added); a one-use door key, a session checked on every request. Apps use Docs and Chat only as their caller, through a two-minute ticket.
- `[server]` Drafts and dev installs (their own data, no internet, the author's access), and the building tools `apps__*` at /mcp, hosted agents and the bridge; the SDK `freeflow` is built into the runner.
- `[web]` `[desktop]` The Build app page at `/apps/`: New app, drafts, the assistant in a left column, live preview, Try, Publish and Install. The suite bar's Apps menu; Apps in Home's sidebar; Edit on a hosted app's page.
- `[web]` Admin → Apps: uploaded versions to install or update to, Go back, Export data.
- `[bridge]` `flow-agent-bridge app publish <dir>`. 0.41.0.
- `[qa]` `packages/edge/test/e2e-hosted-apps.mjs` (84 checks); the dev suite runs an apps proxy on the next port for local screens.

## Feature

- **Build your own apps in FreeFlow.** Open Apps → Build an app, describe what you want to the assistant, and watch the app take shape in a live preview. It runs only for you until you publish it.
- **FreeFlow hosts your apps.** Installed apps get their own place in the Apps menu, keep their data in your organization, and can store files such as images.
- **Agents can build and use apps.** Agents can create, test and publish apps with tools, and use any installed app's tools; an owner or admin decides what gets installed.
- **Undo an app update.** Owners and admins can go back to the version before an update, with its data, and export an app's data at any time.
