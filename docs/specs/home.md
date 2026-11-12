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

**Home stays on screen.** A row in the sidebar or a card opens its app beside the sidebar, in Home's main area, not in
place of Home. Each app is loaded in a frame the first time it is opened and kept, hidden, while another view shows, so
going back to it is instant and it is where it was left (hooks/frames.ts). Home's address names what it shows
(`/home/?open=/mail/`), so reload and Back work. Inside Home an app draws no suite bar, and Chat draws no channel list
(Home's sidebar has them); a link in an app to another app opens in Home (`@flow/suite-bar` lib/embed.ts). Chat switches
channel in place when Home asks (a `flow:open` message); the other apps load the address asked for.

### 2.1 The apps' menus in Home's sidebar

Inside Home, an app does not draw its own sidebar. It sends Home its main menu instead, and Home shows it under the
app's row in Home's sidebar, so there is one sidebar, not two. The app owns its menu: Home loads none of the apps' data
for it. The protocol is in `@flow/suite-bar` lib/menu.ts:

| Message | From → to | When |
|---|---|---|
| `{ type: 'flow:menu', v: 1, app, items, selected, href? }` | app → Home | on load, and whenever the items, the selected item or the app's address change |
| `{ type: 'flow:select', v: 1, app, id }` | Home → app | the person clicked an item; the app switches to it in place |

- An item: `id`, `label`, an `icon` named from a fixed set (Home draws it), an optional `count`, `color` and `on` (a
  switch, such as a calendar shown or hidden), the app's own `href` for it, and `children` one level down. An item with
  children and an `href` is a place itself (its label opens it); without an `href` it is only a heading that opens.
- An app calls one hook, `useHomeMenu(app, items, selected, onSelect, href)`. It does nothing outside Home.
- Home keeps each app's last menu in this browser, per organization, so the menu shows at once next time. A click
  before the app's frame has loaded opens the item's `href` instead.
- Home's address follows the `href` an app sends, so reload comes back to the folder or section shown.

What each app sends:

| App | Menu |
|---|---|
| Mail | Compose; the special folders (Inbox, Starred, Drafts, Sent, …) with their counts; "More folders"; with more than one account, the accounts |
| Docs | Recents, Favorites, Shared with me, Organization files and My files (each with its top-level folders) |
| Calendar | Create event, Today, each calendar as a switch in its colour, Shared with me |
| Admin | its sections |
| Chat | none: Home's sidebar already lists the channels and agents |

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
- **Agent status dots**: the row shows the agent's status text or title, not whether it is running. The agent whose
  DM is open is not marked in the sidebar yet (Chat is).
- **Mail, Docs and Calendar switch in place** only for their front page: a conversation, a file or an event opened from
  a card loads that app's frame again (about a second). Chat already switches in place.
- **`/` landing on Home**: `/` still opens Chat. Changing it touches the sign-in redirects.
- **The parts of an app's sidebar not in its menu** inside Home: Mail's Add account and account settings, Docs' folders
  below the top level (the Docs page shows them), Calendar's small month and each calendar's own menu (colour, share).
  They are in the app outside Home.
- **macOS and iOS**: web (and the desktop shell) only; see the Parity section of CHANGELOG.md.
