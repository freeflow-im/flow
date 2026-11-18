# Calendar side panel: opens at today, with a now line

- `[web]` Panel Week view stays scrolled to today while events load (before, events above today pushed it out of view); it scrolls the list itself, not the host page.
- `[web]` Panel Week view draws a red "now" line in today's row, before the first event that has not started; it moves each minute.
- `[web]` Panel Day view opens an hour before the current time instead of 7:30 AM.

## Feature

- **The calendar beside your mail opens at today.** The week view shows today first, with a red line marking the current time between what is done and what is next. The day view opens at the current time too.
