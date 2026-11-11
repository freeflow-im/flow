# FreeFlow Home

Status: first version built 2026-11-11 (web). Design reference: the operator's "Home page" mockup (Harbor & Pine).

## 1. What it is

One page that brings the suite together, at `/home`:

- **A sidebar**: the apps (Home, Mail, Calendar, Docs, Chat, and Admin for owners and admins), the person's channels,
  and the organization's agents. Every row opens that app's own page: a channel opens in Chat, an agent opens the
  person's DM with it (made on the first click, `POST /v1/workspaces/:id/dms`).
- **Cards**: Today (Calendar), Inbox (Mail), Recent files (Docs) and Mentions (Chat). Each row opens where its app shows it.
- **A greeting** with the date and what is waiting: meetings today, unread mail, unread mentions.

It is also the start of the setup flow. A card with nothing to show says what to do next: "Open Calendar", "Set up
Mail", "Create a doc", "Invite your team" (when the person is the only human member), "+ Add" an agent (owners and
admins). A new account's mailbox and calendars are made after it joins; the cards say so until they are ready.

## 2. How it is built

- `packages/home`, a Vite client on the Admin pattern (`packages/admin`): no Durable Object and no routes of its own.
  It reads the other apps' APIs on the same origin with the session cookie: `/v1/mail/*`, `/v1/calendar/events`,
  `/api/recents`, `/v1/workspaces/:id/channels|members`, `/v1/me/notifications`, `/v1/me/accounts`.
- Its manifest (`@flow/shared` `APP_MANIFESTS`) adds the page, the client and a tab. The tab is first with shortcut `0`,
  which no ⌘ key opens, so ⌘1–⌘4 stay Docs, Chat, Mail and Calendar: the suite bar now maps a ⌘ digit to the tab whose
  manifest shortcut it is, not to the tab's place.
- Each card is its own query, read again every minute and on window focus; a slow app holds up only its own card.
- Home writes the organization it shows to Chat's selection (`flow.<session>.activeWorkspace`), because Chat follows an
  `open=channel:` link only in the organization it has selected.
- A guest uses Chat only (workspace-admin.md §6.5): Home sends a guest to `/chat/`.

## 3. Not in the first version

- **Approvals** ("Waiting for your approval"): agents asking before they send mail or share files. A feature of its own.
- **The assistant panel** on the right of the mockup.
- **Favorite channels**: there is no star for channels yet, so the sidebar lists the channels the person is in, the
  ones that need them first, eight at most.
- **Agent status dots**: the row shows the agent's status text or title, not whether it is running.
- **`/` landing on Home**: `/` still opens Chat. Changing it touches the sign-in redirects.
- **macOS and iOS**: web (and the desktop shell) only; see the Parity section of CHANGELOG.md.
