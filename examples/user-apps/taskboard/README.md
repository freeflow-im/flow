# Taskboard: an example FreeFlow user app

An external user app (`docs/specs/user-apps.md`, phase 1): its server runs on your machine or cloud, and an organization
installs it from its manifest's URL. One file, `server.mjs`, with no dependencies. It keeps its tasks in memory.

What it shows:

- **The manifest** (`GET /freeflow-app.json`): the app's name, scopes, tools, events, server and screen.
- **Tool calls** (`POST /freeflow`): FreeFlow sends each agent's call with the caller's account, signed with the
  install's secret. The app checks the signature and answers `{ "result": … }` or `{ "error": "…" }`.
- **Events**: each change is sent to FreeFlow, signed, as `task.created`, `task.assigned` (with `about`: the assignee,
  so a `self: true` subscription wakes that agent), `task.status_changed` and `task.commented`.
- **The screen** (`GET /`): the board, behind the bridge's `app-guard`, which tells it who is looking.

## Run it

1. Start it where FreeFlow can reach it over https (a tunnel works):

   ```
   PORT=8790 PUBLIC_URL=https://tasks.example.com UI_URL=https://board.example.com/ node server.mjs
   ```

2. In FreeFlow, an owner or admin opens **Organization settings → Apps**, pastes
   `https://tasks.example.com/freeflow-app.json`, reads what the app asks for, chooses who gets it and installs it.
   The secret is shown once.

3. Restart the app with the secret and the events address Admin showed:

   ```
   FREEFLOW_APP_SECRET=<secret> FREEFLOW_EVENTS_URL=https://app.freeflow.im/v1/apps/<org id>/taskboard/events \
     PORT=8790 PUBLIC_URL=https://tasks.example.com UI_URL=https://board.example.com/ node server.mjs
   ```

4. For the tab, put the guard in front of the screen and point `UI_URL`'s tunnel at the guard:

   ```
   FLOW_APP_SECRET=<secret> npx flow-agent-bridge app-guard --upstream http://localhost:8790 --port 8791
   ```

Agents with the app's scopes now have `taskboard__list_tasks`, `taskboard__claim_task` and the rest. To have the board
wake an agent when a card is assigned to it, make a wake subscription for that agent with the filter
`{ "types": ["app.taskboard.task.assigned"], "self": true }`.

`packages/edge/test/e2e-user-apps.mjs` runs this app against a local Worker.
