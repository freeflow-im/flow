# Brief: the suite bar on both apps (FreeFlow phase 3, first PR)

The design is settled: `docs/specs/freeflow-suite.md` §2.5 (PR #647, merge pending; read that PR's version of
§2.5 and `decision_log.md` if it is not on main yet: `gh pr diff 647 --repo freeflow-im/flow`). The canvas it
links is the picture: mark · "FreeFlow" · the organization's name with a caret | **Docs** · **Chat** (unread
badge) · **Mail** · **Calendar** (the last two grey placeholders) | search icon · **Assistant** button ·
notifications · avatar + first name, whose menu is: name and email; presence (Active / Set away) and
Set a status…; My profile; Settings; Log out. 56px, white, hairline below, blue `#1A73E8` accent, no
organization avatar in the bar (small ones in the menu rows are fine).

This PR puts that bar on **both apps as they are today**: Chat (`packages/web`) at `/` and the Workspace app
(`packages/docs`, now the **Docs** tab) at `/workspace`. Each tab is still its own page (switching navigates);
making them one React app with a shared runtime is the next PR, not this one. The result must look like the
canvas on both apps and remove the chrome the bar replaces.

## The pieces

1. **A shared package `packages/suite-bar`** (`@flow/suite-bar`, React 19, TypeScript, plain CSS in
   `suite-bar.css` with its own `--sb-*` tokens; no Tailwind, no dependency on either app). Exports `SuiteBar`
   (presentational: the bar, the segmented control, the search field that expands in place, the organization
   menu, the account menu, ⌘1–⌘4 for the tabs and ⌘K for search, the phone rules below 640px) and `SuiteMark`
   (the sheet-on-blue SVG mark, which the sign-in screen also uses). Props carry data and callbacks only: tabs
   (`{ id, label, href, active, badge?, disabled? }`), organization (`{ name, entries: [{ id, name, unread,
   active, avatarUrl?, group? }], onSelect, onAdd, onSettings, onInvite }`), search (`{ placeholder,
   onSubmit(query) }`), assistant (`{ onOpen, active? }`), notifications (`{ onOpen, badge? }`), account
   (`{ name, email, avatarUrl?, presence?: { active, onToggle }, onSetStatus?, onProfile, onSettings, onLogout,
   extra?: [{ label, onSelect }] }`). Tests with vitest + jsdom + Testing Library (the web package shows the
   pattern) for: the active tab, the badge, placeholders not clickable, ⌘2 switching, search expanding and
   collapsing on Esc, both menus opening and their items firing. Add it to `pnpm-workspace.yaml`'s packages (if
   they are globbed it is automatic), the root `tsconfig`/typecheck set, and as `"@flow/suite-bar":
   "workspace:*"` in both clients.

2. **Chat** (`packages/web`): render the bar in `App.tsx`'s `SessionApp` above `Main` / `WorkspaceChooser`
   whenever a user is signed in. Then remove what it replaces:
   - `WorkspaceRail` in `components/Main.tsx` goes. Its entries (`useSwitcherEntries`, every connection's
     organizations with unread counts, `openWorkspace` for another connection's) become the organization
     menu's rows, grouped by server when there is more than one; "Add an organization" selects no workspace
     (the chooser, which carries the invitations badge, so show that count on the row); "Organization settings"
     opens the admin view (`ADMIN_VIEW_ID`) when the user may; "Invite people" opens the invite modal. The
     help "?" moves into the account menu as an `extra` entry "Help".
   - `StatusFooter` (`components/StatusPicker.tsx`) leaves the sidebar: presence and Set a status… are the
     account menu's rows (reuse the picker's options and `PATCH /v1/me`; Set a status… opens the same popover
     or a small dialog), My profile opens `ProfileModal` (`components/modals.tsx`), Settings opens whatever
     Flow calls settings today (`ServerConnections` / the profile modal's settings; pick the closest and say so),
     Log out does what the footer's sign-out did (and clears the cookie: `POST /v1/auth/logout` already does).
   - The Chat tab's badge is the unread total the rail showed for the active organization plus the Activity
     count (`Main.tsx` has both: `workspacesForBadge` and `notificationUnread`); say in the PR what you summed.
   - Docs tab: `location.assign('/workspace')`. Mail and Calendar: disabled placeholders. Search: Chat's
     message search (`lib/chatSearch.ts`; wire the bar's `onSubmit` to it, results where the existing search UI
     shows them). Notifications: select `ACTIVITY_VIEW_ID`. Assistant: `location.assign('/workspace?assistant')`
     (the Docs home opens its assistant panel for that query; see 3).
   - The sidebar's own workspace title (`WorkspaceTitle`) stays; the mobile drawer loses the rail column.
   - **Accent**: in `src/index.css` `@theme`, re-point `--color-accent`, `--color-accent-deep`,
     `--color-accent-soft` and `--color-send` from the violet oklch values to the blue `#1A73E8` and two shades
     (deep `#1558B0`, soft `#4A8FEA` or similar; check contrast on buttons and links), and the sidebar tokens
     `--color-rail`, `--color-side-top`, `--color-side-bot` to the navy of the canvas (`#1E2A4A` and a slightly
     lighter top). `index.html`'s `theme-color` becomes `#1A73E8`. The sign-in screen (`AuthScreen.tsx`) shows
     `SuiteMark` and "FreeFlow". Grep for other hard-coded violets (`#6b30af` and friends) and re-point them.

3. **Docs** (`packages/docs/client`): when `useAuth().suite` is set, render the bar above every signed-in page
   (`main.tsx`: a layout around the routes; the bar is sticky, the page scrolls under it) and remove what it
   replaces: the `.wb-logo` link in every `wb-header` (`pages/*Page.tsx`: the breadcrumbs stay and take the
   left edge), `<Account />` everywhere, the `home-brand` in `FileLibrary`'s `home-header`, and the
   `AgentButton` in page headers (the bar's Assistant calls `useAgent().setOpen`; make sure `AgentProvider`
   wraps the bar, and that on a file page it opens that file's chat as the button did). Standalone (no `suite`)
   and the desktop app keep everything as it is: the removals are conditional on `suite`.
   - Organization and user data come from the suite's API on the same origin with the cookie
     (`fetch` with `credentials: 'same-origin'`): `GET /v1/me` (name, email, avatar), `GET /v1/me/workspaces`
     (organizations with `unreadCount`). The active organization is the one Chat last selected, which it keeps
     in `localStorage` (find the key `ConnectionRuntime.read(ACTIVE_WS)` writes and read the same one; fall
     back to the first). Selecting another in the menu stores it the same way (phase 4 makes files
     organization-aware; nothing else changes now). "Add an organization", "Organization settings" and
     "Invite people" navigate to Chat (`/`) with a query Chat honours (`?open=chooser|admin|invite`; add that
     handling to `App.tsx`).
   - The Chat tab's badge is the sum of `unreadCount`, refreshed every 60 s. Chat tab: `location.assign('/')`.
     Search: the home page's file search (`FileLibrary`'s filter; on a file page, go home with the query).
     Notifications: `/` with `?open=activity`. Account menu: presence and Set a status… call `PATCH /v1/me`
     like Chat (share the status options by exporting them from `@flow/suite-bar`); My profile → `/?open=profile`;
     Settings → the Docs settings page (`/settings` under the base path); Log out → `useAuth().logout()`.
   - `?assistant` on the home page opens the assistant panel once, then is removed from the URL.
   - Styling: `styles.css` keeps its generic class names; the bar's CSS is scoped by its own class prefix so
     nothing leaks either way. Check the editors' `wb-header` still lines up without the logo.

4. **The image and the deploy**: `packages/server/deploy/aws/Dockerfile` must copy `packages/suite-bar` into
   the build stage (its sources are bundled into both clients; nothing of it is needed at run time) and the
   `pnpm install` filters must pull it (a `workspace:*` dependency does). `docker build -f
   packages/server/deploy/aws/Dockerfile .` must succeed. `.github/workflows/flow-aws-deploy.yml` gets
   `packages/suite-bar/**` in its paths.

5. **Verify** as the operator would: `pnpm -r typecheck` (or each package's), `pnpm -r test`, `pnpm -r build`;
   then run the suite locally the way `docs/ops/WORKSPACE_TO_SUITE.md` and this repo's memory describe
   (`BASE_PATH=/workspace/ npx vite build` in `packages/docs`, `pnpm build` in `packages/web`, then in
   `packages/server`: `PORT=8790 WORKSPACE_DATA_DIR=$HOME/flow-bar/.workspace-data npx tsx src/index.ts`,
   against the dev Postgres on 5442; `GOOGLE_CLIENT_ID=` for the tests), sign up through the dev email outbox
   (`packages/server/.emails`), and take screenshots of Chat and of Docs with the bar at 1440px and at 390px
   (Playwright is a dependency of `packages/docs`; `playwright-core` with `channel: 'chrome'` uses the Mac's
   Chrome). Put the screenshots in `/private/tmp/claude-501/-Users-scottp-src-mcp-docs/b5c20c86-b7b8-46e0-8c8d-5488ecdf23a3/scratchpad/suite-bar-shots/` and list their paths in your report; they go in
   the PR description as the evidence. Compare them with the canvas's description above and fix what differs.

## Conventions and constraints

- Work only in the worktree `~/flow-bar` (branch `suite/bar`, from `origin/main`). Do not touch `~/flow`,
  `~/flow-identity`, `~/flow-aws`, `~/flow-bar-spec`. Never commit `.workspace-data/` or `.emails/`.
- Flow's conventions: one new file in `changelog/` (`2026-11-02-suite-bar.md`, the README there has the
  format), the PR body's client-impact checklist (web yes; macOS/iOS/desktop: none; say so), no edits to
  `decision_log.md` (the ruling is in #647). Update `docs/specs/freeflow-suite.md` §2.5 only to note what this
  PR did if something had to differ from it, and `packages/docs/docs/architecture.md` for the Docs side.
- Long lines are fine (the repo uses up to ~230); single quotes; do not run Prettier over whole files.
- Known test quirks: `packages/server/test/multiserver.test.ts › browser contract` fails when `.env` sets
  `GOOGLE_CLIENT_ID` (run with `GOOGLE_CLIENT_ID=`); `packages/agent-bridge` "falls back to killing the
  process group" is flaky under parallel load (rerun the file alone).
- No production, AWS, Railway or DNS changes of any kind. No pushes except to `suite/bar`.
- Open the PR with `gh pr create --repo freeflow-im/flow --base main --head suite/bar` (the remote's URL
  names the old org; `--repo` is required). Base it on main; if #647 has merged by then, merge main in first.
- End with a report: the PR URL, the screenshot paths, every place you departed from this brief and why,
  and anything left for the next PR.
