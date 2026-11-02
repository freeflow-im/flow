# Brief: Docs respect the current organization (FreeFlow phase 4)

The design is `docs/specs/freeflow-suite.md` §2.4 ("Files belong to an organization, or are private"); read it
first, then §3.2's rules (SQLite as the dialect of record, organization as the partition key) and
`docs/specs/cloudflare-migration.md` §5–6 (PR #649 if not merged: `gh pr diff 649 --repo freeflow-im/flow`).
This PR makes the Docs tab show the files of the organization chosen in the suite bar, beside the user's
private files, with the rules below. It is the last data change before the Cloudflare move, and the
organization id it adds to every row is the tenant partition key of that move.

## The rules (from §2.4, with the decisions this PR makes)

- Every Docs row that belongs to someone (`sheets`, `stored_files`, `images`, `folders`, `public_links`,
  `agent_conversations`) gains `workspace_id TEXT NULL`. `NULL` means private to `owner_id`. A value means
  every member of that organization (Flow's `workspace_members`) can list, open and edit it, and `owner_id`
  is "created by". Existing rows stay `NULL`: nothing private becomes visible at deploy.
- The Docs home shows, for the organization selected in the bar, two roots: **Organization files** and
  **My files**. *Ruled 2026-11-02 (replacing "My files are the user's, the same from every organization"):*
  **My files is specific to the organization**: someone at company A and company B has a private locker in each.
  Every row carries `workspace_id` (the organization) and `private INTEGER NOT NULL DEFAULT 1`; Organization
  files are `workspace_id = X AND private = 0`, My files in X are `workspace_id = X AND private = 1 AND owner_id
  = me`, plus the user's rows from before organizations (`workspace_id IS NULL`), which show in My files of
  whichever organization is selected. A private row is its owner's only, a shared row any member's of its
  organization, a row without an organization its owner's only. The scope is `{ ownerId, workspaceId, private }`.
  Without a host `workspace_id` stays NULL and everything behaves as today. In `cloudflare-migration.md` §6 the
  first open question resolves as: private files live in the organization's object; rows without an
  organization are assigned at migration to the organization the user chooses; no per-user object. Favorites
  and Recents stay per user across organizations.
- **New files are private**: new, imported, uploaded, pasted and assistant-made files land in My files
  of the selected organization, unless made inside a folder of Organization files, which is the one act
  that shares a file with the organization. "Share with organization" (private → Organization files, same
  organization), "Make private" (back) and, for someone in several organizations, "Move to organization…"
  (change `workspace_id`, keeping the private flag) are row-menu and File-menu actions on files and folders;
  moving a folder moves its contents.
- **The access check is one function**, `canAccess(user, row)`: owner, or member of `row.workspace_id`
  through the host (`host.isMember(userId, workspaceId)`, which `packages/server/src/workspace.ts` provides
  from Flow's `services/workspaces`, cached for a minute per pair). Every route that today loads a row by
  `(owner_id, id)` loads it by id and checks access instead; a row the user cannot access is a 404, as now.
- Public links (`/p/<token>`) keep working as they are. The ChatGPT plugin (`/mcp`, My files only) and the
  desktop app's local mode (no host, no organizations) are unchanged: without a host there is no
  organization anywhere, so `LocalSheetStore` and friends need no change beyond the signature.
- The in-editor assistant's server tools (`list_files`, `create_*`, `import_file`, `search_files`, …) take
  the scope of the chat they run in: a file's chat uses that file's scope; the home chat takes
  `?workspace=` (the bar's organization) and defaults to My files. The hosted MCP tools default to My files.

## How to implement it (the shape; adjust where the code says otherwise)

- **A scope, not two code paths.** Define `type Scope = { ownerId: string; workspaceId: string | null }` in
  `packages/docs/server/scope.ts` with `scopeKey(scope)` and a SQL fragment helper. The stores
  (`sheets.ts`, `files.ts`, `images.ts`, `folders.ts`, `publicLinks.ts`, the agent store) take a `Scope`
  where they take `ownerId` today for listing and creating; by-id reads become `find(id)` plus the caller's
  `canAccess`. `list(scope)` is `WHERE workspace_id = ?` for an organization and `WHERE owner_id = ? AND
  workspace_id IS NULL` for private. Creates write `owner_id` = the user and `workspace_id` = the scope's.
  Migrations are `ALTER TABLE … ADD COLUMN workspace_id TEXT` in `db.ts`'s existing style, plus indexes
  on `(workspace_id, folder)`. Folders: a path is unique per scope, so `folders` rows carry the scope too and
  `FolderStore` methods take a `Scope`.
- **Routes** (`packages/docs/server/app.ts`): listing and creating routes take `?workspace=<id>` (or
  `workspace` in the body) and resolve the scope after checking membership (`403` if not a member); by-id
  routes resolve the row and `canAccess`. A new `POST /api/files/:id/scope { workspace: string | null }`
  moves a file (and `POST /api/folders/scope { folder, workspace }` a folder with its contents) between
  roots: membership checked for the target, the folder path reset to the root unless the target has the
  same folder. The revision feed and the print tickets keep working for organization files.
- **Host contract** (`packages/docs/server/app.ts` `AppOptions.host`, `packages/server/src/workspace.ts`):
  add `isMember(userId, workspaceId): Promise<boolean>` and `organizationsOf(userId): Promise<Array<{ id,
  name }>>`; the Flow side implements them over `services/workspaces.ts`. Tests in
  `packages/server/test/workspace.test.ts`: a member lists and opens an organization file, a non-member gets
  404, creating in an organization folder lands in the organization, a private file stays private.
- **Client** (`packages/docs/client`): the home page (`pages/HomePage.tsx`, `components/FileLibrary.tsx`)
  shows the two roots for `readActiveOrganization()` (`client/src/suite.ts`, written by the bar) as a
  segmented pair above the list, Organization files first when an organization is selected; My files alone
  when the suite is not hosting (standalone and desktop keep today's single list). `api.ts` passes
  `workspace` on list and create calls; the current root is in the URL (`/workspace?org=<id>` vs none) so
  reload and back keep it. Row and folder menus and the editors' File menu get Move to organization… (a
  small picker of the user's organizations from `/v1/me/workspaces`, which the bar already fetches) and
  Make private. The breadcrumbs name the root. Changing the organization in the bar re-renders the home.
- **Assistant and MCP** (`packages/docs/server/agent/tools.ts`, `plugin/server/files.ts`): the server tools
  take a `Scope` from the chat; the home chat's turn request carries the organization. Prompt text only
  where Claude must know ("files are the user's private ones unless …").
- **Docs**: `packages/docs/docs/architecture.md` (the scope, the access check, the two roots) and
  `docs/specs/freeflow-suite.md` §2.4 (a line saying this PR did it; anything that differs).

## Verify

- `pnpm -r typecheck`, `GOOGLE_CLIENT_ID= pnpm -r test`, `pnpm -r build`; the docs suite grows with tests for
  the stores' scoping and `canAccess`; the client tests for the two roots.
- Run the suite locally as `docs/specs/suite-bar-build.md` §5 describes (port 8790, a fresh
  `WORKSPACE_DATA_DIR` under `~/flow-org/.workspace-data`, the dev Postgres on 5442), with two users in one
  organization and one of them in a second: user A makes a private file and an organization file; user B sees
  only the organization file and can edit it; user A moves the private file to the organization and B sees
  it; A makes it private again and B gets 404 by URL; the assistant's `list_files` from the home chat lists
  the right root. Screenshots of the home with both roots, the move picker, and an organization file open,
  into `/private/tmp/claude-501/-Users-scottp-src-mcp-docs/b5c20c86-b7b8-46e0-8c8d-5488ecdf23a3/scratchpad/org-files-shots/`, listed in the report.
- Both Docker images still build (`packages/server/deploy/aws/Dockerfile`).

## Conventions and constraints

- Only in the worktree `~/flow-org` (branch `suite/org-files`, from `origin/main`); never `~/flow` or the
  other worktrees. Never commit `.workspace-data/` or `.emails/`.
- Flow's conventions: one new `changelog/2026-11-02-organization-files.md`, the PR's client-impact checklist
  (web yes; macOS/iOS/desktop none), no `decision_log.md` edits. Long lines fine, single quotes, no Prettier
  over whole files. SQL that would also run on Postgres: no SQLite-only tricks beyond what `db.ts` already uses.
- Known test quirks: `multiserver.test.ts › browser contract` needs `GOOGLE_CLIENT_ID=`; the agent-bridge
  process-group test is flaky under load (rerun alone).
- No production, AWS, Railway or DNS changes. Push only to `suite/org-files`. Open the PR with
  `gh pr create --repo freeflow-im/flow --base main --head suite/org-files`.
- Report at the end: PR URL, screenshot paths, every departure from this brief and why, and what is left.
