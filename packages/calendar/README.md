# @flow/calendar — FreeFlow Calendar

The suite's calendar, served at `/calendar`. People connect the calendars they already have (iCloud and Fastmail with an
app password, any CalDAV server by its address; Google later) and see them overlaid in day, week, month and agenda views,
and create, move, edit and delete events, repeating ones too. The client only talks to the edge Worker's `/v1/calendar/*`
API (`packages/edge/src/routes/calendar.ts`, the contract in `docs/specs/calendar.md` §4); the Worker's Calendar object
holds the credentials, keeps a copy of every calendar and expands repeating events.

## Architecture

- **Vite + React 19 + Tailwind v4 + FullCalendar 6** (the MIT core: daygrid, timegrid, list, interaction), built for the
  base path `/calendar/`. `src/components/ui/` holds the shadcn primitives copied from Mail (`LICENSE-shadcn.md`).
- `src/api.ts` — the contract as typed functions (`calendarApi`). A 401 sends the browser to the suite's sign-in.
- `src/hooks/calendar.ts` — react-query: accounts, calendars, and the occurrences of the visible range (`useEvents`, every
  calendar's, so a checkbox hides one with no round trip), polled every 60 s and on focus (every 2 s while a calendar has
  not had its first sync), the neighbouring ranges read ahead. Create, move, edit, delete and RSVP change every cached range
  at once (`lib/occurrences.ts` `applyPatch`, `applyDelete`) and roll back on failure; a `conflict` refetches and says so.
- `src/components/CalendarGrid.tsx` — the one component that knows FullCalendar: view and date in, occurrences in, clicks,
  selections, drags and resizes out. Everything else (the popover, quick create, the edit dialog, the scope question, the
  sidebar with the small month and the calendars, search, the account dialogs) is ours.
- `src/App.tsx` — the layout and the keyboard (t, d w m a, ← → or k j, c, /, Enter or e, Backspace, Esc); under 760px,
  agenda and day only with the calendars behind a button. The address is the view: `/calendar/week/2026-11-09`,
  `/calendar/month/2026-11`, `?event=<id>` for an open event (`lib/route.ts`).
- `src/lib/` — pure and tested: `ranges.ts` (views, ranges, titles), `route.ts`, `occurrences.ts`, `recurrence.ts` (the
  repeat presets, the custom rule, RRULE in words), `format.ts`.

## Running it

- `pnpm --filter @flow/calendar dev:mock` — no server: sample calendars in `mock/` (`CALENDAR_MOCK=empty` for none; in Add
  account the password `wrong` is refused, a server address with `bad` cannot be reached, `stale` connects an account
  whose password then stops working).
- `pnpm --filter @flow/calendar dev` — proxies `/v1` to `CALENDAR_API` (default `http://127.0.0.1:8787`): the edge
  Worker's `wrangler dev` with `--var CALENDAR_ALLOW_INSECURE:1` and Radicale, as `packages/edge/test/e2e-calendar.mjs`
  says; sign in on the Worker and set its `sid` cookie for the dev server's origin.
- `pnpm --filter @flow/calendar typecheck | test | build`.
