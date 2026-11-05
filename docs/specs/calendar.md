# FreeFlow Calendar — project plan (2026-11-04)

The suite's fourth tab, beside Docs, Chat and Mail: a person's calendars, read and written against the calendar server they
already use (Google Calendar, iCloud, Fastmail, Nextcloud, any CalDAV server), with invitations flowing through Mail and the
assistant and agents able to look at and change the calendar. Built the way Mail was built (`docs/specs/mail-api.md`,
`packages/mail`, `packages/edge/src/imap/`): one Durable Object per person on the Worker, a Vite client under its own path,
tools defined once for the MCP endpoint and the Docs assistant. No hosted calendars in v1, as Mail has no hosted mailboxes.
This file is the plan and the first draft of the contract; it becomes the spec of record (`calendar-api.md` can split out
when it is long enough), and the rulings below go in `decision_log.md` when Scott confirms them.

## 1. Goals and non-goals

Goals, v1 (the PRs of §7):

- Connect the calendars a person has (the **CalDAV** driver; Google after v1, §8), see them overlaid in day, week, month
  and agenda views, and create, move, edit and delete events, including recurring ones and events with attendees.
- Invitations: an invitation in Mail is a card with Accept / Tentative / Decline that lands on the calendar; cancellations
  remove the event; an event made here with attendees invites them.
- The assistant in Calendar, and Calendar tools for agents on `/mcp`: list, search, find free time, create, change, respond.
- The same speed Mail has now: every read comes from the object's SQLite, kept fresh by the alarm; no round trip to the
  calendar server on the request path except writes.

Non-goals for v1 (the follow-ups of §8): Google Calendar (it needs OAuth, §2.2), hosted calendars, Microsoft 365 / Outlook.com (Graph API), reminders as push
notifications, scheduling links / booking pages, shared organization calendars, room and resource booking, tasks (VTODO),
native and desktop clients.

## 2. Decisions to rule (proposed; each becomes a decision_log entry)

1. **A separate `Calendar` Durable Object per person**, `idFromName(userId)`, not the Mail object. Same shape as Mail (accounts
   with secrets sealed by FLOW_DATA_KEY, rate-limit windows, an alarm with `armAlarm`/`touch`, one timing line per request),
   but its own class and migration (`v5`), so Mail's four IMAP connections, locks and alarm budgets stay as they are, and
   either app can be off without the other. A person's Calendar object and Mail object are both named by the user id, so
   invitations cross between them by binding (`MAIL` from the Calendar object, `CALENDAR` from the Mail object), never by
   session.
2. **v1 is the CalDAV driver only** (ruled 2026-11-04). **Amended the same day: Google comes in PR 1 through the CalDAV
   driver with an OAuth credential** (the cheapest choice below: no second driver), since Google is the calendar there is to
   test with; the REST driver stays a later option (§8). As built: §12. Google's CalDAV exposes only the calendars ticked at
   https://calendar.google.com/calendar/syncselect (Sync settings): a calendar shared into the account (a work calendar) is off
   there by default, and Birthdays is never exposed; the client says so (§12). What follows was the reasoning. Google needs OAuth either way: Google's own CalDAV
   endpoint (`apidata.googleusercontent.com/caldav/v2/`) refuses Basic auth and app passwords, supports ctag and sync-collection
   but has no free/busy lookup and only a stub of scheduling. So the later Google PR is a choice between the CalDAV driver with an
   OAuth credential (cheapest: no second driver) and the REST API (free/busy for find-free-time, `sendUpdates`, conference data,
   push channels). Either way it is the suite's first Google **refresh token**: an auth-code flow on the Worker,
   `GOOGLE_CLIENT_SECRET` finally used, the token sealed in the object, scope `https://www.googleapis.com/auth/calendar` only;
   Google calls that scope sensitive, so until the OAuth app is verified only listed test users can connect.
3. **CalDAV is everything else**: iCloud (app password, `caldav.icloud.com`), Fastmail (app password), Nextcloud, Radicale,
   Baïkal, SOGo, Zimbra, Synology. Discovery by `.well-known/caldav`, `current-user-principal`, `calendar-home-set`; sync by
   `sync-collection` (RFC 6578) where the server supports it, else ctag + `calendar-query` by time range. Plain `fetch` from the
   Worker (no sockets), DAV verbs through `tsdav` and iCalendar through `ical.js` (parsing, recurrence expansion, VTIMEZONE); if
   `tsdav` fights the Worker runtime the DAV subset is small enough to write (PROPFIND, REPORT ×3, PUT If-Match, DELETE).
4. **The cache is complete, not a window.** Calendars are small (a busy person has a few thousand events), so the object holds
   every event of every calendar it syncs, masters and exceptions as stored, and expands occurrences on read for the window
   asked for. Reads never touch the server; the alarm syncs every 60 s while Calendar is open and backs off like Mail's. Writes
   go to the server first (`If-Match` etag / Google `If-Match`), then into the cache, and the client updates optimistically and
   rolls back on failure, as Mail's flags do.
5. **Accounts overlay.** Unlike Mail (accounts kept separate, no unified inbox), every connected account's calendars show
   together, each a checkbox with its colour; "the default calendar" is one per person, chosen in the sidebar, where new events
   go unless the person picks another.
6. **FullCalendar renders the views; everything around them is ours** (ruled 2026-11-04, after a hand-built grid was
   considered: the time grid's overlap layout, all-day spans, drag, resize, snapping, "+N more" and DST days are most of the
   client's work and where the bugs hide). The MIT core with `@fullcalendar/react`, `daygrid`, `timegrid`, `list` and
   `interaction` (no paid resource or timeline views, no rrule plugin: occurrences are expanded on the server, so the same
   rows serve the views, the API and the tools). It sits behind one thin component (`CalendarGrid.tsx`: the range, the
   occurrences in, the clicks and drags out), so the data layer on react-query, the popover, the edit dialog, the sidebar and
   quick create never touch it, and Schedule-X could replace it if its styling fights the suite. Styled through its CSS
   variables to the suite's look. Time zone is the browser's; events keep their own and show converted.
7. **The assistant may create and change events** on the person's own calendars (unlike Mail, where it drafts and never
   sends), because an event is undoable and visible, and a tool that only drafts events would be useless. It never deletes
   without the person confirming (the Docs assistant's confirmation question, `confirmationFor`), and sending invitations to
   attendees is the server's consequence of the event, shown in the tool's label ("Created 'Lunch' Thu 12:00, invited Ann").
8. **Invitations by email (iMIP) only where the server does not schedule.** Google, iCloud and Fastmail send and process
   invitations themselves (and process incoming ones into the calendar before we see the mail). Servers without scheduling
   (Radicale, most self-hosted) get iMIP from the person's Mail account with the same address, in PR 5. Replies from Mail's
   invite card go the server's way when it schedules, by iMIP otherwise.

## 3. The server: the Calendar object (`packages/edge/src/calendar/`)

- `src/routes/calendar.ts` authenticates (Bearer or `sid`, through the Directory, as `routes/mail.ts`) and forwards `/v1/calendar/*`
  to the caller's Calendar object. It answers `GET /v1/calendar/providers?email=` itself (presets: iCloud, Fastmail; Google says "not yet" with a note), and later the Google OAuth start and callback. (As built, 2026-11-04: Google answers `{ google: true, note }`, sign in with Google; the OAuth start and callback are here, §12.)
- `src/calendar/object.ts` — the object. SQLite tables:
  - `accounts` (id, kind `caldav` | `google`, email, display_name, server JSON for CalDAV: url, username; secret sealed:
    password or refresh token; status `ok` | `auth_failed` | `connect_failed`, status_message, created).
  - `calendars` (id, account_id, remote_id or href, name, color, timezone, role `owner` | `writer` | `reader`, hidden,
    is_default, sync_token or ctag, last_synced).
  - `events` (id, calendar_id, uid, remote_id or href, etag, raw: the iCalendar text; indexed columns for
    listing: summary, location, all_day, start_utc, end_utc, recurring, recur_until (null = forever), status, organizer,
    my_response, updated, sequence). Exceptions (RECURRENCE-ID) are rows of their own pointing at the
    master (`master_id`, `recurrence_id`). Index `(calendar_id, start_utc)` and `(calendar_id, recurring, recur_until)`.
    (As built, 2026-11-04: the resource is its own table, `objects (calendar_id, href, uid, etag, raw)`, since one object holds
    a master and its exceptions; `events` has one row per VEVENT with `kind` (0 single, 1 recurring master, 2 single longer than
    14 days), `rid` (an exception's RECURRENCE-ID instant, else 0), `start_utc`, `end_utc`, `recur_until` (a sentinel, the largest
    date, for "forever", so one range condition uses the index), `status`, `search`, and the rest as JSON: `data`, what the API
    shows, and a master's `rules`, enough to expand it without parsing the object. §10 has the indexes.)
  - `sync_runs` (per calendar: when, what changed, the error if any: the e2e and `debug/sync` read it), `rate_limit_windows`.
  - Mail's lesson applies: every list query is written as SQL that `EXPLAIN QUERY PLAN` shows uses the index, with a test on a
    production-sized table (10k events, 1k recurring).
- **Listing a window** (`GET …/events?from&to&calendars=`): plain events by `start_utc < to AND end_utc > from`; recurring masters
  whose `recur_until` is null or ≥ `from`, expanded by `ical.js` (`RecurExpansion`) over `[from, to)` with their exceptions
  applied, EXDATEs dropped (a later Google driver stores its events as iCalendar too, so one expander serves every driver). A window is capped at 3 months per request; the client asks per visible range.
  (As built, 2026-11-04: not `RecurExpansion` but ical.js's rule iterator walked in the series' own wall clock, UNTIL enforced
  in UTC and IANA zones converted by the runtime's Intl, `src/calendar/tz.ts`, so an object whose VTIMEZONEs the server dropped
  still lands right; DAILY and WEEKLY rules without COUNT are walked from near the window, not from a start years ago. §10.)
- **The driver** (`drivers/caldav.ts`; later drivers behind the same interface): `discover`, `listCalendars`, `sync(calendar)` (delta
  where the server has it, else full by ctag), `get`, `put` (create or update with etag), `delete`, `freebusy`, `respond`. A
  refused login sets `auth_failed` (the client shows the reconnect banner Mail has for an expired password).
- **The alarm**: `touch()` on every request from the client; runs every 60 s while touched within 10 minutes, every 10 minutes
  within a day, then stops (same curve as Mail's); each run syncs every calendar whose last sync is older than its interval
  within a 10 s CPU budget, sync-collection servers first (cheap deltas). A write syncs that calendar right after. `POST …/debug/sync` runs it
  now; `GET …/debug/sync` shows `sync_runs`.
- **Rate limits**: 10 account verifications per person per 15 minutes (the Directory's fixed window), as Mail.
- **Only https** CalDAV URLs to public hosts; `CALENDAR_ALLOW_INSECURE=1` (a `--var` to `wrangler dev`, never in `wrangler.toml`)
  allows http and localhost, for Radicale in the e2e.
- Errors as Mail's: `auth_failed` and `connect_failed` are 422, `not_found`, `bad_request`, `conflict` (412 from the server: the
  cache is re-synced and the client is told to look again), `rate_limited`, `server_error`.
  (As built, 2026-11-04: `conflict` is **409**, as `src/errors.ts`'s; a write to a read-only calendar is `bad_request`; a server
  that refuses a change otherwise is `server_error`, 502.)
- Timing: one line per request, `[calendar] <METHOD> <route> <status> <ms>ms (server <ms>)`, logged in `routes/calendar.ts` from
  an `x-calendar-timing` header the object sets (Mail found that lines logged inside an object reach `wrangler tail` late).

## 4. The API (`/v1/calendar/*`, first draft)

```ts
interface CalendarAccount { id: string; kind: 'caldav' | 'google'; email: string; displayName: string; server?: { url: string; username: string };
  status: 'ok' | 'auth_failed' | 'connect_failed'; statusMessage?: string }
interface Calendar { id: string; accountId: string; name: string; color: string; timezone: string | null; role: 'owner' | 'writer' | 'reader'; hidden: boolean; isDefault: boolean }
interface Attendee { name: string | null; email: string; role: 'required' | 'optional'; response: 'accepted' | 'declined' | 'tentative' | 'needs-action'; self?: true }
interface EventOccurrence {                         // what the views show: one per occurrence of a recurring event
  id: string;                                       // `<calendarId>:<uid>` for a plain event, `<calendarId>:<uid>:<recurrenceId>` for an occurrence
  eventId: string; calendarId: string; summary: string; location: string | null; description: string | null;
  start: string; end: string; allDay: boolean; timezone: string | null;   // ISO; all-day ones are dates
  recurring: boolean; recurrenceId?: string; status: 'confirmed' | 'tentative' | 'cancelled';
  organizer: Attendee | null; attendees: Attendee[]; myResponse?: Attendee['response'];
  conference?: { url: string; label: string }; color?: string; etag: string; updated: string;
}
interface EventInput { calendarId?: string; summary: string; location?; description?; start; end; allDay?; timezone?;
  recurrence?: string[];                            // RRULE/EXDATE lines, as iCalendar
  attendees?: { email: string; name?: string; role?: 'required' | 'optional' }[]; reminders?: { minutes: number }[]; conference?: 'auto' }
```

- `GET  /v1/calendar/providers?email=` → preset or `{ google: true }` or null.
- `GET  /v1/calendar/accounts`; `POST /v1/calendar/accounts` `{ email, displayName, password, server? }` (CalDAV: discovers, verifies,
  lists calendars, 201); `PATCH …/accounts/:id` (`displayName`, `password`, `server`; re-verifies on credentials);
  `DELETE …/accounts/:id` (forgets the account, its calendars and events).
- `GET  /v1/calendar/google/start` → `{ url }` (consent page; `state` signed with FLOW_DATA_KEY, carries the user id and a nonce);
  `GET /v1/calendar/google/callback?code&state` → exchanges, creates the account, redirects to `/calendar?connected=<id>`.
- `GET  /v1/calendar/calendars` → `{ calendars: Calendar[] }`; `PATCH …/calendars/:id` `{ hidden?, color?, isDefault? }` (local
  preferences, never written to the server).
  (As built, 2026-11-04: `Calendar` also has `syncedAt: string | null`, null until its first sync; `color: null` goes back to the
  server's colour; `isDefault` takes only `true`. `POST …/accounts` answers `201 { account, calendars }` after a first sync of up to
  8 s, the rest in the background.)
- `GET  /v1/calendar/events?from&to&calendars=a,b&q=` → `{ events: EventOccurrence[] }` (≤ 3 months; `q` filters summary, location,
  description and attendees in SQL; a `q` without a range searches a year each way).
  (As built, 2026-11-04: no `calendars` means the ones not hidden; `limit` ≤ 2000. `EventOccurrence` also carries `reminders`
  (minutes), `recurrence` (the series' RRULE/RDATE/EXDATE lines, for the edit dialog) and `transparent` (not busy time). An all-day
  event's dates are compared as UTC midnights, so a window can include an all-day event of the day next to it.)
- `GET  /v1/calendar/events/:id` → `{ event: EventOccurrence, master?: EventOccurrence, raw: string }`.
- `POST /v1/calendar/events` `EventInput` → `201 { event }`; `PATCH /v1/calendar/events/:id` `Partial<EventInput> & { scope?: 'this' |
  'following' | 'all' }` for recurring ones (`this` writes an exception, `following` splits the series with UNTIL, `all` edits
  the master); `DELETE /v1/calendar/events/:id?scope=` → `{ ok: true }` (`this` adds an EXDATE).
  (As built, 2026-11-04: the scope defaults to `this` for an occurrence's id and `all` for an event's. A PATCH may carry the
  `etag` the client saw (a different one in the cache is `conflict` at once) and a `calendarId` (the whole event moves there: written
  there first, then deleted here). `all` with a new time moves every occurrence by as much as this one moved, and its exceptions'
  RECURRENCE-IDs and EXDATEs with it; `following` with a COUNT gives the new series what is left of it. Start and end are ISO
  instants, dates for all-day, or wall-clock times (`2026-11-05T12:00`) read in `timezone`; a timed event is written with
  `TZID` and a VTIMEZONE made from the zone's rules, all-day as `VALUE=DATE`. `conference: 'auto'` is accepted and does nothing
  on CalDAV.)
- `POST /v1/calendar/events/:id/respond` `{ response: 'accepted' | 'declined' | 'tentative', comment? }` → `{ event }`.
- `POST /v1/calendar/freebusy` `{ emails: string[], from, to }` → `{ busy: { email, intervals: [start, end][] }[], unknown: string[] }`
  (CalDAV `free-busy-query` where the server supports it; the person's own busy time from the cache always).
  (As built, 2026-11-04: `free-busy-query` only ever covers one's own calendars, which the cache already answers; other people
  are asked through the principal's scheduling outbox (RFC 6638 VFREEBUSY) where the server has one, iCloud's for instance, and
  are `unknown` otherwise, as on Radicale. Own busy time: the shown calendars' events that are not transparent, cancelled or
  declined, merged.)
- `POST /v1/calendar/invites` `{ account: <mail account id>, messageId, part: number }` (Mail's invite card, PR 5): parses the
  `text/calendar` part, answers `{ event, action: 'request' | 'cancel' | 'reply', alreadyOnCalendar: boolean }`; `POST …/invites/respond`
  `{ …same, response }` puts the event on the default calendar with the response and sends the REPLY (server or iMIP).
- `GET  …/debug/sync`, `POST …/debug/sync` (local dev and support).

## 5. The client: `packages/calendar` at `/calendar`

Vite + React 19 + Tailwind v4 + FullCalendar, built for `/calendar/`, the same stack, conventions and files as `packages/mail` (`api.ts` with the
typed contract, `hooks/` on react-query, `lib/` pure and tested, `components/ui/` the shadcn primitives, `mock/` a Vite middleware
with sample data for `dev:mock`, `suite.ts`). Reused from Mail by copy where small and by import from `@flow/suite-bar` and Docs'
sources (`lib/docsAgent.ts`) where Mail already does.

- **Layout**: the suite bar (`CalendarSuiteBar.tsx`, the Calendar tab live, ⌘4); a left column with a mini month (click a day,
  drag over a range), the calendars grouped by account with checkboxes and colours, Add account; the main area with a toolbar
  (Today, ‹ ›, the title, Day | Week | Month | Agenda, search); the view; the Assistant panel on the right as in Mail. Under 760px:
  agenda and day only, calendars behind a button.
- **Views**: FullCalendar's `timeGridWeek`, `timeGridDay`, `dayGridMonth` and `listWeek` inside `CalendarGrid.tsx` (§2.6), fed the
  window's occurrences as its events. Its `select` on empty time creates (a quick-create popover: title, time, calendar, "More
  options"); its `eventDrop` and `eventResize` move and resize (a recurring one asks the scope first); `eventClick` opens a
  popover with the details, RSVP buttons, Edit and Delete; Edit is a dialog (title, when with all-day and time zone, repeat with
  the usual presets and a custom RRULE builder, calendar, location, attendees as chips with completion from Mail's
  `GET …/contacts`, description, reminders, conference). Deleting or editing a recurring event asks "this event / this and
  following / all events".
- **Data**: `useEvents(range, calendars)` keyed by the visible range, refetched every 60 s while visible and on focus, prefetching
  the neighbouring ranges; mutations update the range's cache at once and roll back on error; `conflict` refetches and tells the
  person the event changed elsewhere.
- **Keyboard**: t today, d w m a views, ← → or j k, c create, / search, Enter open, e edit, Backspace delete, Esc.
- **Connecting**: "Connect your calendar" when there is none (iCloud and Fastmail with the app-password link, Other CalDAV with a URL field,
  Google greyed with "coming soon"); an account whose token or password stopped working shows Mail's re-enter banner. (As built, 2026-11-04: Google is live, first on the page, with Reconnect instead of re-entering a password; §12.)
- **The address**: `/calendar/week/2026-11-09`, `/calendar/month/2026-11`, `/calendar/day/…`, `/calendar/agenda`, with
  `?event=<id>` for an open one, so links from Mail and the assistant land on the event.
- `src/lib/`: `occurrences.ts` (API rows ↔ FullCalendar events, colours), `recurrence.ts` (the presets ↔ RRULE,
  human text "Every 2 weeks on Tuesday"), `ranges.ts` (view → range, prefetch neighbours), `invites.ts`, `format.ts`.

## 6. Across the suite

- **Suite bar**: the Calendar tab goes live in `ChatSuiteBar.tsx`, `MailSuiteBar.tsx`, Docs' `DocsSuiteBar.tsx` and the new one
  (`href: '/calendar'`, ⌘4); `docs/specs/freeflow-suite.md` §2.5 updated (the placeholder lit).
- **Pages and deploy**: `routes/pages.ts` serves `/calendar` and `/calendar/*` from `_pages/calendar.html` to a signed-in person;
  `scripts/assemble.mjs` files `packages/calendar/dist` under `public/calendar` (optional like Mail, so an older image deploys);
  `deploy-edge.yml` copies it out of the server image; the Dockerfile builds it; `flow-aws-deploy.yml` lists its path; wrangler
  gains the `CALENDAR` binding and migration `v5`; no new secrets in v1.
- **Mail**: the invite card in `ThreadView` for a message with a `text/calendar` part (`lib/invites.ts` reads METHOD, summary,
  when, organizer, attendees from the part through the API's parse); Accept / Tentative / Decline; "Added to your calendar" when it
  already is (the server processed it); a CANCEL card with Remove. "Create event" in a thread's menu opens Calendar's quick create
  with the subject and participants (`/calendar?new=…`). The Mail object sends iMIP for the Calendar object through its SMTP route.
- **Docs**: `CalendarContext` in `shared/agent/protocol.ts` (`page: 'calendar'`: the view and its range, the calendars shown, the
  open or selected event's id, summary, when) rendered by `prompt.ts` like `renderMailContext`; the browser tools
  `open_calendar_event` and `show_calendar_range` (Calendar runs them, the other apps refuse them, as with `open_mail_message`).
- **Tools** (`src/calendar/calendarTools.ts`, `CALENDAR_TOOLS`, registered by `registerCalendarTools` beside the Mail tools; scopes
  `calendar:read`, `calendar:write`, in the OAuth consent and `docs/specs/web-mcp.md`):

| Tool | Scopes | What it does |
| --- | --- | --- |
| `list_calendars` | calendar:read | calendars: id, name, account, role, default |
| `list_events` `{ from, to, calendars?, q?, limit? ≤ 200 }` | calendar:read | occurrences in a window (≤ 3 months): id, summary, start, end, all-day, location, attendees and responses, conference |
| `get_event` `{ id }` | calendar:read | one event in full, with its recurrence as text |
| `find_free_time` `{ duration_minutes, from, to, attendees?, working_hours?, timezone? }` | calendar:read | free slots from the person's calendars and the attendees' free/busy (`freebusy`), longest first, with who is unknown |
| `create_event` `EventInput` | calendar:write | creates, invites attendees (the server's way); the label says what was made |
| `update_event` `{ id, scope?, …Partial<EventInput> }` | calendar:write | changes an event or an occurrence |
| `delete_event` `{ id, scope? }` | calendar:write | asks the person first in the assistant (`confirmationFor`); agents on `/mcp` get it under `calendar:write` with a destructive annotation |
| `respond_to_event` `{ id, response, comment? }` | calendar:write | RSVP |

  Ids are `<calendarId>:<uid>[:<recurrenceId>]`, opaque to agents. The Docs assistant gets all of them (`assistantCalendarSchemas`),
  with a prompt line: it creates and changes events on the person's calendars and says what it did; it checks free time before
  proposing one; it does not delete without asking. Tool labels in Docs' `describe.ts` and Calendar's copy.

## 7. The PRs (each with its `changelog/` entry; batched so a PR is something a person can use, as ruled 2026-11-04)

1. **Calendar, reading and writing** (server + web, branch `calendar/app`). The whole of §3, §4 (less `invites`) and §5:
   `src/calendar/` with the object, the CalDAV driver (discovery, sync-collection and the ctag fallback), the events table and the
   window listing with recurrence expansion, the alarm, the account routes, `GET`/`POST`/`PATCH`/`DELETE` events with etags and
   the recurring scopes, `respond`, `freebusy`; wrangler binding and migration, `CALENDAR_ALLOW_INSECURE`; `packages/calendar` with
   the views on FullCalendar, the sidebar, connecting a CalDAV account (iCloud and Fastmail presets, Other with a URL), quick create, the edit
   dialog, drag to move and resize, delete with the recurring question, optimistic updates and `conflict`; the Calendar tab live in
   all four suite bars; the mock, pages and deploy wiring. Tests: iCalendar fixtures (all-day, time zones, DST, RRULE with EXDATE
   and exceptions), the DAV XML, the sync against a fake server, the query-plan test, the client's `lib/` tests, and
   `test/e2e-calendar.mjs` against Radicale in Docker (`flow-radicale`, 127.0.0.1:5232, any password, the GreenMail of calendars;
   its header says how to run it) covering connect, list, create, move, split a series, delete. Verify by hand: an iCloud account
   both ways against Apple Calendar within a minute, Fastmail, Radicale through the Worker locally, a phone-width look.
   Built in two steps on the one branch so it can be looked at early: the server with its e2e first, then the client.
2. **Invitations, the assistant and the tools** (server + web + Docs, branch `calendar/invites-tools`). The invite card in
   Mail's `ThreadView`, `invites` and `invites/respond`, CANCEL, "Create event" from a thread, iMIP REQUEST / REPLY / CANCEL
   through the Mail account for CalDAV servers that do not schedule, the Mail ↔ Calendar bindings; `calendarTools.ts` registered
   on `/mcp` with the scopes and the consent page, the Docs assistant's schemas and prompt line, `CalendarContext`, the browser
   tools, Calendar's Assistant panel, tool labels, `web-mcp.md` updated. Tests as Mail's (`calendarTools.test.ts`,
   `calendarMcp.test.ts`, `assistantCalendar.test.ts`, `test/e2e-calendar-mcp.mjs`; the e2e sends an invitation into GreenMail
   and accepts it onto Radicale). Verify: an invitation from a Google user (in Google's own UI) to an iCloud account and back;
   "find me 30 minutes with Ann next week and book it" from Claude Code over `/mcp`.
3. **Polish before calling it v1** (small; folds into 2 if it stays small): search, the event popover's "Join" for conferences,
   printing a week, week start and working hours in Settings, Undo on delete and move, the QA pass on the four apps' bars and the
   phone layout, `FEATURES.md` sections.

PR 1 is large by design: there are no users, Mail's stacked PRs cost more than they saved, and a calendar that reads but cannot
write is not worth a deploy. Its risk is the driver and recurrence, which is why the server half lands on the branch first with
its e2e green.

## 8. After v1

- **Google Calendar** (2026-11-04: done in PR 1 through the CalDAV driver with an OAuth credential, §12). Still after v1: a Google
  REST driver, if CalDAV's limits matter (free/busy of other people, `sendUpdates: all`, conference data, push channels, `syncToken`
  deltas with the 410 full resync); revoking the grant when the account is removed; OAuth verification of the app (below). Until
  then `find_free_time` uses the person's own calendars, and Google accounts' other people are `unknown`.
- **Reminders** as push notifications (the Worker already pushes to APNs; web push where the suite has it): the alarm looks ahead 15 minutes for
  VALARMs and the person's default reminder.
- **Google push** (`events.watch` channels to a Worker URL) and **CalDAV polling tuned per server**, so changes show in seconds.
- **Microsoft 365 / Outlook.com** by the Graph API (Microsoft has no CalDAV); a third driver behind the same interface.
- **Google OAuth verification** when there are users outside the test list; the privacy policy page it needs.
- **Scheduling links** (a page where others book time), **organization calendars** (an organization's shared events in its Org
  object), **tasks** (VTODO, Google Tasks), natural-language quick add ("lunch with Ann Thursday noon" through the assistant),
  the native and desktop clients (§7 of the suite spec).

## 9. Conventions and constraints

- Work in `~/flow` (PR 1 was built in a worktree on one branch, `calendar/app`); branch per PR, stacked only when one truly needs the one below, and
  never `--delete-branch` on the bottom of a stack (Mail's lesson). The classifier blocks force-pushes and remote branch
  deletion: rebase onto `-2` names and let Scott delete.
- Each PR: a `changelog/` file with a `## Feature` section when a person can see it, the client-impact checklist in the
  description, `pnpm --filter @flow/calendar typecheck|test`, `pnpm --filter @flow/edge test`, and the e2e when the server changed.
- Specs: this file is updated with what was built (dated, as `mail-api.md` does); rulings to `decision_log.md`.
- Secrets never leave the object: passwords, refresh tokens and access tokens are not returned, logged or put in timing lines;
  no address, summary or id in a log line.
- Every list and sync query gets an `EXPLAIN QUERY PLAN` test on a production-sized table before it merges (the 2026-11-04 outage).
- Local dev: Radicale (`docker run -d --name flow-radicale -p 5232:5232 tomsquest/docker-radicale` with auth off), `wrangler dev` with
  `--var CALENDAR_ALLOW_INSECURE:1` as the e2e's header says, `pnpm --filter @flow/calendar dev` proxying `/v1` to it.

## 10. As built: the server (PR 1, 2026-11-04)

- **Files** (`packages/edge/src/calendar/`): `object.ts` (the `Calendar` object: Hono routes, accounts, sync, the alarm, writes),
  `store.ts` (the SQLite: tables, window and sync queries, occurrences), `ical.ts` (iCalendar in and out, recurrence, the edits),
  `tz.ts` (zones through Intl, VTIMEZONEs written), `rules.ts` (presets, URL checks, bodies, ids, the timing line, the alarm's
  cadence), `drivers/caldav.ts` (the driver); `src/routes/calendar.ts` (auth and forwarding). Tests beside each, and
  `test/e2e-calendar.mjs`; fixtures in `test/fixtures/calendar/`.
- **tsdav** (2.5) does the DAV verbs and their XML (discovery, `fetchCalendars`, `syncCollection`, `calendarMultiGet`,
  `calendarQuery`), and ical.js (2.2) the iCalendar; both run in workerd (spiked under `wrangler dev` first). Every request goes
  through the driver's own `fetch` (`CalDav.request`): it adds Basic auth, follows redirects itself so each target is checked
  as the typed URL is (https, public host, standard port), times out after 20 s, adds its time to the request's `server=`
  timing, and makes a 401 `auth_failed`. PUT and DELETE are plain fetches (If-None-Match `*` to create, If-Match to replace;
  412 is `conflict`). workerd's `fetch` refuses the `MKCALENDAR` method, so creating calendars is not something the Worker can
  do; v1 does not need it (the e2e makes Radicale's straight from Node).
- **Indexes** (each list and sync query names its own with `INDEXED BY`, so statistics can never turn it into a scan; the
  query-plan test in `store.test.ts` runs the very strings on 10 000 events, 1 000 recurring, after `ANALYZE`):
  `events_window (calendar_id, kind, start_utc)` for single events (`kind = 0 AND start_utc >= from − 14 days AND start_utc <
  to AND end_utc > from`, and `kind = 2` by `start_utc < to`); `events_series (calendar_id, kind, recur_until)` for the series
  still going (`kind = 1 AND recur_until > from AND start_utc < to`); `events_rid (calendar_id, rid) WHERE rid > 0` for the
  exceptions that replace a window's occurrences; `events_uid`, `events_href`, `objects_uid` and the covering `objects_etag
  (calendar_id, href, etag)` for writes and sync. A week of that table, every series expanded, lists in well under a second.
- **Sync** (`syncCalendar`, one at a time per calendar, writes too): with a stored sync token, `sync-collection` (changed hrefs
  whose etag differs from ours are fetched by `calendar-multiget` in batches of 50; 404s dropped); without one, or when the
  server forgot it (403/409 valid-sync-token), the token and ctag first, then (unless the ctag is unchanged on a server
  without sync-collection) every VEVENT's etag by `calendar-query` against `objects`. The calendars of each account are listed
  again every 15 minutes (one added or removed elsewhere; 2026-11-04, was 10), and at once by `POST …/accounts/:id/refresh` →
  `{ calendars, added, removed }`, the new ones synced as far as 8 s go (the account dialog's Refresh calendars). `sync_runs` keeps the last 200 runs (`GET …/debug/sync`).
- **The alarm**: every 60 s while the person made a request in the last 10 minutes, every 10 minutes within a day, then none
  until the next request (`rules.ts` `nextAlarmAt`); a run takes the calendars due, sync-collection first, within 10 s. A
  write syncs its calendar in the background right after. `CALENDAR_ALARM = "off"` is the kill switch, as `MAIL_ALARM`.
- **Accounts**: `server` JSON holds the URL and username as typed and what discovery found (principal, calendar home,
  `calendar-user-address-set`, the scheduling outbox); the password is sealed (`secret`, `key_id`). The account's addresses
  make an attendee `self` and pick the ORGANIZER of an event made here. Roles: `owner` when the privilege set allows writing,
  else `reader`; since 2026-11-04 a writable calendar whose `DAV:owner` is another principal is `writer` (the client edits
  it as its own; the default calendar prefers an `owner` one).
- **Timing**: `[calendar] GET /v1/calendar/events 200 4ms (server 0ms)`, ids replaced (`/events/:id`, `/accounts/:id`,
  `/calendars/:id`); the alarm logs `[calendar] sync: <n> calendars <ms>ms`. The header is dropped unless
  `CALENDAR_ALLOW_INSECURE=1`, where the e2e reads it.
- **The e2e** (`test/e2e-calendar.mjs`, its header says how to run it): presets, connecting (connect_failed, a missing URL,
  discovery), calendars with Radicale's names and colours, a window with a weekly New York series across the end of daylight
  time, its EXDATE and moved exception, an all-day event, search, the 3-month cap, an occurrence by id, RSVP, create (in its
  zone, with an attendee), move, the conflict both ways (an old etag; a change made in Radicale meanwhile, then the server's
  copy shown), a move to another calendar, a series' this / following / EXDATE / delete, hidden, colour and default
  calendars, free/busy, the alarm picking up an event put straight into Radicale (by a delta, about a minute), a deletion
  there, the timing lines (and no address, summary or id in them), and forgetting the account.

## 11. As built: the client and the suite (PR 1, 2026-11-04)

- **`packages/calendar`** (`@flow/calendar`, base `/calendar/`; `README.md` there has the files) on **FullCalendar 6.1**
  (`@fullcalendar/react`, `core`, `daygrid`, `timegrid`, `list`, `interaction`). FullCalendar 7 (June 2026) folds the plugins
  into a headless core on the Temporal polyfill and no longer publishes them as the packages §2.6 names; 6.1 is the line the
  plan describes and its React adapter is stable, so 7 is a later, separate move behind `CalendarGrid.tsx`.
- **Data**: `useEvents` asks for every calendar's occurrences of the visible range (hidden ones too, so a checkbox needs no
  round trip; `hidden` is still stored by `PATCH …/calendars/:id`, so agents and other devices see the same choice) and reads
  the ranges either side ahead; polled every 60 s, every 2 s while a calendar has `syncedAt: null`. A drag, a resize, an edit,
  a delete and an RSVP change every cached range at once (a series' other occurrences move with `all` and `following`) and roll
  back on failure; `conflict` says "This event changed elsewhere" and refetches. A drag sends the occurrence's `etag`.
- **The edit dialog** shows times in the event's own zone (else the browser's), with the zone a list of the browser's IANA
  zones; it sends wall-clock times and the zone (`2026-11-05T12:00` + `America/New_York`), and only the fields that changed.
  Repeat: Google's presets for the start (daily, weekly on its day, weekdays, monthly on its date or its nth weekday, yearly)
  and a custom rule (every N days, weeks on chosen days, months, years; never, after N times, until a date); changing the rule
  keeps the series' EXDATEs, and then asks only "following" or "all". Guests complete from Mail's contacts
  (`GET /v1/mail/accounts/:id/contacts`, the first three Mail accounts), as chips. Reminders are chips over a list of choices.
  A move to another calendar takes the whole series.
- **Quick create** opens by a click or drag on empty time (a click on a half-hour slot makes an hour); "More options" carries
  what was typed into the dialog. **The popover**: when, the zone if not the browser's, the repeat in words, Join for a video
  call (`conference`), location (a link when it is one), guests and their answers, description, calendar; Yes / Maybe / No for
  an invitation (the series' answer); Edit and Delete unless the calendar is read-only.
- **The sidebar's small month**: a click goes to that day in the open view; a drag over days goes to the week holding them
  (more than seven days: their month), rather than a custom range of N days.
- **Search** is the suite bar's: results a year either side of today, by day, replace the view until closed.
- **Not in PR 1** (PR 2 and 3, as §7 has them): the Assistant panel and button (the suite bar on Calendar has no Assistant
  yet), the invite card in Mail and `?new=` from a thread, the Calendar tools; week start and working hours (Sunday, 7:30
  scrolled to); Undo on delete and move; printing.
- **Suite**: the Calendar tab is live in Chat's, Mail's, Docs' and Calendar's bars (`href: '/calendar'`, ⌘4; in Chat it is
  disabled with a tooltip for an organization on another server, as Mail's tab is). `routes/pages.ts` serves `/calendar` and
  `/calendar/*` from `_pages/calendar.html` to a signed-in person (a file path falls through to the built files);
  `scripts/assemble.mjs` files `packages/calendar/dist` under `public/calendar`, optionally; `deploy-edge.yml` copies it out of
  the server image, whose Dockerfile builds it; `flow-aws-deploy.yml` lists `packages/calendar/**`. Vite's hashed files under
  `/calendar/assets/` are cached for a year, as Mail's.

## 12. As built: Google Calendar through CalDAV with OAuth (PR 1, 2026-11-04)

- **The endpoint**: Google's CalDAV v2, `https://apidata.googleusercontent.com/caldav/v2/`; a person's principal is
  `…/caldav/v2/<email>/user`, and the calendar home is discovered from it (`current-user-principal`, `calendar-home-set`;
  no `.well-known`). It has ctag and sync-collection, no free/busy and a stub scheduling inbox, so a Google account has no
  outbox (other people are `unknown` in `freebusy`). Subscribed calendars (holidays, birthdays, others' shared ones) come with
  read-only privileges and are `reader`, as on any server.
- **The credential** (`drivers/caldav.ts` `Credential`): `basic` (a password) or `bearer` (an access token from the object). A
  401 with a bearer token refreshes it and tries the request once more; a second 401, or a refresh Google refuses
  (`invalid_grant`: revoked, expired, the password changed), is `auth_failed`, and the account's status says so.
- **The account**: `kind: 'google'`, `email` from the id_token, `secret` the refresh token sealed with FLOW_DATA_KEY (as a
  password is); access tokens live in the object's memory for their hour, never stored, returned or logged. Connecting the same
  Google address again replaces the refresh token (a reconnect). `PATCH` with a password or server is `bad_request` for one.
- **The flow** (`src/calendar/google.ts`, `routes/calendar.ts`):
  - `GET /v1/calendar/google/start?return=<url>&email=` (session) → `{ url }`: Google's consent page with
    `scope=openid email https://www.googleapis.com/auth/calendar`, `access_type=offline`, `prompt=consent` (a refresh token every
    time), `login_hint`, and `state`: `{ userId, nonce, returnTo, exp }` sealed with FLOW_DATA_KEY (AES-GCM: unreadable and
    tamper-proof), good for 10 minutes. `return` is kept only if it is the suite's origin (WEB_URL_BASE), the Worker's, or, with
    CALENDAR_ALLOW_INSECURE=1, a localhost dev server; else `<WEB_URL_BASE>/calendar/`.
  - `GET /v1/calendar/google/callback?code&state` (no session: the state names the person) exchanges the code with
    GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, reads the address from the id_token (`oauth.ts` `googleProfile`), and has the
    person's object make the account (`Calendar.connectGoogle`: discovery, the calendars, the first sync), then redirects to
    `<return>?connected=<id>`. Refusals redirect with `?error=`: `access_denied` (Google's), `expired` (a state changed, from
    another key, or past 10 minutes; to `<WEB_URL_BASE>/calendar/`, since the return is not known), `scope_denied` (the person
    unticked the calendar box), `no_refresh_token`, `google_disabled` (no client secret), or the account's error code. The state
    is not one-time: a replay needs a fresh code, which Google gives once.
  - The redirect URI is `<Worker origin>/v1/calendar/google/callback`; `GOOGLE_REDIRECT_URL` overrides it (local dev, where the
    Worker is `http://localhost:18799` and the client the Vite server on 5186: the return is `http://localhost:5186/calendar/`).
- **The client**: Google Calendar is first on the Connect page and a tab in Add account ("Sign in with Google" leaves for the
  consent page); `?connected=` and `?error=` are said in a toast and taken off the address; a Google account's settings have
  Reconnect instead of a password, and its banner says "Google stopped giving FreeFlow access" with Reconnect. `dev:mock`
  skips the consent (Start connects a Google account at once; `denied@gmail.com` comes back with `?error=access_denied`).
- **Secrets**: GOOGLE_CLIENT_SECRET on the Worker (`scripts/put-secrets.sh`, from `/flow/GOOGLE_CLIENT_SECRET`, optional until
  it is there); GOOGLE_CLIENT_ID is the sign-in's, already set. Locally both, and GOOGLE_REDIRECT_URL, go in
  `packages/edge/.dev.vars`.
- **Tests**: `google.test.ts` (the state's round trip, expiry and tampering; the consent URL; the return URL rule; the token
  endpoint, faked; the callback's every outcome, its dependencies faked) and `caldav.test.ts` (the bearer credential: the refresh
  on a 401, once; a refused refresh; no `.well-known`). The e2e cannot cover Google (no Google in Docker); it is verified by hand.
- **The Google Cloud console** (the project of GOOGLE_CLIENT_ID; Scott):
  1. APIs & Services → Library: enable **CalDAV API** (`caldav.googleapis.com`). Without it the endpoint answers 403.
  2. Credentials → the OAuth 2.0 client (Web application) → Authorized redirect URIs: add
     `https://app.freeflow.im/v1/calendar/google/callback` (production) and `http://localhost:18799/v1/calendar/google/callback`
     (local); and `https://edge.freeflow.im/v1/calendar/google/callback` if the rehearsal host is used.
  3. OAuth consent screen (Google Auth Platform → Data access): add the scope `https://www.googleapis.com/auth/calendar`; while
     the app's publishing status is **Testing**, add each person who will connect (scottp@biztrip.ai and the Google address of
     the calendar) under **Audience → Test users**. The scope is sensitive: anyone else gets "access blocked" until the app is
     verified (§8). In Testing, Google also expires refresh tokens after 7 days, so a test account needs Reconnect weekly.
- **Found on a real account (2026-11-04)**:
  - *One missing event failed a whole calendar.* On a calendar shared by another person (`…/caldav/v2/andrea…%40gmail.com/events/`),
    Google's calendar-query listed ~3200 events with etags, but its calendar-multiget answered 404 for one of them. tsdav's
    `calendarQuery` and `calendarMultiGet` throw when any single entry is not 200 ("Collection query failed: 404 Not Found"), so
    the full sync failed with nothing stored. The href was not at fault (`%40` and the trailing slash go back exactly as Google
    gave them), nor sync-collection or the query itself. The driver now sends both REPORTs through tsdav's `davRequest` and
    reads the multistatus entry by entry (`CalDav.report`): only the request failing as a whole is an error; an object that is
    not there is left out, and asked for again at the next full sync.
  - *Roles on Google.* Every Google calendar names itself as its owner (`…/<calendar-id>/user`), whether the person made it or
    another person shared it, so only the primary calendar (the account's own principal) is `owner`; every other writable one is
    `writer`, and subscribed ones (holidays, a read-only shared calendar) `reader`.
  - *Which calendars.* Only those ticked in Google's Sync settings; the Connect page's Google row and a Google account's dialog
    say so with the link, and Refresh calendars picks up one ticked since.
  - *Invitations on a shared calendar* (the work calendar `scottp@biztrip.ai` shared into a Gmail account). Its events invite
    `scottp@biztrip.ai`, not the account's address, so no attendee was `self` and nothing drew outlined. "Me" on a calendar is
    now the account's addresses plus the calendar's owner (`calendars.owner_address`, `RemoteCalendar.ownerAddress`: on Google
    the id in the href, `/caldav/v2/<id>/events/`; elsewhere, for a calendar owned by another principal, that principal's
    `calendar-user-address-set`, asked once per owner at list time, null on failure), as Google's own UI has it. It is used when
    events are parsed (sync and writes), when an RSVP is written (that attendee's PARTSTAT), and in free/busy. `reparse` marks a
    calendar whose stored objects are read again from `objects` before its next sync (no round trip): set for every calendar
    when the column was added (with the accounts' lists read again at the next alarm run), and whenever the owner address
    changes (`CalendarStore.applyCalendars`).
