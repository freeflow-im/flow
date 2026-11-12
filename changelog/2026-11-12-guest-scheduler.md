# Calendar guest scheduler: a public booking page

- `[server]` Booking page per account in the Calendar object: settings, open slots from cached busy time, book, cancel and reschedule at `/v1/book/*` (no session); the directory maps token hashes to owners.
- `[server]` A guest visit syncs stale connected calendars at most once a minute; a booking re-syncs and re-checks the slot (409 `slot_taken`). `calendar.booked` goes to the owner on the bus.
- `[server]` The guest is mailed their own cancel/reschedule link, with the invitation attached when no mailbox sent one. `get_booking_link` tool for agents and the assistant.
- `[web]` `/calendar/book/<token>` guest page (own build entry, no sign-in, light and dark) and Booking page settings in the Calendar sidebar.
- `[qa]` `scheduler.test.ts`, `book.test.ts`, and a booking section in `test/e2e-calendar.mjs`.

## Feature

- **Let people book time with you.** Turn on your Booking page in Calendar and share its link. Guests see the days you have free, pick a meeting length and a time in their own time zone, and the meeting lands on your calendar with them invited.
- **Your hours, your rules.** Choose your weekly hours, the meeting lengths you offer, how much notice you need, how far ahead people can book, free time around meetings, and which calendars count as busy.
- **Guests can change their plans.** Every guest gets a link to cancel or move their meeting, so you never have to rearrange it by email.
