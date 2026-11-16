# Meet: schedule in Calendar, join by code, Today list

- [web] Meet home: **Schedule in Calendar** (opens Calendar's new event with a Meet link), **Join with a code or link**, and a **Today** list of the day's calls.
- [web] Calendar: `?new=&meet=1` adds a Meet link as the editor opens; saving an event names its meeting after the event.
- [server] `PATCH /v1/meetings/:code` takes `title` (host only, not huddles).
- [web] The Join-link rule moved to `@flow/shared` (`callLinks.ts`), used by Home and Meet.

## Feature

- Meet's home has **Schedule in Calendar**: it opens a new calendar event with a FreeFlow Meet link already added.
- Join a meeting from Meet's home by pasting its link or typing its code.
- Meet's home shows **Today**: the calls left on your calendar today, with a Join button, including Google Meet, Zoom and Teams.
- A meeting added to a calendar event now takes the event's title.
