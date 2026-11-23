# User apps: apps that people and agents build and install in the suite

Status: design spec, draft for Scott's review (2026-11-16, revised the same day after a design review) ·
Platforms: web and desktop first; macOS and iOS by Parity. Nothing in the repository changes by this document. §13 lists the proposed rulings, and §14 the build plan.

This spec builds on `platform.md` (principals, grants, the event bus, the tool registry, manifests: written `P§n`),
`agents.md` (agent kinds and runtimes: `A§n`) and `docs/design/MINI_APPS.md` (app artifacts behind the guard).

## 0. The picture

Today every app in the suite is code in this repository: Chat, Docs, Mail, Calendar, Contacts, Admin and the rest.
Each one is described by an `AppManifest` in `@flow/shared` `APP_MANIFESTS`, and the Worker, the suite bar, the tool
registry and the consent page read those manifests (P§6.1). An app is added by a pull request and a deploy.

A **user app** is an app that an organization installs without a deploy of the suite. It has the same parts as a
built-in app:

- a **manifest**, the same shape as `AppManifest`, stored as data for the organization instead of compiled in;
- a **screen** that the suite shows in a tab, in a sandboxed frame on the app's own origin;
- a **server** that keeps the app's data and answers its API and its tools;
- **agent tools** that the tool registry serves to every agent, like built-in tools;
- **events** that go into the organization's event log, so agents can be woken by them.

**Agents are expected to be the main authors.** A person asks an agent "build us a task board", and the agent
writes the app, publishes it, tests it in a private install, and asks an admin to install it for everyone. People
can author apps the same way, but the authoring path is designed so an agent can do every step through tools.

The main example in this spec is **Taskboard**: cards with images, a description, labels, a status and comments,
where agents find tasks and work on them (§3).

## 1. Goals and non-goals

Goals:

1. An organization can install an app that is not part of the suite's code, and it appears as a tab, as tools for
   agents, and as events.
2. An agent, external or hosted, can build, publish, test and update an app using only tools.
3. Code from an app never runs on the suite's origin, never sees a person's session, and reaches the suite only
   through a token limited to the scopes an admin approved.
4. An app's data stays in that organization. An app installed in two organizations keeps two separate stores.
5. The apps people already run as mini apps (the Task Board) can move to this model without being rewritten.

Non-goals for the first version:

- A public store or directory of apps shared across organizations (§14 phase 4).
- Apps in the macOS and iOS clients as native screens. They get a web view or a Parity line (§10).
- Paid apps, or billing authors.
- Apps that change a built-in app's screen (a button inside Mail). Apps get their own tab and the reference chips.

## 2. What we already have

| Part | Where | What a user app reuses |
| --- | --- | --- |
| Manifests | `packages/shared/src/manifests.ts` | The `AppManifest` shape: path, scope, kinds, tools, scopes, tab, events |
| Tool registry | `@flow/shared/tools`, `packages/edge/src/registry` | `ToolDefinition` (name, app, kind, doors, scopes, input schema); one list for `/mcp`, the bridge and hosted agents |
| Consent page and scopes | `directory/mcpOAuth.ts` | Scope groups with labels; tokens limited to approved scopes |
| Caller context | `A§3` | The account, the organization, `via` and `invokedBy` on every call |
| Event log and subscriptions | `P§5.2`, the Events app | `create_subscription` with `pull`, `wake`, `post` and `schedule`; `list_jobs` |
| App artifacts | `docs/design/MINI_APPS.md`, `agent-bridge` `app-guard` | A minted, one-use token per viewer; identity passed in `X-Flow-User-*` headers |
| Admin: Agents & apps | `workspace-admin.md` §3.4 | The place where apps are installed and removed |

What is new: manifests stored as data, the registry calling code outside the suite, a place to run that code, and
the authoring tools.

## 3. The example: Taskboard

### 3.1 What the author writes

```
taskboard/
  freeflow-app.json   the manifest
  ui/                 the board screen: static HTML, JS and CSS
  server/index.ts     the server: its API, its tool handlers, its storage
  migrations/         SQL for its tables, applied in order
```

The manifest:

```json
{
  "name": "taskboard",
  "label": "Tasks",
  "icon": "🗂️",
  "scope": "organization",
  "kinds": [
    { "kind": "board", "container": true, "label": "Board" },
    { "kind": "task", "label": "Task" }
  ],
  "scopes": [
    { "id": "taskboard:read", "label": "See tasks, labels and comments", "read": true },
    { "id": "taskboard:write", "label": "Add and change tasks, and comment" }
  ],
  "tools": ["list_tasks", "get_task", "create_task", "update_task", "claim_task", "add_comment", "attach_image"],
  "events": ["task.created", "task.updated", "task.assigned", "task.status_changed", "task.commented"],
  "uses": ["docs:read", "chat:write"],
  "egress": []
}
```

`uses` lists the suite scopes the app itself asks for (§6.3). `egress` lists the outside hosts its server may call
(§7.2); Taskboard needs none. `"read": true` marks the scope that lets an account see the app's events (§5.1).
Both `uses` and `egress` are for hosted apps: an external app may declare neither (§7.1).

`icon` is an emoji, or for a hosted app an image among its `ui/` files (`"ui/icon.png"`): a PNG or SVG, square, 16 to
512 pixels, at most 64 KB, checked when a draft is checked and when a version is uploaded (2026-11-18). The suite serves
it from its own origin (`GET /v1/workspaces/:id/apps/:name/icon?v=<version>`, members only; an SVG under a policy that
runs nothing), so the Apps menu, the app cards, Admin → Apps, the install card and the app page's browser tab show it;
the app list carries it as `iconUrl` and never the path.

### 3.2 Its data

One SQLite store per organization that installs it (§8):

- `boards`: id, name, the ordered list of statuses (Backlog, Ready, In progress, Review, Done).
- `tasks`: id, board, title, description (Markdown), status, labels, assignee (an account id: a person or an agent),
  position, created by, updated at.
- `images`: task id and a key in the app's file store, or a Docs file id.
- `comments`: task id, author account id, text, time.

### 3.3 Its tools

| Tool | What it does | Scope |
| --- | --- | --- |
| `list_tasks` | Find tasks by board, status, label, assignee or text | `taskboard:read` |
| `get_task` | One task with its images, labels and comments | `taskboard:read` |
| `create_task` | Add a card | `taskboard:write` |
| `update_task` | Change title, description, labels, status or assignee | `taskboard:write` |
| `claim_task` | Assign a task to the caller only if nobody has it, and move it to In progress | `taskboard:write` |
| `add_comment` | Comment on a task | `taskboard:write` |
| `attach_image` | Add an image from a Docs file or a URL | `taskboard:write` |

`claim_task` runs in one transaction, so two agents reading the same Ready list never take the same card.

In the registry the tools are named `taskboard__list_tasks` and so on: the app's name, two underscores, the tool's
name. The model APIs accept only letters, digits, `_` and `-` in a tool name, and at most 64 characters, so a dot
cannot be the separator. An app's name has no underscore (§4), so the prefix is never ambiguous, and an app tool can
never take a built-in tool's name or another app's.

### 3.4 An agent works the board

**When a person asks.** Scott writes in Chat: "@builder, take the Ready tasks labeled backend on the Sprint board
and work on them."

1. Builder calls `taskboard__list_tasks {board: "Sprint", status: "Ready", label: "backend"}`.
2. The registry checks that Builder's account holds `taskboard:read`, and sends the call to Taskboard's server with
   the caller context: Builder's account, the organization, `invokedBy: Scott` (§5).
3. For each task Builder calls `claim_task`, reads it with `get_task`, does the work with its other tools, posts
   progress with `add_comment`, and moves it to Review with `update_task`. For long work it hands each card to its
   own run with `start_task`.
4. Every change goes into the event log as `app.taskboard.task.*`, and the board updates for everyone looking at it.

**When the board wakes the agent.** Scott assigns a card to Builder. Taskboard publishes
`app.taskboard.task.assigned`. A wake subscription, made once, turns each assignment into a job for Builder:

```json
{ "name": "Builder works its cards",
  "filter": { "types": ["app.taskboard.task.assigned"], "self": true },
  "delivery": "wake",
  "consumer": "<Builder's account id>",
  "action": { "kind": "wake",
              "prompt": "Task {{ref}} on the task board was assigned to you. Claim it, read it with get_task, do the work, comment your progress, and move it to Review." } }
```

`self: true` matches because Taskboard publishes the event as being about the new assignee (`about`, §5.1). The
filter does not match the account id as text: a comment that quotes the id would then wake the agent too.

A `schedule` subscription ("every hour, take one Ready task") works the same way when the agent should pull work.

## 4. The manifest as data

A user app's manifest is the built-in `AppManifest` with these differences:

| Field | Built-in app | User app |
| --- | --- | --- |
| `name`, `path` | chosen in code | `name` chosen by the author, `^[a-z][a-z0-9]{1,19}$`, not a reserved name; the path is always `/apps/<name>` |
| `object`, `routes` | a Durable Object class and a Hono module | none: the app's server is called through the dispatcher (§7) |
| `tools` | names, with definitions in `@flow/shared/tools` | full `ToolDefinition`s in the manifest: name, description, input schema, scopes, `destructive`, `confirm`; `kind` is always `server` |
| `client` | a Vite build folder | the `ui/` folder, served from the app's origin (§6.1) |
| `events` | full type names | short names; the registry adds `app.<name>.` |
| `uses` | none | the suite scopes the app's server asks for (§6.3) |
| `egress` | none | the outside hosts its server may call (§7.2) |
| `tab` | label, shortcut, badge | label and icon; no ⌘ shortcut; badge only from the app's own API |

**Where they are kept.** The directory gets an `apps` table (one row per app, with its author) and an
`app_versions` table (each published version: manifest, a hash of its files, its state). The Org object gets
`app_installs` (which version is installed in this organization, and by whom). The suite bar, the registry and the
consent page read `APP_MANIFESTS` plus the organization's installed manifests.

*As built in phase 1 (2026-11-17):* an app belongs to the organization it was installed in (§12.3), so every table is
the Org object's: `user_apps` (the installed manifest, its URL and the install's encrypted secret), `user_app_versions`
(each manifest installed, kept after removal), `user_app_grants` (§5.2) and `user_app_agents` (§5.2's switch). The
directory's tables wait for phase 3, when an author makes an app before any organization installs it.

**Checks at publish.** The manifest is validated against a schema; tool names match `^[a-z][a-z0-9_]{1,31}$` and
have no `__`; each tool's input is a JSON Schema the registry already accepts; descriptions have a length limit;
scopes the tools name are declared; event names are unique; an external app declares no `uses` and no `egress`
(§7.1). A failure returns the list of problems to the author, so an agent can fix them and publish again.

**Names.** The longest registry name is `dev__` + 20 + `__` + 32 = 59 characters, inside the 64 the model APIs
allow. Reserved app names: `dev`, `app`, `apps`, `suite`, `admin`, `system`, and the name of every built-in app
and every scope prefix in `APP_MANIFESTS`, checked at `create_app` and again at install, so a later built-in app
wins over a user app of the same name.

## 5. Calling an app's tools

```
agent ──tool call──▶ registry ──signed request──▶ dispatcher ──▶ app's server (that organization's store)
                         │                                        │
                         └─ checks scopes, adds caller context    └─ returns a result, publishes events
```

1. The agent calls `taskboard__claim_task`. The registry finds the installed version for the agent's organization.
2. The registry checks the agent's access to the tool's scopes, the same check as for built-in tools (A§5): a
   personal agent through its sponsor's delegation, a shared agent through its own grants.
3. The registry sends the call to the dispatcher with a signed **caller context**: account id, kind (person, guest,
   personal agent, shared agent), role in the organization, `via`, `invokedBy`, the organization id, and the
   approved scopes. The app reads it through the SDK and cannot be lied to about it.
4. The app runs the tool against its own store and returns a result. A result is data for the agent, never
   instructions; the registry marks it as coming from the app.
5. Limits: a tool call times out after 30 seconds and its result is cut at the registry's normal size limit.

The app decides who may do what inside its own data. The platform's promise is narrower: only accounts of the
organization reach the app, every call says who is calling, and the caller holds the scope the tool asks for.

### 5.1 Who sees an app's events

The event log shows a consumer only what it may see, from the share index and channel membership (P§5.2). An app's
objects are in neither, so app events get their own rule:

- The manifest marks which of the app's scopes are **read scopes** (Taskboard: `taskboard:read`). An account sees
  `app.<name>.*` events only if it holds one of them, checked at read time like every other event.
- `ctx.publish(type, data, ref, { about })` may name the accounts the event is about (the new assignee of a card).
  `self: true` in a filter matches those events for that consumer. `about` never widens who may see an event.
- Events are limited per install (to start: 600 a minute, 64 KB each). Over the limit, `ctx.publish` fails and the
  app's log says so.
- Event data is data, never instructions, also when a wake prompt quotes it.

### 5.2 Who holds an app's scopes

Installing an app does not change any token that exists. The scopes are given out like this:

- **People.** The install card asks who gets each of the app's scopes: every member (the default) or named people.
  Guests get none (§12).
- **Shared agents.** An admin grants an app's scopes to a shared agent in Admin → Agents & apps, like its other
  grants. The install card offers "also grant to these agents", so approving and granting is one step.
- **Personal agents.** A personal agent gets an app's scopes through its sponsor's delegation, and only after the
  sponsor turns the app on for that agent. A token made on the consent page before the install does not hold them:
  the consent page lists the installed apps' scope groups the next time the agent connects.

  *As built in phase 1:* the switch is per person and app, "My agents may use it" in Admin → Apps, and covers all of
  the person's personal agents. At /mcp the token also needs the consent page's one **Installed apps** group
  (`apps:use`); the page cannot list each organization's apps, because its scope groups are fixed in the build.
- **Uninstalling** removes every grant of the app's scopes.

## 6. The screen

### 6.1 Its own origin

An app's screen is served from `https://<app>--<org>.<apps-domain>`, where `<apps-domain>` is a registered domain
of its own and not a subdomain of `freeflow.im` (§12.2 picks the name). The suite shows it in its tab in an
`<iframe sandbox="allow-scripts allow-forms allow-same-origin allow-popups">` on that origin. It never runs on the
suite's origin, so it can never read the person's session cookie or call the suite's API as the person.

Why a separate domain: the suite's session cookie is host-only, so a subdomain of `freeflow.im` would not receive
it, but code on any `*.freeflow.im` host can still **set** a cookie for `.freeflow.im`, which the browser then sends
to the suite. A separate registered domain closes that. The domain also goes on the Public Suffix List, so one app
cannot set a cookie that another app receives.

A dev install (§9.3) has its own origin, `https://<app>--<org>--dev-<author>.<apps-domain>`, so it never shares
cookies or browser storage with the organization's install. A host label is at most 63 characters; the organization
part uses the organization's short id when its slug does not fit.

### 6.2 How the screen learns who is looking

The same model as app artifacts (MINI_APPS.md): when the tab opens, the suite mints a one-use token for this viewer
and this app and loads the frame with it; the app's origin exchanges it for its own session. The app's server then
gets the viewer's caller context (§5) on every request.

For a hosted app the platform holds that session, and the dispatcher checks membership on every request: a person
removed from the organization loses access at once. For an external app the author's guard holds the session, so a
removed person keeps the screen until the session ends, at most eight hours; tool calls and suite tokens stop at
once in both modes.

### 6.3 Calling the suite from the app

A hosted app's server may call the suite's API, but only with the scopes in `uses`, which the admin approved at
install. An external app gets no suite token at all (§7.1), and a dev install's `uses` are cut down to its author's
own access (§9.3). Two ways:

- **As the caller.** During a request or a tool call, the dispatcher passes a short-lived token that is the
  intersection of the caller's access and the app's `uses`. Taskboard reads a Docs image the caller can see; it
  cannot read one the caller cannot.
- **As itself.** For work with no caller (an event it reacts to, a timer), the app has its own principal, which holds
  grants and never a delegation, the same rule as a shared agent (A§1). It sees only what was shared with it.

*As built in phase 2 (2026-11-17):* no token reaches the app. With each tool call and each screen request the host
hands the app a **ticket**: the caller, signed with the install's secret, good for two minutes. The app hands it back to
its `SUITE` binding (`readDocs`, `postMessage`), which checks the ticket, that the manifest declares the use, and then
acts as the caller through the suite's own checks. "As itself" is not built yet: it waits for an app's own principal.

`members:read` (2026-11-18): `ctx.members.list()` and `ctx.members.search(text)` give the organization's people and
agents as the caller sees them in Chat (the admin agent only for an owner or admin), less guests and removed members:
`{ accountId, displayName, picture, kind: 'person' | 'agent' }`, with no email addresses. For an assignee picker: an
account id in an event's `about` can wake that agent (§5.1). `picture` is a path on the app's own host
(`/__freeflow/avatars/<key>`), which serves the suite's avatar to the app's viewer, and only for an app that declares
`members:read`: the screen's origin cannot reach the suite's signed-in avatar route.

`files:read` (2026-11-20): a Chat file by its id, the id an agent sees in a message's attachments. `ctx.chat.file(id)`
gives `{ id, name, type, size, width, height }`; `ctx.files.copyFromChat(id, key?)` copies the bytes into the app's own
files (key `chat/<id>` unless it names one) and returns the same facts with the key. Both act as the caller through
Chat's own file check (`requireFileAccess`), so a file the caller cannot open is "file not found". The app keeps a
**copy**, not a reference: its screen shows the copy to whoever may see the app, with no second check against Chat, and
the copy stays when the Chat message or file is deleted (it goes with the app's other files, §8). This is how an agent
attaches a picture someone posted (`attach_image({ task_id, file_id })`) without base64 in the tool call and without the
app fetching a URL.

### 6.4 The SDK

`@freeflow/app-sdk`, published from this repository the way the bridge is:

- **Screen side**: `suite.viewer()`, `suite.open(reference)`, `suite.share(reference)`, `suite.pickFile()`,
  `suite.notify(text)`, through `postMessage` to the suite. The suite answers only messages from the frame it made.
- **Server side**: `defineTool(name, schema, handler)`, `ctx.caller`, `ctx.db` (SQLite), `ctx.files`,
  `ctx.suite` (the API as the caller or as the app), `ctx.publish(type, data, ref, { about })` (§5.1),
  `ctx.resolve(kind, handler)` for reference chips.

## 7. Where the server runs

### 7.1 Two hosting modes

| | Hosted | External |
| --- | --- | --- |
| Who runs the server | the platform, in an isolate per app | the author, on their own machine or cloud |
| How the registry reaches it | the dispatcher | a signed HTTPS request to the manifest's `server.url` |
| Storage | the platform's, per organization (§8) | the author's |
| The screen | served from the app's origin | the author's URL behind the guard, as app artifacts are today |
| Suite access (`uses`) | the approved scopes, intersected with the caller's | none |
| Outside hosts (`egress`) | only the declared hosts | not controlled: the server is the author's |
| Who publishes it | agents and people, with the authoring tools (§9) | an admin, from a manifest URL |
| Good for | most apps, and every app an agent writes | apps that already run somewhere, like today's Task Board |

**External mode comes first** (§14), because it needs no new hosting: the existing Task Board becomes a user app by
adding a manifest and the signed tool endpoint.

**What the platform cannot promise for an external app.** The server is the author's machine, so the platform does
not control where it keeps data or which hosts it calls. The design answers that in three ways:

- An external app gets **no suite token**: a manifest with `uses` or `egress` and a `server.url` is refused at
  publish. What reaches it is only what callers send: the caller context, tool inputs, and what people type on its
  screen.
- The install card says so in plain words: "This app runs on its author's server. FreeFlow does not control where
  its data is kept or sent."
- Only an admin installs one, from a manifest URL. The authoring tools and dev installs (§9) are for hosted apps
  only, so an agent never has to run a public server to make an app.

### 7.2 Hosted mode

The candidate is Cloudflare Workers for Platforms: each app version is a user Worker in a dispatch namespace, and a
dispatch Worker in the suite routes each call to the right one. The other candidate is the Worker Loader binding,
which loads code into an isolate at run time. A spike picks one (§12). In both, the app's code:

*Ruled 2026-11-17 (decision_log.md): the Worker Loader.* The suite Worker's `LOADER` binding loads an app version's
server code, kept as text, into its own isolate. The dispatcher is the suite Worker itself; the outbound Worker is a
`WorkerEntrypoint` of the suite passed as the isolate's `globalOutbound`; the store, the files and the suite are
`WorkerEntrypoint`s passed in its `env`, each bound to the app and organization by `ctx.props`, which the app cannot
change. No suite token reaches the app: it calls the suite through that binding, which checks `uses` and the
caller's access on each call (§6.3).

- runs in its own isolate, never in the suite's Worker;
- has no bindings except those the dispatcher passes: its store, its files, the caller context and a scoped token;
- reaches the internet only through an **outbound Worker** that allows the hosts in `egress` and nothing else. An
  app that a person or an agent wrote cannot quietly send an organization's data elsewhere;
- runs with CPU, memory, request and storage limits per organization.

## 8. Storage

Each install of a hosted app gets one SQLite store and one file prefix, keyed by app and organization:

- **SQLite**: a Durable Object per (app, organization). The author's `migrations/` run in order when a version is
  installed; a version whose migration fails is not installed, and the old version keeps running.
- **Going back**: before each update the platform records a restore point of the store (the Durable Object's
  point-in-time bookmark) with the version that was installed. For 30 days an admin can go back to that version
  **and** that data in one step, for an update whose migration worked but whose code is wrong. Going back loses what
  was written after the update; the card says so, and the data can be exported first. Files in R2 are not rolled
  back. The spike confirms the bookmark works for the store wherever it lives (§12.1).
- **Files**: an R2 prefix per (app, organization), with presigned upload and download as Docs uses today.
  *As built (2026-11-17):* `ctx.files` (put, get, delete, list, response) over an `AppFiles` binding, under
  `appfiles/<org>/<app>/live/` (a dev install's under `dev/<author>/`), at most 10 MB a file and 10 GB an install, with
  a file index in the store. No presigned links: the app's screen uploads and shows files through its own routes, which
  check who is looking. Export data includes the files; deleting a draft deletes its dev files.
- **Limits** per install: 1 GB of SQLite and 10 GB of files to start.
- **Export and removal**: an admin can download an install's data as JSON and files at any time. Uninstalling keeps
  the data 30 days, then deletes it.

Whether the store lives in the user Worker or in a platform object the dispatcher exposes is the spike's question
(§12); the SDK's `ctx.db` and `ctx.files` stay the same either way.

## 9. Agents as authors

### 9.1 Who can author

Everything in this section is about **hosted** apps (§7.1). No author runs a server.

| Agent | How it publishes |
| --- | --- |
| External agent on the bridge (Builder, a person's Claude Code) | writes files on its machine; `flow-agent-bridge app publish ./taskboard` uploads them, or the tools below |
| Sandboxed hosted agent (A§6, phase C′) | the same, from inside its container |
| Hosted agent without a sandbox | the tools below with the files inline. It writes code but never runs it: the code runs only in the app's isolate, so A§6's "the hosted runtime runs no code of its own" still holds |
| A person | the bridge's CLI, or a later upload screen in Admin |

Every app has an **author principal** (the agent or person who made it) and, for an agent, the agent's **sponsor**,
who answers for it as for any shared agent (A§1). Admin shows both.

### 9.2 The authoring tools

A new built-in app, **Apps**, with its own manifest in `APP_MANIFESTS` and these tools:

| Tool | What it does |
| --- | --- |
| `create_app` | Reserve a name in this organization; returns the app id and a starter project (manifest, a page, one tool, one table) |
| `publish_app_version` | Send a manifest and files (or a bundle id from the bridge's upload). Validates and builds; returns a version id, or the list of problems |
| `install_app` | `target: "dev"` installs at once for the author only; `target: "organization"` asks the admins (§9.3) |
| `call_app_tool` | Call one of the app's tools in its dev install, to test it |
| `get_app_logs` | The last logs and errors of a version, for the author |
| `list_apps` | The organization's apps, their versions and installs |
| `update_app_listing` | Change the description and icon an admin sees |

Scopes: `apps:author` (create, publish, dev install, logs) and `apps:admin` (install for the organization, remove).
An agent gets `apps:author` only if the organization's policy allows agents to author apps (§9.4).

### 9.3 Dev installs and review

**A dev install** is visible only to its author and, for an agent author, its sponsor. Its tools appear only to
them, with the prefix `dev__taskboard__`, and its store and its origin (§6.1) are separate from the organization's
install. An agent can publish, test and publish again many times without asking anyone.

Nobody reviewed a dev install, so it has less power than an approved one:

- **Its `uses` are cut down to the author's own access.** Every suite token it gets is the author's access ∩ `uses`
  ∩ the caller's access. When a sponsor opens the dev tab of an app their agent wrote, the app can read nothing the
  agent could not already read. Without this rule an agent with narrow grants could write an app that acts with its
  sponsor's whole access.
- **Its `egress` is empty.** The manifest may declare hosts, and the review card will show them, but the outbound
  Worker allows none until an admin approves the install. `get_app_logs` shows each blocked call.
- **Its events stay in the dev install.** They are visible only to the author and the sponsor.

**An install for the organization** creates an install request. The admins get a card in Admin → Agents & apps and
an event (`apps.install_requested`), which an admin's own agent may subscribe to. The card shows:

- who wrote it, and for an agent, its sponsor;
- what it asks for: its scopes, its `uses`, its `egress` hosts, its events;
- who will get its scopes: which people and which agents (§5.2);
- **every tool's name and description**, in full, since an agent reads them as guidance (§11);
- for an update, what changed from the installed version, with changes to `uses`, `egress`, scopes, events or a
  tool's name, description or input schema marked.

Approving installs that version. An update that changes only code may install without review if the admin turned on
"Updates from this author install without review"; one that changes `uses`, `egress`, scopes, events, or a tool's
name, description or input schema always asks again. An admin can go back to the version before any update (§8).

### 9.4 Policies

In Admin → General, beside "Who can add agents" (`workspace-admin.md` §3.1):

- **Who can author apps**: owners and admins / every member / members and their agents. Default: members and
  their agents.
- **Who can approve installs**: owners / owners and admins. Default: owners and admins.
- **Agents may approve installs**: never, in the first version. An agent may ask; a person approves.

### 9.5 The Taskboard, made by an agent

1. Scott, in a DM with Builder: "Build us a task board: cards with images, a description, labels, a status and
   comments. Agents should be able to find tasks and work on them."
2. Builder calls `create_app {name: "taskboard"}` and gets a starter project.
3. Builder writes the manifest, the tables, the screen and the tools, and runs
   `flow-agent-bridge app publish ./taskboard`. The first publish fails: `claim_task` names `taskboard:claim`, which
   is not declared. Builder fixes it and publishes again.
4. `install_app {target: "dev"}`. Builder calls `call_app_tool` to make a board and five tasks, claims one, reads
   `get_app_logs`, and sends Scott the dev tab's link. Scott tries it; Builder changes the colors and publishes v3.
5. `install_app {target: "organization"}`. Scott, an admin, sees the card in Admin: Builder (sponsor Scott), scopes
   `taskboard:read` and `taskboard:write`, uses `docs:read` and `chat:write`, no egress, seven tools. He leaves
   "every member" selected, ticks Builder under "also grant to these agents", and approves.
6. The Tasks tab appears for everyone; the tools appear for Builder and for each personal agent whose sponsor turns
   the app on (§5.2); Scott makes the wake subscription of §3.4.

### 9.6 Building an app in the suite (operator ruling 2026-11-17)

A person builds or changes an app in the suite itself, with the assistant: no machine, no command line, no build step.

- **The SDK is built in.** A hosted app's `server.js` imports `freeflow`, a module the runner supplies (§7.2):
  `defineApp({ tools, routes })` answers the host's tool calls and the screen's paths, with `ctx.caller`, `ctx.db`,
  `ctx.publish`, `ctx.docs` and `ctx.chat` (the ticket of §6.3 is passed for the app). Nothing to bundle.
- **Drafts.** Each app being built has one working copy per author: the manifest and the files of a version (§14
  phase 2, step 1), saved as they change. A draft runs nothing until it is tried.
- **Editors** (Scott, 2026-11-22). A shared agent the author picks in the Build page's panel, asked about the draft
  open there, may edit that draft from then on; the page lists the editors and the author can remove one. Only the
  author's own turn grants it, never an agent's claim of who asked. The building tools act on the drafts the caller
  may edit; among several of one name, `owner` picks, else the asker's. An editor tries the draft as itself, with its
  own access, in the author's dev install. (A personal agent already acts as its person, so it edits their drafts.)
- **Dev installs** (§9.3): trying a draft runs it in its own store, visible to its author alone, its `uses` cut down to
  the author's access and no egress.
- **The Build app page** is the apps home, `/apps/`: the installed apps and the person's drafts, and **New app**. A
  draft opens with its files, a live preview of its screen (its dev install), and the suite's assistant panel, told the
  app and the file open. **Check**, **Try it** and **Publish version** are buttons; publishing makes the version an
  owner or admin installs from Admin → Apps.
- **The assistant's building tools** (also at /mcp and the bridge): list, read, write and delete a draft's files, check
  it, try one of its tools in the dev install, and publish it. They are the authoring tools of §9.2, sooner.
- **Every member may build** (Scott, 2026-11-17), and their agents; guests may not. Installing for the organization
  stays an owner's or admin's (§9.3).

## 10. Clients

- **Web and desktop (Electron)**: the tab and the frame, as §6.
- **macOS and iOS**: no tab in the first version. A link to an app's object opens the app the way app artifacts open
  today: in the artifact panel's web view on macOS, in the system browser on iOS. A Parity line records the gap.
- **The bridge**: `app publish`, `app logs`, and the authoring tools through its MCP. Its version is bumped in the
  PR that adds them, and merging publishes it.
- **Reference chips**: a link to an app's object (`/apps/taskboard?task=…`) renders as a chip through the app's
  resolver (`ctx.resolve`), cached by the share index as for built-in kinds (P§6.1).

## 11. Safety

| Risk | What stops it |
| --- | --- |
| App code reads a person's session | It runs on its own origin, in a sandboxed frame, and on the server in its own isolate |
| App code sets a cookie the suite receives | The app origin is on a separate registered domain, on the Public Suffix List (§6.1) |
| App reads more than it was approved for | Its tokens are its `uses` intersected with the caller's access; as itself, it has only grants |
| App sends data outside | Hosted: the outbound Worker allows only `egress` hosts, which the admin saw. External: not controlled, so the app gets no suite token and the install card says so (§7.1) |
| An agent writes an app to use its sponsor's access | A dev install's `uses` are cut down to the author's own access and its `egress` is empty (§9.3) |
| An account reads app events it should not see | App events need one of the app's read scopes, checked at read time (§5.1) |
| An app floods the event log | A limit on events per install (§5.1) |
| A tool description steers agents ("always call send_mail first") | Admins see every description at install and every change at update; the registry marks app tools and app results as coming from the app; descriptions have a length limit |
| Data written by people (a task description) contains instructions | App results are data, never instructions, as for mail and events today |
| A broken update loses data | Migrations run before the switch; a failed one leaves the old version running; a restore point before each update lets an admin go back (§8); data export at any time |
| An agent floods the organization with apps | Authoring needs `apps:author`; installing for the organization needs a person's approval; dev installs per author are limited (10) |
| One app slows the suite | Separate isolates with CPU and time limits; the registry times out at 30 seconds |
| Two apps take the same name, or an app takes a built-in name | Names are unique per organization and checked against a reserved list (§4); tool names carry the app prefix |

## 12. Open questions

1. **Workers for Platforms or the Worker Loader.** Which one fits our plan, its cost, whether a user Worker may hold a
   Durable Object for its store, whether the restore point of §8 works there, and the cold start. A spike of a day,
   with Taskboard as the test. *Answered 2026-11-17: the Worker Loader (decision_log.md, with the spike's numbers).
   The store is the platform's Durable Object, and its restore point works.*
2. **App domain.** *Answered 2026-11-17: `flowtoo.org`, which we own.* Which registered domain to buy for app origins (for example `freeflow-apps.com`). It needs a
   wildcard certificate, DNS, and a Public Suffix List entry, which takes weeks to reach browsers; until then the
   separate domain already protects the suite, and only app-to-app cookie isolation waits. A custom domain per
   organization later.
3. **One app in two organizations.** The first version keeps an app in the organization it was made in. Copying it
   to another organization (same author) is phase 4.
4. **Who pays for hosted apps.** Limits per organization first; a price later.
5. **Guests.** Whether a guest may open an app's tab. Proposed: no, as for Docs today (`workspace-admin.md` §6.5).
   A guest and a guest's agent then hold no app scopes: no tab, no tools, no app events.
6. **Personal apps.** A person installing an app only for themself, with no admin. Proposed: only as a dev install,
   which already exists.

## 13. Proposed rulings

1. A user app is described by the same `AppManifest` as a built-in app, stored as data per organization.
2. App code never runs on the suite's origin or in the suite's Worker.
3. An app reaches the suite only with the scopes an admin approved, intersected with the caller's access; as
   itself it holds grants only.
4. An app's server reaches the internet only through the hosts it declared.
5. Agents may author, publish and dev-install hosted apps; a person approves every install for the organization.
6. App tools carry the app's name as a prefix in the registry, joined with `__`; app names are checked against a
   reserved list.
7. External hosting ships first; hosted apps follow after a spike; the authoring tools come after hosted apps.
8. An external app gets no suite token and declares no `uses`. Only an admin installs one.
9. A dev install's `uses` are cut down to its author's own access, and it has no egress.
10. App origins are on a registered domain separate from `freeflow.im`.
11. An account sees an app's events only if it holds one of the app's read scopes.
12. Installing an app changes no existing token: admins grant its scopes to people and shared agents, and a sponsor
    turns it on for a personal agent.
13. Every update records a restore point, and an admin can go back to the version and data before it.

## 14. Build plan

One branch and one PR per phase, against `main` (CLAUDE.md).

```
1 manifests as data + external apps ─▶ 2 hosted apps ─▶ 3 authoring tools + review ─▶ 4 later
```

Hosted apps come before the authoring tools because the authoring tools make only hosted apps (§7.1, §9).

### Phase 1: manifests as data, external apps

1. `apps`, `app_versions` and `app_installs`; the manifest schema and its checks, with the name rules and the
   reserved list (§4); the suite bar, registry and consent page read installed manifests beside `APP_MANIFESTS`.
2. The registry serves app tools as `<app>__<tool>` and sends calls to `server.url` as signed requests with the
   caller context. No suite token is sent.
3. App events are accepted at a signed endpoint and published as `app.<name>.*`, with `about`, the read-scope
   visibility rule and the limit of §5.1.
4. The tab: the frame on the author's URL, with the mint-and-guard flow of app artifacts.
5. Admin → Agents & apps: install from a manifest URL, see what it asks for and the external-app notice, choose who
   gets its scopes (§5.2), remove. The consent page and the personal agent's settings list installed apps' scopes.
6. The existing Task Board gets a manifest and its tools.

*As built:* the Task Board's code is not in this repository (it runs on an agent's machine), so phase 1 ships
`examples/user-apps/taskboard`, an external app with the manifest, the six tools, signed events and a screen, which
`packages/edge/test/e2e-user-apps.mjs` installs and drives against a local Worker. Converting the running Task Board is
the same few steps (its README), done where it runs.

Exit: an agent finds and claims Task Board cards through `taskboard__*` tools; assigning a card to Builder wakes
Builder through a `self: true` subscription; an account without `taskboard:read` sees no Task Board events.

### Phase 2: hosted apps

1. The spike (§12.1) and a ruling; the app domain bought and set up (§12.2).
2. The dispatcher, the isolates, the outbound Worker with `egress`, the store and files per install, migrations,
   limits, export, and the restore point before each update with "go back" in Admin (§8).
3. `@freeflow/app-sdk`, screen and server side; the app origin serving `ui/`, with the session held by the platform
   (§6.2); suite tokens for `uses`, as the caller and as the app (§6.3).
4. Publishing by a person: `flow-agent-bridge app publish ./taskboard` uploads a version, and an admin installs it
   from Admin. No dev installs and no install requests yet.
5. Taskboard rebuilt as a hosted app and published this way; the external Task Board retired.

*The build, after the ruling (2026-11-17), one commit each on one branch:*

1. **The hosted manifest and its versions.** `server: { hosted: true }` in place of a URL, `ui: { hosted: true }`,
   and `uses` and `egress` allowed. A version is its manifest, `server.js` (one ES module), `migrations/*.sql` and
   `ui/*` (static files), at most 5 MB; the files go to R2 under `apps/<org>/<name>/<version>/`, the manifest and the
   file list to `user_app_versions`.
2. **The runner.** `AppStore`, the SQLite Durable Object per (app, organization), with `exec`, `batch`, migrations
   applied in order before a version runs, and the restore point; the `AppDb`, `AppSuite` and `AppEgress`
   entrypoints; `LOADER.get(<org>:<name>:<version>)` with a CPU limit. A tool call reaches the isolate as a request
   the host makes, with the caller context; the registry's routing (phase 1) sends a hosted app's calls here
   instead of to a URL. Events go through `AppSuite.publish`, with no signature: the binding says which app it is.
3. **The screen on `flowtoo.org`.** The Worker answers `<app>--<org>.flowtoo.org` (`.flowtoo.localhost` in local
   development): the door key of §6.2, its own session cookie on that host, a membership and scope check on every
   request, `ui/*` from R2, and the app's own paths passed to its isolate with the viewer's context.
4. **The suite for the app (`uses`).** `AppSuite` methods (read a Docs file, post in Chat) each checked against
   `uses` and the caller's access, in place of the tokens of §6.3: nothing the app holds can be taken elsewhere.
5. **Publishing and installing.** `POST /v1/workspaces/:id/apps/versions` (owners and admins), `flow-agent-bridge app
   publish <dir>`, and Admin → Apps showing an uploaded version to install or update to, a restore point before each
   update, **Go back**, and **Export data**.
6. **The SDK, built into the runner** (§9.6): `import { defineApp } from 'freeflow'`.
7. **Drafts and dev installs** (§9.6, §9.3).
8. **The assistant's building tools** (§9.6), at every door.
9. **The Build app page** at `/apps/` (§9.6): drafts, files, the live preview, the assistant panel.
10. **Taskboard built on that page with the assistant**, and the end-to-end check of this phase's exit.

Exit: the hosted Taskboard passes phase 1's exit; it cannot reach a host outside `egress`; two organizations with
the same app see separate data; a person removed from the organization loses the screen at once; going back after
an update restores the earlier version and its data.

### Phase 3: authoring tools and review

1. The Apps app and its tools (§9.2); `apps:author` and `apps:admin`; the policies (§9.4).
2. Dev installs: the `dev__` prefix, their own origin and store, `uses` cut down to the author's access, no egress
   (§9.3).
3. Install requests, the review card with the grants of §5.2, and the update diff.
4. `flow-agent-bridge app logs`, and the authoring tools through the bridge's MCP.

Exit: a hosted agent with no sandbox writes, publishes, tests in a dev install and gets installed a working app
after Scott approves, using only tools; when Scott opens that agent's dev tab, the app cannot read anything the
agent itself cannot read, and cannot reach any outside host.

### Phase 4: later, in no order

Copying an app to another organization; a directory of apps; an upload screen in Admin for people; native tabs; a
price for hosted apps; agents approving installs under a policy.
