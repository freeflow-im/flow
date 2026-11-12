# Calendar — Guest scheduler (2026-11-12)

A public booking page for a person's calendar. The owner shares a secret URL. A guest opens it without signing in, picks
a meeting length, a day and a time, gives a name and an email, and the meeting lands on the owner's calendar with the
guest invited. `calendar.md` §1 and §8 list this as "scheduling links", after v1. This spec is the plan; the rulings of §9 are in
`decision_log.md`.

The reference is a Calendly page: owner name and meeting title on the left, a month grid on the right where days with
open time are highlighted, a time zone picker under the grid.

## 1. What a person can do

**The owner** (signed in, in the Calendar app):

- Turn on a booking page. It starts with the defaults: Monday to Friday, 9:00 to 17:00 in the owner's time zone, 30 minute
  meetings.
- Change the title ("30 Minute Meet"), a short description, and the meeting lengths offered: one or more of 15, 30, 45, 60, 90
  minutes. With one length the guest does not choose; with more the guest picks one first.
- Edit the weekly hours: per weekday, zero or more time ranges (for example Tue 9:00–12:00 and 13:00–17:00).
- Set the limits: minimum notice (default 4 hours), how far ahead a guest can book (default 60 days), a buffer before and
  after each meeting (default 0), and a maximum number of bookings per day (default none).
- Choose which calendars count as busy (default: all calendars shown in the sidebar) and which calendar gets the new
  meetings (default: the default calendar).
- Choose the location: a fixed text (an address, or a video call URL the owner pastes), or nothing.
- Copy the link, turn the page off, or make a new link (the old link stops working).

**The guest** (not signed in, any browser, phone or desktop):

- Open the link and see the owner's name, the meeting title, the length (or the length choices) and the location note.
- See a month calendar. Days with at least one open slot are highlighted and clickable. Other days are plain. Move to the
  previous and next month, within the booking window.
- See and change the time zone. It starts at the browser's time zone. All times show in the chosen zone.
- Click a day to see the open start times for that day. Click a time, then enter name, email and an optional note, and confirm.
- See a confirmation screen, and get an email invitation from the owner's calendar with the meeting in it.
- Cancel or reschedule from the links in the confirmation screen and the confirmation email. Rescheduling shows the same
  month grid and moves the existing meeting; it does not make a second one.

**After a booking**: the meeting is an ordinary event on the owner's calendar, with the guest as an attendee. Every client
(web, macOS, iOS, desktop) shows it like any other event. The owner gets a notification.

## 2. Decisions to rule

1. **The config and the bookings live in the owner's Calendar object** (`packages/edge/src/calendar/object.ts`), not in a new
   object. The object already holds every event of every synced calendar (`calendar.md` §2.4), so free time is computed there
   with no call to a calendar server, and the object runs one request at a time, so two guests cannot book the same slot.
2. **One booking page per person in v1** (ruled 2026-11-12), with several meeting lengths on it. Several pages per person (Calendly's "event
   types") is a later step; the table below already allows it.
3. **The URL is `/calendar/book/<token>`, with a token that is easy to read** (ruled 2026-11-12: the secret token is
   enough, no handle URL). The token is 12 random characters from Crockford's base32 in lower case (no `i`, `l`, `o`, `u`),
   written in three groups: `/calendar/book/k7mq-x3vd-p9tr`. That is 60 bits, which is far more than anyone can guess
   through the rate limits of §5. The Worker accepts it in any case, with or without the dashes. It names no account and
   no name. A small index in the Directory maps the token's SHA-256 to the owner's account id, so the Worker finds the right
   object. Making a new link deletes the old index row. Query parameters mirror the reference: `?month=2026-11&duration=30`.
   The guest's own link to manage a booking is only in an email and is never typed, so it stays 22 base62 characters.
4. **The guest page is its own small entry in `packages/calendar`** (`book.html`, `src/book/`), not the signed-in app. It
   loads no session, no react-query cache of the person's data, no suite bar. The manifest page has `signIn: false` and the
   `PUBLIC` headers (`no-referrer`, `noindex`) that public links already use (`packages/shared/src/manifests.ts`).
5. **The guest's email is not verified in v1.** The invitation goes to that address, so a wrong address only hurts the guest.
   The risk is spam bookings; §5 limits them. Email verification (a code sent before confirming) is a later option, per page.
6. **Bookings on a connected calendar (Google, iCloud, CalDAV) are allowed.** The event is written with the guest as an
   attendee, and the server sends the invitation, as any event made in Calendar does (`calendar.md` §2.8). On a native
   calendar, the guest is outside the platform, so iMIP goes from the owner's mailbox (`invites.ts` `notify`, §16). An owner
   with no mailbox and a native calendar gets a confirmation email sent by the platform's own sender instead.

## 3. The server

### 3.1 Tables (in the Calendar object, new migration)

- `scheduler_pages` (id, token_hash, enabled, title, description, durations JSON `[30,45,60]`, default_duration, timezone,
  weekly JSON `{ "mon": [[540,1020]], ... }` in minutes of the day, min_notice_min, horizon_days, buffer_before_min,
  buffer_after_min, max_per_day, increment_min (default: the shortest duration, at most 30), busy_calendar_ids JSON (null = all
  visible), target_calendar_id (null = default), location JSON `{ kind: 'text' | 'none', value }`, created, updated).
- `scheduler_bookings` (id, page_id, event_id, start_utc, end_utc, duration, guest_name, guest_email, note, guest_tz,
  manage_token_hash, status `booked` | `cancelled`, reschedules, created, updated, ip_hash). Index `(page_id, start_utc)`.
- `scheduler_sync` (page_id, last_open_sync): when a guest's visit last started a sync, for the limit in §3.4.

### 3.2 Owner API (signed in, `/v1/calendar/scheduler`)

- `GET` → the page (made with the defaults on first call, `enabled: false`), with `url` when enabled.
- `PATCH` → change any field. Validates: durations from the allowed set and not empty; ranges inside a day and not overlapping;
  calendars are the person's and the target is writable.
- `POST …/rotate` → new token, old one stops working.
- `GET …/bookings?from&to` → the bookings, for a list in the settings.

### 3.3 Public API (no session, `/v1/book/:token`)

`routes/book.ts` hashes the token, looks up the owner in the Directory, and forwards to the owner's object. An unknown or
disabled token is 404 with the same body, so a guess learns nothing.

- `GET /v1/book/:token` → `{ ownerName, title, description, durations, defaultDuration, location: { kind, label }, ownerTimezone,
  horizonEnd }`. No email, no account id, no calendar names.
- `GET /v1/book/:token/days?month=2026-11&duration=30&tz=America/Los_Angeles` → `{ days: ['2026-11-13', '2026-11-16', ...] }`: the
  dates (in the guest's zone) with at least one open slot.
- `GET /v1/book/:token/slots?date=2026-11-16&duration=30&tz=…` → `{ slots: ['2026-11-16T17:00:00Z', ...] }`.
- `POST /v1/book/:token` `{ start, duration, name, email, note, tz }` → checks the slot again inside the object, writes the
  event, records the booking, returns `{ bookingId, start, end, location }`. A slot taken in the meantime is 409 `slot_taken`
  with fresh slots for that day.
- `GET /v1/book/:token/b/:manageToken` → the booking (time, length, status) for the manage page.
- `POST /v1/book/:token/b/:manageToken/cancel` → cancels the booking and the event, which sends the CANCEL by the same path
  as the invitation.
- `GET …/b/:manageToken/days` and `…/slots` → as above, but the booking's own time counts as free.
- `POST /v1/book/:token/b/:manageToken/reschedule` `{ start, duration }` → moves the same event (same UID, SEQUENCE + 1),
  so the guest's calendar updates the meeting instead of adding a second one. Same checks and 409 `slot_taken` as a new
  booking. At most 5 reschedules per booking; after that the guest must cancel and book again.

### 3.4 Computing open slots

For a window (a month for `days`, a day for `slots`):

1. Expand the weekly ranges day by day in the page's time zone into UTC intervals (`tz.ts`, so DST days are right).
2. Cut away: before now + minimum notice, after today + horizon.
3. Subtract busy time: `busyIn(busyCalendars, from, to)` (already in `object.ts`), each busy interval widened by the buffers.
4. Step through what is left at `increment_min` from each range start; keep a start if `[start, start + duration]` fits.
5. Drop days that already have `max_per_day` bookings from this page.
6. Group by date in the guest's zone (`days`) or list the starts (`slots`).

This is pure code on the cached rows, in a new `scheduler.ts` with unit tests. The list query is the existing indexed window
query, so no new query plan.

**Freshness.** A connected calendar is only as fresh as its last sync, and the alarm stops after a day without the owner
opening Calendar (`calendar.md` §3). So the cached busy time can be days old when a guest arrives. Native calendars are
always current and need none of what follows.

- **When a guest opens the page** (`GET /v1/book/:token`), the object syncs each busy calendar whose last sync is older than
  5 minutes. A visit starts this at most once per minute per page, however many people open it (`scheduler_sync`), so a bot or
  a reloading guest cannot use up the owner's Google or CalDAV quota.
- The first `days` answer waits up to 2 seconds for that sync. If the sync takes longer, it answers from the cache with
  `syncing: true`; the page asks for the days again once, 3 seconds later.
- **When a guest books or reschedules**, the object first syncs each busy calendar whose last sync is older than 2 minutes,
  then checks the slot again. This is the check that matters: a slot taken by a very recent change is 409 `slot_taken`.
- A guest visit does not call `touch()`, so it does not start the owner's 60-second alarm cycle. The two checks above are
  enough.

### 3.5 The event written

Summary `"<title>: <guest name>"` (for example "30 Minute Meet: Ann Lee"), the owner as ORGANIZER, the guest as ATTENDEE
(`needs-action`), the guest's note in the description, the location text if any, and `X-FLOW-BOOKING=<bookingId>` so the
owner's clients can mark it. The event goes through the normal write path (`putAndStore`), so native events publish
`calendar.event.added` and connected ones go to the server.

The guest's manage link is not put in the event, because the event's description is shared with the owner and the link
belongs to the guest only. The link goes to the guest in the confirmation email.

The object also publishes `calendar.booked` (audience: the owner's account) so the owner gets a notification, and the bridge
can tell an agent that owns a booking page.

## 4. The clients

- **Guest page** (`packages/calendar/src/book/`): the layout of the reference image. Left panel: owner name, title, length
  (as chips when there are several), location note. Right panel: "Select a Date & Time", the month grid with open days
  highlighted, month arrows, and the time zone picker. Picking a day opens a column of start times beside the grid (below it on
  a phone). Picking a time shows the form. Then the confirmation screen with "Add to calendar" (an `.ics` download and a
  Google Calendar link) and the Cancel and Reschedule links. A manage page (`/calendar/book/<token>/b/<manageToken>`) shows
  the booking with Cancel and Reschedule; Reschedule reuses the month grid and the time list. Light and dark themes from the suite tokens. No FullCalendar: the month grid is small and the
  existing `MiniMonth.tsx` is the starting point.
- **Owner settings** (web Calendar app): "Booking page" in the sidebar opens a dialog with the fields of §1, a weekly hours editor,
  a link with Copy, and a list of the next bookings.
- **Native clients**: bookings show as ordinary events. Settings are web only in v1. This is a Parity line in CHANGELOG.md
  (a gap, to close with a settings screen on macOS and iOS or a link to the web settings).
- **Agents and the assistant**: one tool, `get_booking_link`, so the assistant or an agent can paste the link into a mail or a
  chat. Changing the settings by tool is later.

## 5. Abuse and privacy

- The guest sees only free time, never event titles or which calendar is busy.
- Rate limits (the Directory's fixed windows): 60 reads per minute per IP per token; 5 bookings per hour per IP; 20 bookings per
  day per page. A honeypot field in the form. Cloudflare Turnstile is the next step if spam shows up.
- The directory stores only token hashes. Guest IPs are stored only as a salted hash, for the limits (§10).
- No address, name or token in log lines (the rule in `calendar.md` §9).
- The page is `noindex` and `no-referrer`, so a link does not leak through search engines or the `Referer` header.

## 6. Tests

- `scheduler.test.ts`: slots for the default config, DST start and end days, ranges split by lunch, buffers, notice, horizon,
  max per day, a guest zone where the owner's day crosses midnight, all lengths.
- `book.test.ts`: unknown and disabled tokens are the same 404; the token is accepted in upper case and without dashes;
  rotate kills the old token; two bookings for the same slot, one 409; cancel and reschedule by the manage token (same UID,
  higher SEQUENCE, own slot shown as free); the reschedule limit; nothing private in the public answers; a visit syncs a
  stale connected calendar only once per minute, and a native-only page never syncs.
- e2e (`test/e2e-calendar.mjs`): Ann turns on her page, a guest books, the event is on Ann's native calendar with the guest as
  attendee and an iMIP in the outbox, the guest reschedules (an updated iMIP), the guest cancels.
- QA: the guest page on a phone width and on desktop, light and dark.

## 7. The PR

One branch, `calendar/guest-scheduler`, one PR against `main`, one commit per phase:

1. Server: tables, `scheduler.ts`, owner API, public API, Directory token index, rate limits, tests.
2. Guest page: `book.html` entry, manifest page, the month grid, slots, form, confirmation, manage page (cancel, reschedule).
3. Owner settings dialog in the web Calendar app, and `get_booking_link`.
4. e2e, `changelog/` entry with a `## Feature` section, the Parity line, this spec updated with "as built".

Visible impact: web client (owner settings and the guest page), and macOS, iOS, desktop only in that bookings appear as events.

## 8. Later

Several pages per person (event types); a video call link made for each booking (a FreeFlow call, once a guest without an
account can join one); questions on the form; email verification; round-robin and collective pages for a team (the Org
object); Turnstile; paid bookings; settings on macOS and iOS.

## 9. Rulings and open questions

Ruled 2026-11-12: a guest visit re-syncs stale connected calendars, with the limits of §3.4; no call link in v1, the
location is the owner's text; guests can cancel and reschedule; the secret token URL only, in the readable form of §2.3;
one booking page per person, with several meeting lengths.

No questions are open.

## 10. As built (2026-11-12)

One branch, `calendar/guest-scheduler`, four commits after the spec: server, guest page, owner settings, tests and docs.
Where the build differs from the plan above:

- **Guests' own links are not under the page link.** A booking's link is `/calendar/book/m/<token>` (22 base64url
  characters), indexed in the directory like the page link (`booking_links`, `kind` `page` or `manage`). So a new page link
  does not break the cancel and reschedule links guests already have. The page link stays one per account.
- **Storage.** `scheduler_pages` keeps the settings as one JSON column (`config`, scheduler.ts `SchedulerConfig`) and the
  page token itself, so the owner can copy the link again; only the directory's shared index holds hashes.
  `scheduler_bookings` also has `mailed_ics` (below).
- **Rate limits live in the owner's Calendar object** (`rate_limit_windows`), not the directory: 60 reads a minute and 5
  writes an hour per address (a salted hash of it), 20 new bookings a day per page. The `book-*` rows are pruned after a day.
- **A link location is hidden until booking.** When the location is a URL, the public page info says `kind: 'link'` with no
  label, and the page shows "Web conferencing details provided upon confirmation"; the booking and its mail carry the link.
- **Writes go through the object's own event routes** (`asOwner`: POST, PATCH and DELETE `/v1/calendar/events`), so a
  booking is scheduled, mailed and published exactly as an event made in the app.
- **The guest mail.** Always sent, from the platform sender (`mail.ts` `sendMail`), named "<owner> via FreeFlow", Reply-To
  the owner: booked, moved or cancelled, with the guest's link. When the calendar side sent no invitation
  (`invitationsSent: false`, for example a native calendar whose owner has no mailbox), the mail attaches it (REQUEST, or
  CANCEL for a cancellation) and the booking keeps `mailed_ics` so later changes are mailed the same way.
- **All-day busy events** cover their dates in the page's zone (`busyOf`), not in UTC as the free/busy route does.
- **The owner's notification** is `calendar.booked` on the bus (audience: the owner; `data.action` booked, moved or
  cancelled). No client shows it as a notification yet, and the bridge does not subscribe to it.
- **The pages.** `book.html` is a second Vite entry; the manifest page has `file: 'book.html'` and the assembler files it as
  `_pages/calendar-book.html`. The page follows the system's light or dark theme. The settings dialog is
  `BookingPageDialog.tsx` (sidebar → Booking page, or `?booking=1`).
- **Tests.** `scheduler.test.ts` (slots, DST, zones, settings, tokens), `book.test.ts` (the whole flow on one object
  through the public route), `src/book/book.test.ts` (the page's helpers), and the `book:` section of
  `test/e2e-calendar.mjs` (158 passed on 2026-11-12).
