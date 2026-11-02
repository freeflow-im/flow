# FreeFlow: one app from Flow (Chat) and MCP Docs (Workspace)

Status: Design proposal · 2026-11-01, revised the same day with the operator's rulings (§0). Nothing in either repository is changed by this document.
Platforms: web first; desktop, macOS, iOS and the agent bridge follow.

## 0. Rulings

- **The suite is "FreeFlow"**, matching the domain. Its two apps are **Workspace** (the editors, from MCP Docs) and **Chat** (from Flow). `shared/brand.ts` becomes the one place for names: `SUITE_NAME = 'FreeFlow'`, the app names, and `PLUGIN_NAME = 'Universal Docs'` (§6). The hosted origin is `app.freeflow.im`. The MCP Docs desktop app and the `@freeflow-im/mcp-docs` installer keep their names until the desktop apps merge (§7), when the Electron app becomes FreeFlow too.
- **The mark is MCP Docs' sheet mark and its blue** (`Logo` in `client/src/components/Logo.tsx`, `#1A73E8`). Chat's violet `@theme` accent is re-pointed to the blue so both apps and the bar share one accent (§2.5).
- **Flow's workspaces are "organizations" in the suite.** A person belongs to one or more organizations; the switcher at the left of the bar lists them. "Workspace" is the tab: office work, as distinct from chat, with the editors first and email as a later module under the same tab. Code keeps `workspaces`, `workspace_id` and `workspace_members` for now; UI copy, help text and emails say organization (§2.4).
- **New files are private by default** (My files) and move to the organization deliberately (§2.4).
- **Everything runs on AWS; Railway is retired.** Postgres and NATS join the existing CloudFormation stack and Flow's data moves there (§3.4).
- **The assistant's app-change jobs are retired** (§6). Flow's factory agents do that job for the suite.
- **Both of Flow's Slack systems are removed before the merge** (§2.0): the Slack-compatible API and the Slack connector. Mini apps stay.
- **The ChatGPT plugin keeps its Universal Docs name and its version 1 tools**, served by the suite at its current address `docs.freeflow.im` (§6). The old EC2 app is not kept alive for it.

## 1. What we are merging

| | MCP Docs (`~/src/mcp-docs`) | Flow (`~/flow`) |
|---|---|---|
| Product | Editors for spreadsheets, decks, documents, Markdown, CSV, PDFs, pictures, video; per-file AI assistant; hosted MCP server; ChatGPT plugin | Team chat: workspaces, channels, DMs, threads, huddles, artifacts, agents as members, Slack-compat API |
| Repo | single package, npm | pnpm monorepo: `packages/{server,web,shared,agent-bridge,slack-connector,infra}`, `apps/{desktop,macos,ios}` |
| Server | Fastify 5, TypeScript run by Node type stripping, `server/app.ts` (2.4k lines) | Fastify 5, compiled TypeScript, `packages/server/src/routes/index.ts` |
| Database | SQLite (`node:sqlite`, synchronous), schema inline in `server/db.ts`, files on disk under `DATA_DIR`, R2 as off-box backup | Postgres 16 + drizzle, 47 hand-written SQL migrations run on boot, NATS for events, LiveKit for huddles, R2 (`BlobStore`) for files |
| Identity | `users(id, email, password_hash scrypt, google_sub, email_verified_at)`; everything is `owner_id` per user; no organizations | `users` (global: humans, bots, agents) + `workspaces` + `workspace_members(role)`; argon2id; `oauth_identities`; Apple; magic links |
| Session | opaque token, hashed in `sessions`, httpOnly cookie `sid`, 30 days | opaque token, hashed in `sessions`, `Authorization: Bearer`, 30 days sliding; localStorage on web, OS keychain in Electron |
| Google | server-side OAuth code flow with callback | Google ID-token flow (no redirect) + system-browser handoff for native |
| Client | React 19, react-router 7, one 7k-line global CSS, no Tailwind, no dark mode, Google Sans | React 19, Tailwind 4 (`@theme` violet tokens), no router (navigation is React state + localStorage), no dark mode |
| Toolchain | TypeScript 7, Vite 8, Vitest 5 | TypeScript 5.6, Vite 6, Vitest 2 |
| API | `/api/*` (cookie) ; `/mcp` + OAuth for ChatGPT and agents | `/v1/*` (bearer), `/v1/ws`, `/api/*` Slack-compat (`xoxb-` tokens), `/healthz` |
| Realtime | per-process SSE revision feed (`/api/revisions/:id`) | NATS → WebSocket, `Event<T>` protocol in `@flow/shared` |
| Hosting | one EC2 Graviton box, Caddy, EBS volume, CloudFormation, deploy on push to main; `mcpdocs.freeflow.im`, `docs.freeflow.im` | Railway (Railpack), Postgres + NATS services, deploy on push to main; `app.freeflow.im` |
| Desktop | Electron, a local server per folder of real Office files, MCP server on 127.0.0.1:39217 with OAuth for Claude Code, updater, Local/Web tabs | Electron shell around the web client (M1–M3 merged), keychain, notifications, badge, tray; native Swift macOS and iOS apps |
| Size | client 34k, server 25k, shared 11k lines | web 31k lines; server + shared not counted |

Both are already Fastify 5 + React 19 on one domain family, owned by the same people. That is what makes a single app realistic.

## 2. Decisions

### 2.0 Before the merge: take Slack out of Flow

Flow has two separate Slack systems. Both go, in two PR series on the Flow repo, before anything from MCP Docs moves in. Each lands with its `changelog/` entry and Parity line per Flow's conventions.

**A. The Slack-compatible API: Flow pretending to be Slack for bots.** Delete:

- `packages/server/src/slackcompat/` (`index.ts`, `methods.ts`, `store.ts`, `ts.ts`; 732 lines): the `/api/<method>` routes, `xoxb-` bot tokens, `token` params.
- `packages/server/src/gateway/socketMode.ts` (232 lines) and the `xapp-` app-level tokens; `services/apps.ts`, `services/appEvents.ts` (the outgoing Events API subscription and `pending_app_events`); the `subjectAppSocketMode` NATS subject in `bus.ts`.
- Tables `apps`, `pending_app_events`, `app_socket_tickets` and the bot users they own (`users.is_bot`, the `bot-<uuid>@apps.flow.local` addresses), by a new migration that drops them. The earlier migrations (`0004_slack_apps`, `0009_app_level_tokens`, `0011_app_token_visibility`, `0039_app_socket_tickets`) stay in history.
- Web: `AppsModal.tsx` and the admin view's Apps section, `useApps`; shared: `AppDTO`, `APP_EVENT_TYPES`, `UpdateAppBody`, `mrkdwn.ts` (its only non-Slack importer is the shared index). `docs/design/slack-protocol/` and the Slack parts of `docs/integrators/APPS.md`.
- The `/api` exemption in the SPA fallback and in `FLOW_REDIRECT_FROM_HOSTS` stays, because the Workspace API will use `/api` (§2.1).

**Keep**, and check they do not fall with the above: mini apps (`docs/design/MINI_APPS.md`, `lib/appToken.ts`, migration `0033_artifact_apps`, the `artifacts` columns and `services/artifacts.ts`'s mini-app functions, the sidebar's Apps list); `requireAdmin`, which `communityEmail.ts` copies from `services/apps.ts` and must be moved, not deleted; the `users.is_bot` column itself if anything else sets it.

**B. The Slack connector: Flow as a client of real Slack workspaces.** Delete:

- `packages/slack-connector/` (2.4k lines) and its Railway service `slack-connector` at `slack.freeflow.im` (BUILD.md §Slack connector); `SLACK_CONNECTOR_ORIGIN` / `VITE_SLACK_CONNECTOR_ORIGIN` in `config.ts` and the web build; `docs/dev/SLACK_CONNECTOR.md`.
- Web: `lib/backend/slackBackend.ts` (320 lines), `lib/slackConnector.ts`, `components/SlackConnections.tsx` (129 lines), and the `provider === 'slack'` branches in `lib/connections.ts`, `lib/backend/index.ts`, `ServerConnections.tsx`, `MessageList.tsx`, plus the Slack mentions in `Avatar`, `UnfurlCard`, `format.tsx`, `ws.ts`, `messageCache.ts`, `deepLinks.ts`, `StatusPicker`, `WorkspaceChooser`, `Sidebar`, `emoji.ts`'s Slack shortcodes if unused elsewhere. The `Backend` interface (`shared/backend.ts`) is kept with one implementation, `flowBackend.ts`; it is the seam §2.5 uses for multi-server Flow connections.
- Native: `apps/macos` has 12 files with Slack code (`SlackIdentity.swift`, the Slack branches of `ConnectionManager`, `ServerConnection`, `SocketClient`, `Models`, `AppDatabase`, `ServerConnectionsView`, `UnfurlCardView`, `EmojiShortcodes`, `ImageLoader`); `apps/ios` the rest of the 38 matches. Each native app gets its own PR, and a macOS and iOS release follow by their release scripts.
- `docs/specs/multi-server-workspaces.md`: the Slack half is struck; the Flow-server half stands and is what the suite's organization switcher follows.

Removing A and B first keeps the merge PRs about the merge, and takes `/api` back for the Workspace API without a routing special case.

### 2.1 Flow is the host; MCP Docs becomes the Workspace app inside it

Flow already has the multi-tenant pieces a suite needs: global users, organizations (its "workspaces"), membership and roles, invites, agents as users, native-app sign-in handoffs, a server discovery contract, NATS fan-out and Postgres. MCP Docs has none of that and would have to grow it. So:

- The monorepo is `~/flow`. MCP Docs moves in as `packages/docs` (its `server/`, `shared/`, `client/`, `plugin/` as they are, keeping git history with `git subtree add`). `desktop/`, `claude-plugin/` and `installer/` move under `apps/` later (see §7).
- One Node process serves everything. MCP Docs' `buildApp()` is turned into a Fastify plugin, `registerDocs(app, opts)`, that Flow's `createApp` registers. With the Slack-compatible API gone (§2.0), `/api/*` is the Workspace API and nothing else; the SPA fallback in Flow's `app.ts` already exempts `/v1` and `/api`.
- MCP Docs' own identity code goes away: `server/auth.ts`, the `users`, `sessions`, `password_resets`, `email_verifications` tables, the `/api/auth/*` routes, `AuthPage`, `PasswordResetPages`, `VerifyEmailPage`, `googleAuth.ts`, `mail.ts`'s sign-up mails. Flow's `/v1/auth/*` and `AuthScreen` are the only sign-in.
- MCP Docs' document data stays in SQLite for this merge (§3.2). Postgres for documents is a separate, later project.

### 2.2 One session, two transports

Flow's session (`sessions.token_hash`, 30 days sliding) is the only session. It travels two ways:

- `Authorization: Bearer` as today, for the Chat client, native apps and the agent bridge.
- An httpOnly, `SameSite=Lax`, `Secure` cookie `sid` on the app origin, set by `/v1/auth/login`, `/v1/auth/signup/complete`, Google/Apple sign-in and the handoff exchange, cleared by `/v1/auth/logout`. Flow's `requireAuth` (`routes/index.ts:51`) and the docs plugin's `requireUser` both resolve a request as: Bearer header if present, else the `sid` cookie. Cookie-authenticated requests that are not `GET`/`HEAD` must pass Flow's existing `originAllowed` (`lib/browserPolicy.ts`), which is the CSRF defence.

Why the cookie: the Workspace app's formats name files by URL (`/api/files/<id>` in `shared/video.ts`, `/api/images/...` in cells and slides), and the editors render them with plain `<img>`, `<video>`, iframes, `window.open`, downloads and the headless printer's print tickets. Converting all of that to bearer-fetched blob URLs would be a large refactor that loses streaming and caching. Flow's Chat client keeps using bearer only; nothing in it changes.

### 2.3 One user list: migrate MCP Docs' users into Flow's `users`

A one-off script (`packages/docs/scripts/migrate-users.ts`) run once at cut-over:

1. For each docs user, find a Flow user with the same email (`citext`). If found, that Flow user is the identity; docs' `owner_id` values are rewritten to the Flow id. If not, insert a Flow user with docs' `id`, `email`, `email_verified_at`, `created_at`, `display_name` from the email's local part.
2. Passwords: docs hashes are `scrypt$N$r$p$salt$hash`, Flow's argon2id. Flow's `verifySecret` learns the `scrypt$` prefix (10 lines) and rehashes to argon2 on the first successful login; nobody has to reset a password. A user who existed on both sides keeps Flow's password.
3. `users.google_sub` becomes an `oauth_identities(provider='google', provider_subject)` row, unless the Flow user already has one.
4. Docs sessions, password resets and verifications are dropped; everyone signs in again once. The ChatGPT plugin's OAuth grants and refresh tokens (`plugin/server/oauth.ts`, its own tables) are migrated as they are, re-keyed to the merged user ids, so ChatGPT users are not signed out (§6).
5. The script is idempotent and run against a copy first; the cut-over keeps the old box read-only until the new origin is verified.

Deleting a Flow user must also delete their private docs data: today SQLite cascades from `users`; after the merge `owner_id` has no foreign key, so `removeAgent`/account deletion in Flow calls `docs.deleteUserData(userId)`.

### 2.4 Files belong to an organization, or are private

Flow scopes everything by workspace; MCP Docs scopes everything by owner. The bar's organization switcher ("Harbor & Pine ▾") implies the Workspace tab shows that organization's files. The rule:

- `sheets`, `stored_files`, `images`, `folders`, `public_links` gain `workspace_id TEXT NULL`. `NULL` means private to `owner_id`. A non-null value means every member of that Flow workspace can list, open and edit it; `owner_id` becomes "created by".
- The Workspace home lists two roots for the selected organization: **Organization files** (`workspace_id = organization`) and **My files** (`workspace_id IS NULL AND owner_id = me`). Favorites and Recents stay per user.
- **New files are private.** New, imported, uploaded and assistant-made files land in My files whatever organization is selected, unless made inside a folder of Organization files, which is the one explicit act that puts a file in the organization. Move to organization / Make private are folder and file menu actions (`POST /api/files/:id/move` already exists for folders; it gains `workspace`), and Share to channel (§5) offers the move.
- Migration puts every existing docs file in **My files** (`workspace_id = NULL`). Nothing that was private becomes visible to anyone else at cut-over.
- Access checks are one function, `docs.canAccess(user, file)`: owner, or member of `file.workspace_id` (looked up through Flow's `workspace_members`). Per-file sharing and roles are out of scope here; public links (`/p/<token>`) keep working as they are.
- The assistant's server tools (`list_files`, `create_sheet`, …) and the hosted MCP tools take the user's current organization from the request (`?workspace=` or the chat's scope) and default to My files.

Naming (ruled, §0): Flow calls the organization a "workspace" (`workspaces`, `workspace_members`, `WorkspaceChooser`, `WorkspaceRail`), and the new tab is "Workspace". In code the Flow name stays for now; renaming the tables and DTOs is a mechanical follow-up with its own migration, not part of the merge. In the UI the thing in the switcher is shown by its name and called an **organization** in copy ("Switch organization", "Invite to organization", "Organization settings", "Organization files"), on web, macOS and iOS, and in the invite and join emails. The Workspace tab is office work: the editors now, email later as another module under `/workspace/mail` with its own entry in the Workspace home, which is why the Workspace home is a hub (library, recents, favorites, scratch pads) rather than only the file list.

### 2.5 One web app with a suite bar

`packages/web` becomes the suite. It gets react-router (the Workspace app already uses v7; Chat ignores the URL today and keeps doing so under its own route):

```
/                      → redirect to the last-used app (localStorage), default /chat
/chat                  → Flow's SessionApp/Main, unchanged inside; its own state navigation
/workspace             → Docs home (FileLibrary) for the selected organization (the tab is "Docs"; the path stays /workspace)
/workspace/s/:id  /workspace/d/:id  /workspace/doc/:id  /workspace/md/:id  /workspace/f/:id
/workspace/settings    /workspace/connectors
/p/:token              → public page (no sign-in)             — unchanged
/invite/*  /join/*     → Flow's one-shot paths                 — unchanged
/settings, /account    → Flow's account/profile; Workspace's Assistant/Agents tabs move in here
```

Old docs URLs (`/s/:id`, `/d/:id`, …) 301 to `/workspace/...`. `mcpdocs.freeflow.im` redirects to `app.freeflow.im` with the path kept (Flow's `FLOW_REDIRECT_FROM_HOSTS`, which exempts `/v1` and `/api`). `docs.freeflow.im` is different: it stays the ChatGPT plugin's address and is served by the suite itself (§6). File ids are UUIDs, globally unique, so a file URL needs no organization in it: opening `/workspace/doc/:id` selects the file's organization in the switcher.

**The suite bar** (designed 2026-11-01 on the canvas "FreeFlow Suite Bar", https://claude.ai/artifact/1LCEMk8dwyP6gEPaMBs2Av, which is the reference for phase 3): one 56px bar on every signed-in page, above both apps' own chrome.

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ [▤] FreeFlow │ Locked In ▾   ( Docs │ Chat ●3 │ Mail │ Calendar )   ⌕  [✦ Assistant]  🔔  (SP) Scott │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

- Left, where you are: the mark (28px, the sheet on the blue), the wordmark "FreeFlow", a hairline, then the organization's **name** with a caret, no avatar (ruled out). The button is Flow's workspace switcher: the user's organizations (grouped by server when there is more than one) with unread counts and small avatars in the rows, Add organization, Organization settings (Flow's admin view), Invite people. This replaces Flow's vertical `WorkspaceRail` (`Main.tsx:749`) and the `WorkspaceChooser`; a user in no organization still gets the chooser as a page.
- Centre, which app: a segmented control on a grey track, **Docs** and **Chat**, then **Mail** and **Calendar** as placeholders (grey, not clickable, "Coming soon" on hover; hidden on a phone) until those apps land (one tab per app, each with its own left column: Docs its folders, Chat its channels; a "Work" hub holding them under one tab was considered and rejected on 2026-11-01, as it nests three levels). The active one is a white pill; Chat shows the unread-notification count (Flow's `LiveContext`). Keyboard: ⌘1 to ⌘4. Centred whatever the sides measure.
- Right, tools then you, in this order: **search** as an icon, left-most so that clicking it (or ⌘K) opens a 380px field in place growing leftwards into the free space (files on Docs, messages on Chat; Esc collapses it); the **Assistant** button (bordered, the spark in blue), which opens the assistant panel in either app and moves up from Workspace's own header; **notifications** (Flow's activity view); the **account** button (avatar and first name) whose menu is: name and email as a header; presence (Active, Set away) and Set a status…, moved up from Chat's lower-left user block, which goes away; My profile; Settings (the suite's settings page: Flow's account settings with Workspace's Assistant and Agents tabs inside); Log out, which ends the session for both apps. In the desktop app the Local | Web `PlaceSwitch` sits in this group too.
- Below 640px the mark, the wordmark, the user's name, search and notifications go; the organization's name (truncated), the caret, the control, the Assistant spark and the avatar stay. Chat's existing mobile drawer and Workspace's layout are unchanged.
- The Chat runtime (`ConnectionRuntime`, `SocketClient`, TanStack `QueryClient`, `HuddleProvider`) is created by the suite shell, not by the `/chat` route, so the socket stays open while the user is in Workspace: the Chat badge is live, OS notifications still arrive, and a huddle keeps running (the `HuddleMiniBar` renders in the bar's right group when a huddle is active).
- Flow's multi-server connections (`ServerConnections`, `ConnectionManager`) are kept as they are: the switcher groups organizations by server, as the multi-server spec says. An organization on another Flow server has no Workspace yet; the Workspace tab is disabled for it with a tooltip.

Inside each app:

- Workspace's editor headers (`wb-header`: logo, star, folder crumbs, title, menubar) lose the logo link (the bar has the organization and the tab) and the `Account` menu; everything else stays. The home page's `home-header` drops its brand and `Account` the same way. `useAuth()` is re-implemented over Flow's `AuthContext` + the runtime: `user`, `local`, `logout`, and the current organization. `api.ts` keeps `credentials: 'same-origin'` and additionally sends the bearer when the runtime has one, so the same client works in Electron where the token is in the keychain and the cookie is on a different origin (`app://flow`).
- Chat keeps its sidebar, channel view, side panel. Its header's back/forward buttons stay.

**Styling.** Chat is Tailwind 4 with a violet `@theme`; Workspace is 7k lines of plain CSS with generic class names (`.btn`, `.toolbar`, `.menubar`). They coexist by scoping, not by rewriting:

- Tailwind's preflight is not loaded globally. It is imported inside `@scope (.chat-app)` so Chat's resets apply only under its root. Tailwind utility classes are atomic and clash with nothing in `styles.css`.
- `styles.css` is wrapped in `@scope (.workspace-app)` (native CSS nesting; the file is already one flat list of selectors) except the `:root` tokens and the landing/marketing rules, which are moved to the suite's base stylesheet.
- The suite bar has its own small stylesheet on Flow's `@theme` tokens, so the bar looks like the image on both apps. The accent is MCP Docs' blue (§0): Flow's `--color-accent`, `accent-deep` and `accent-soft` are re-pointed from the oklch violet to `#1A73E8` and its shades, which recolours Chat's buttons, links, unread marks and the sign-in screen in one place; `index.html`'s `theme-color` follows. Workspace's `--blue` is already that value. The sheet mark (`Logo`) becomes the suite's: sign-in screen, landing page, favicon (the per-kind favicons stay inside Workspace) and the desktop icon when the apps merge (§7).
- Dark mode: neither app has one; out of scope.

**Build.** The toolchains differ (TS 7 / Vite 8 / Vitest 5 against TS 5.6 / Vite 6 / Vitest 2). The monorepo moves to the newer set in one PR before the merge (pnpm catalogs); Flow's test suites are the check. The docs package keeps running its server with Node type stripping in dev; for the AWS image it is compiled with the rest (its imports already use `.ts` extensions, which `tsc` with `rewriteRelativeImportExtensions` handles). The Workspace client is a lazy route chunk; the editors are already code-split.

## 3. Server

### 3.1 Process layout

```
packages/server/src/index.ts
  createApp()
    ├─ Flow: /v1/*, /v1/ws, /healthz, /download/*
    ├─ registerDocs(app, { db: sqlite(DATA_DIR), auth, organizations })   ← packages/docs/server
    │     /api/files, /api/sheets, /api/docs, /api/decks, /api/markdown, /api/library, /api/folders,
    │     /api/images, /api/trash, /api/favorites, /api/recents, /api/revisions, /api/sharing,
    │     /api/agent, /api/settings/*, /api/connectors, /api/public/:token
    ├─ mountPlugin: /mcp (v1, Universal Docs), /mcp/v2, /oauth/*, /.well-known/*, /plugin/*
    │     on every host; on docs.freeflow.im these and /privacy, /terms, /support are all there is (§6)
    └─ static: packages/web/dist, landing.html at / for visitors, SPA fallback
```

`registerDocs` receives three things from Flow instead of building its own: the authenticated user (`req.user`, set by Flow's hook), `organizations` (`isMember(userId, workspaceId)`, `listMemberships(userId)` over Postgres, cached per request), and `mail` (Flow's email driver) for the assistant's few emails. Docs' `AuthService`, `googleAuth.ts` and `mail.ts` are deleted; `legal.ts`, `marketing.ts` and the prerendered landing page move to the suite (the hosted front page is now the suite's).

Environment: docs' variables keep their names (`DATA_DIR`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `BRAVE_SEARCH_API_KEY`, `CONNECTOR_ENCRYPTION_KEY`, `CHROMIUM_PATH`, `R2_*`, `PLUGIN_*`). `GITHUB_TOKEN`, `GITHUB_REPO` and `CODING_MODEL` go with the app-change jobs (§6). `APP_URL` becomes `FLOW_WEB_URL`; `GOOGLE_CLIENT_ID/SECRET`, `SECURE_COOKIES` and `LEGACY_HOSTS` are Flow's. `docs/architecture.md` and both `CLAUDE.md`s are merged into one.

### 3.2 Data

**The target, ruled 2026-11-02: the suite moves to Cloudflare, one tenant at a time.** The service is strictly
multi-tenant and every tenant (organization) is small, so there is no central database in the end state: each
organization is one Durable Object holding its own SQLite (members, channels, messages, files' and documents'
metadata, folders, the assistant's conversations) and its WebSocket connections (hibernating sockets replace NATS
and the gateway); blobs stay in R2; the clients are static assets on a Worker; mail is Cloudflare's; PDFs are the
Browser Rendering API; nightly jobs are Cron Triggers. The one thing that is not per tenant is the **directory**:
email → user, user → organizations, sessions, OAuth identities, invites by email. It is tiny and lives in one
directory object or a small D1 database. Until then, the rules that make the move cheap:

- **Organization is the partition key.** Phase 4 gives every Docs row an organization id and filters by it; that
  column is the tenant boundary later. New Chat data is keyed by workspace as it already is.
- **SQLite is the dialect of record.** New code avoids Postgres-only features (`citext`, `jsonb`, `FOR UPDATE
  SKIP LOCKED`); a service touched for another reason has its queries made to run on both.
- **Postgres and NATS are not permanent.** They stay on the box as they are; no RDS move, no new NATS use, and an
  in-process bus when `NATS_URL` is unset. Docs' metadata does not move to Postgres.
- **Identity is the directory already.** Users, sessions and memberships stay small and reached through their own
  services, so they lift out first.
- Flow's server itself is the cost of the move: Fastify, drizzle over Postgres, native argon2, Playwright and the
  file system do not run on Workers. It is ported one bounded context at a time behind the same API (Hono, the
  Durable Object's SQL, WebAssembly argon2 or a hash migration), with both stacks running during the move.

Until that move, the arrangement below holds. Documents stay in SQLite on the EBS data volume (`/data`, as today), with the files beside it under `DATA_DIR`, because the docs stores are synchronous `node:sqlite` code shared with the desktop app's folder-backed subclasses (`localStore.ts`); making them async over Postgres touches 18 files and every caller, and the desktop app would still need SQLite. Consequences, accepted for this merge:

- The combined process runs as one replica (docs already does; the SSE revision feed is per process). `deploy.sh` starts the new container before stopping the old one, as it does now. If Chat needs replicas later, the docs plugin can run as its own service behind the same origin with the Flow server proxying `/api/*`; the plugin boundary is designed so that is a config change, not a rewrite.
- `backup.ts` keeps copying SQLite and files to R2, and the volume's daily snapshots now cover Postgres too (§3.4); the volume is the primary.
- Two file stores exist: Flow's encrypted R2 `files` (chat attachments) and docs' `stored_files` on disk. §5 bridges them; unifying them (docs' `FileStore` over Flow's `BlobStore`, encrypted) is the first follow-up after the merge, and the step that makes the process stateless.

The revision feed publishes on NATS (`docs.rev.<fileId>`) as well as in-process, so other replicas or services can follow it later. Nothing else in docs uses NATS at first.

### 3.3 Auth, in detail

- `requireAuth` → `authenticateRequest(req)`: Bearer → `auth.authenticateWithKind`; else cookie `sid` → the same; else 401. Agent tokens (`agent_tokens`) are accepted everywhere, including docs routes and `/mcp`, which is how Flow agents get Workspace tools (§5).
- Login responses set the cookie and return the token (`{token, user}`) as now; the web client keeps the token in the runtime for the Authorization header too, which is what Electron and the multi-server code expect.
- Print tickets (`PrintTickets` in docs' `pdf.ts`) and public links keep their own cookie and token; they only grant read access to one file.
- Google: Flow's ID-token flow replaces docs' code flow; the docs desktop app's Web-tab handoff (`/api/auth/handoff`) is replaced by Flow's `/v1/auth/handoff/{start,approve,exchange}` (PKCE), which is what its Electron shell already uses.

### 3.4 Hosting: everything on AWS, Railway retired

The MCP Docs stack (`deploy/aws/template.yaml`: one Graviton instance in its own VPC, Caddy for HTTPS, an EBS data volume at `/data` with daily snapshots kept 14 days, ECR, CloudWatch, secrets as SSM parameters, deploy by `aws ssm send-command` from `.github/workflows/aws-deploy.yml`) becomes the suite's stack. It gains:

- **Postgres 16 and NATS 2.10 as containers on the instance**, started by `deploy.sh` beside the app and Caddy, with Postgres' data directory on the data volume so the existing snapshots cover it. This is Flow's own "one Node process, a Postgres, a NATS" shape from `DEPLOYMENT.md`, on one box. RDS is the upgrade path if the database should outlive the instance on its own: the app only sees `DATABASE_URL`, so switching is a parameter change plus a dump and restore.
- **Flow's data moves from Railway**: `pg_dump` of the Railway Postgres restored into the new one during the cut-over window (§8, phase 2), `FLOW_DATA_KEY` copied exactly (messages and files are unreadable without it), R2 bucket and credentials unchanged, LiveKit Cloud unchanged, the Cloudflare email driver unchanged, `FLOW_WEB_URL = https://app.freeflow.im`.
- **DNS**: `app.freeflow.im` and `docs.freeflow.im` point at the instance; Caddy holds certificates for both, plus `mcpdocs.freeflow.im` for the redirect. `/download/mac` and the Sparkle appcast keep being served by the app from R2, so macOS updates are unaffected.
- **Instance size**: the image now holds Chromium, LiteParse and Tesseract beside Flow; `t4g.medium` (4 GB) is tight with Postgres and NATS on the box. Plan for `t4g.large`.
- **Retired**: the Railway project (Flow server, Postgres, NATS, the `slack-connector` service), `railway.json`, the Railway section of `DEPLOYMENT.md` and `BUILD.md`, `RAILWAY_GIT_COMMIT_SHA` in the web build (`GIT_COMMIT_SHA` from the image instead). `DEPLOYMENT.md`'s self-hosting guide stays valid: the Docker image runs anywhere with a Postgres and a NATS.

The one-replica limit (§3.2) is what makes a single box the right size; the day the suite needs more, the Postgres and NATS containers move to managed services first and the Workspace plugin becomes its own service second.

## 4. Client

- `packages/web/src/App.tsx` becomes the suite: connection runtime, auth gates (`AuthScreen`, `JoinScreen`, handoff) as today, then `<SuiteShell>` with the bar and `<Routes>`.
- `packages/docs/client` is imported as a library (`@flow/docs-client`): it exports `WorkspaceRoutes` (its current `<Routes>` minus auth pages), `AgentProvider`/`AgentPanel`, `FilePreviewFrame`, `useAuth` adapter inputs. Its `main.tsx` stays only for the standalone desktop build (§7).
- Shared primitives are not unified now. The two apps keep their own buttons, menus and modals; the bar is the one shared component. A design pass can pull them together later.
- Tests: docs' Vitest suites (85 files) move as they are; the `docs` package has its own `vitest.config`. Flow's `pnpm -r test` runs them.

## 5. Chat ↔ Workspace, the reasons to combine

In order of value, all after the merge lands:

1. **Share to Chat.** Every editor's File menu and the library's row menu get "Share to channel…": picks a channel, posts a message with a `doc` artifact (new `artifacts.kind = 'doc'`, `doc_id` + `doc_kind`). Chat renders it with docs' `FilePreviewFrame` (the existing `?preview` mode) in the side panel's artifact tab, with Open in Workspace. Membership of the file's organization is the access check; a private file shared to a channel is moved to the organization first (asked).
2. **Open in Workspace.** A chat attachment that is `.xlsx`, `.docx`, `.pptx`, `.md`, `.csv` or a PDF gets Open in Workspace in `FilesPanel` and the message: the server imports the bytes with docs' `importBytes` into Organization files and opens the editor. Chat's read-only `SpreadsheetPreview` stays for the quick look.
3. **Agents.** Flow agents' tokens are accepted by `/mcp` (the hosted MCP server with the docs tools), so `flow-agent-bridge` can add the Workspace MCP to the agent's config alongside Flow's own, and an agent asked in a channel can make a deck in Organization files and share it back. The docs tool list is already stable (`plugin/server`, version 2).
4. **The in-editor assistant** gets `post_to_channel` and `read_channel` server tools over Flow's services, so "summarise #sales into this sheet" works.
5. **Activity.** A document's revision and a share both become `notification` rows later; not in the merge.

## 6. The ChatGPT plugin: Universal Docs stays Universal Docs

What ChatGPT reviewed is a contract: the manifest `plugin/plugin.json` (display name Universal Docs, server address and the privacy, terms and support pages on `docs.freeflow.im`), the MCP server named `freeflow-docs` at `/mcp` with the version 1 tool list (`plugin/server/mcp-v1.json`, checked by tests), its widget resources titled Universal Docs, and its OAuth server (`plugin/server/oauth.ts`, app name Universal Docs). None of that changes. The plugin code already serves `/mcp` as version 1 and `/mcp/v2` as the newer MCP Docs tool set (`mcpVersion`, `serverInfo`, `instructionsFor`), so keeping version 1 costs nothing; the suite's own agents use `/mcp/v2`.

Two ways to keep it, and the recommendation:

- **Recommended: the suite serves it, at the same address.** `docs.freeflow.im` points at the suite. For that host the server answers only the plugin's paths (`PLUGIN_PATH`: `/mcp`, `/oauth/`, `/plugin/`, `/.well-known/...`), the legal pages the manifest links (`/privacy`, `/terms`, `/support`) and the plugin's web view assets, and redirects any other path to `app.freeflow.im`. ChatGPT sees the same server name, tools, OAuth metadata and address, so there is no resubmission. The OAuth authorization page, which today signs the user in with docs' `AuthService` and sets docs' cookie (`mountPlugin`'s `auth`, `google`, `sendMail`, `sessionCookie`), instead sends the user to the suite's sign-in (`AuthScreen`) and comes back to approve; its grant and refresh-token tables migrate with the user ids (§2.3). Everything a ChatGPT user makes is in their FreeFlow account, in My files, and opens in Workspace from the "open in the full app" link. One user list, one deployment.
- **Not recommended: leave the EC2 box running the old app for the plugin.** It keeps a second users table and a second library: a file made in ChatGPT is not in the suite and a FreeFlow account cannot be used in ChatGPT, which is the opposite of the goal; it also keeps a second deploy pipeline and a second set of secrets alive indefinitely. It is a reasonable *freeze* for a few weeks if the cut-over has to be split, with sign-up on the old box turned off, but not a destination.

A **FreeFlow plugin** for ChatGPT, with Workspace and Chat tools (`/mcp/v2` plus channel tools), is a new submission later, and the Universal Docs listing can be retired when it is approved. `shared/brand.ts` keeps `PLUGIN_NAME = 'Universal Docs'` for the version 1 endpoint and its app, and the plugin's `Library.tsx` keeps its name.

Other things that must keep working through the cut-over:

- **Hosted MCP for Claude Code / Codex** (`claude-plugin/`, the `npx @freeflow-im/mcp-docs` installer): it uses the version 2 endpoint; `docs.freeflow.im/mcp/v2` keeps answering, and the installer's next version prints `app.freeflow.im/mcp/v2`.
- **Public links** `/p/<token>`: same path on the new origin; old-host links redirect.
- **Assistant app-change jobs are retired** (ruled, §0): `server/agent/worker.ts`, `server/agent/jobs.ts`, the `agent_jobs` table, the `JOB_TOOLS` and `PROMPT_WITHOUT_JOBS` split in `server/agent/prompt.ts` (the prompt without jobs becomes the prompt), the `/api/agent/jobs` routes, the `/changes` page and the `AgentOptions.jobs` flag. The "Rules for automated changes" section of MCP Docs' `CLAUDE.md` goes with them; Flow's factory channel is how the suite changes itself.
- **Email**: docs used Resend or Cloudflare; Flow uses Cloudflare. One driver, Flow's.
- **Desktop MCP Docs users** are unaffected: the Local side of the desktop app has no account.

## 7. Desktop and native, after the web merge

- **One Electron app.** MCP Docs' `desktop/main.js` is the richer shell (per-folder local servers, the local MCP server with OAuth for agents, the updater, new-file watching, Office file associations, Local | Web tabs). Flow's `apps/desktop` adds what Chat needs (`window.flowDesktop`: keychain secrets, notifications, badge, tray, `flow://` links). The merged app is MCP Docs' shell with Flow's preload bridge: its Web tab loads the suite (Chat and Workspace, signed in through the keychain and the PKCE handoff), its Local tabs are the local Workspace as today. The native macOS Swift app stays the promoted macOS Chat client; the Electron app is the one that has Workspace.
- **macOS and iOS (Swift)**: already on Flow's auth, so they are on the single user list the day of the merge. They get a Workspace tab later that opens `/workspace/...` in a web view with the session handed off (the handoff endpoints exist), and "Open in Workspace" on attachments. Parity gaps go in Flow's `CHANGELOG.md` Parity ledger as its conventions require.
- **Agent bridge**: no change for the merge; §5.3 adds the Workspace MCP.

## 8. Phases

Each phase ships on its own and leaves both products working.

0. **Decisions** (§0): all ruled.
0.5 **Slack out of Flow** (§2.0): the Slack-compatible API and apps, then the Slack connector on web, macOS and iOS, each with a release. Flow only; MCP Docs untouched. The `slack-connector` Railway service is deleted here.
1. **Monorepo.** `git subtree add` mcp-docs into `packages/docs`; pnpm workspace; one toolchain (TS 7, Vite 8, Vitest 5); the app-change jobs removed; CI runs both test suites. Both deploys unchanged. No user-visible change.
1.5 **Flow to AWS** (§3.4): Postgres and NATS on the stack, Flow's image built by the AWS workflow, data moved from Railway, `app.freeflow.im` re-pointed, Railway project deleted. Chat only; a rehearsed cut-over on its own, before the identity merge, so that phase 2 changes one thing.
2. **One identity.** Cookie transport in Flow's auth; `registerDocs` plugin; docs' auth code removed; the plugin's OAuth over the suite's sign-in; user and OAuth-grant migration script; one image on the AWS stack (Flow plus the Workspace server, Chromium, LiteParse/Tesseract, `DATA_DIR` on the data volume); `mcpdocs.freeflow.im` redirects, `docs.freeflow.im` serves the plugin from the suite. Users sign in once with Flow's screen and land on their files. The two apps are still separate pages (`/` Chat, `/workspace` Docs) with no bar yet.
   *Code done (PR "One identity", 2026-11-01):* the cookie transport (`packages/server/src/lib/sessionCookie.ts`), the Workspace app mounted by `packages/server/src/workspace.ts` through docs' `buildApp({ host })` (its own sign-in routes, mailer and Google sign-in are off when hosted; its `users` table mirrors Flow's), the client under `/workspace`, the plugin's OAuth pages over the suite sign-in (`/oauth/resume`), `/?next=` in the web client, scrypt hashes accepted and rehashed at sign-in, and `packages/server/scripts/import-workspace-users.ts`. The suite's image holds the Workspace app (`packages/server/deploy/aws/Dockerfile`), and the stack's `workspace-to-suite.sh` moves it over: `docs/ops/WORKSPACE_TO_SUITE.md` is the cut-over, the operator's to run on its own day.
3. **The suite bar.** Router, shell, bar, organization switcher replacing the rail, `useAuth` adapter, CSS scoping, Chat runtime hoisted into the shell, Chat badge. This is the phase the image shows.
4. **Organization files.** `workspace_id` on every Docs row (the tenant partition key of §3.2), Organization files / My files, access checks, MCP and assistant tools organization-aware. Docs' metadata stays SQLite; it is not moved to Postgres (§3.2's ruling).
5. **Cloudflare, Chat first** (§3.2's end state; ruled 2026-11-02 to come right after phase 4, and before any new app). Cloudflare in front of `app.freeflow.im`, routing by path, so a Worker takes one bounded context at a time while the AWS box serves the rest: the directory (users, sessions, memberships) first, then one Durable Object per organization with its SQLite and its sockets serving channels and messages. Postgres and NATS retire with the last context.
6. **Cloudflare, Docs second.** The Docs server's SQLite-shaped stores port into the same per-organization object; PDFs to Browser Rendering; bodies and uploads stay in R2. The AWS instance then only builds the desktop app, and goes.
7. **Mail and Calendar**, built on the new runtime, each its own tab with its own left column (the placeholders light up).
8. **Desktop and native** (§7).

The integrations of §5 (Share to Chat, Open in Docs, agents with Docs tools, the assistant reaching Chat, activity rows) are **dropped from the plan** (ruled 2026-11-02); §5 stays as a record of what was considered.

Phases 1.5 and 2 were the risky ones (both done 2026-11-01); the Cloudflare phases move live data again, one context at a time, with both stacks running. Rehearse both on copies, keep the Railway project and then the old docs app read-only but reachable for a week after their cut-overs, and do them on different days.

## 9. Decisions taken, and what is still open

Ruled by the operator on 2026-11-01 (§0): FreeFlow as the suite name; MCP Docs' sheet mark and blue; Flow workspaces are organizations in UI copy and the Workspace tab is office work; new files private by default; everything on AWS with Railway retired; app-change jobs retired; both Slack systems removed before the merge; the Universal Docs plugin kept at its address with its version 1 tools.

Still open, none blocking the first phases:

1. **Customers tab.** The image has a third tab. Nothing here depends on it, but the bar's segmented control is a list, not two hard-coded entries, so a third app can be added without touching the bar.
2. **Email in Workspace.** Named as the next module under the Workspace tab; no design yet. It only constrains this document in that the Workspace home is a hub and `/workspace/mail` is reserved.
3. **Renaming `workspaces` in code** to organizations: a mechanical follow-up with a migration and DTO rename across web, macOS, iOS and the agent bridge, after the merge.
4. **RDS or Postgres on the box** (§3.4): the design starts on the box; the switch is a parameter change when wanted.
