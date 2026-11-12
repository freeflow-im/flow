# Event log updates itself; agents know the date and time

- `[web]` Admin's Event log reads new events every 10 s (they appear at the top) and loads older ones as the list is scrolled to its end, instead of an "Older" button.
- `[server]` Every hosted agent turn is told the current date and time in the asker's time zone: the panels send the browser's (`X-Timezone`), Chat, mail and automation turns use the person's profile zone; UTC when unknown. It goes with each message (`<current_time>`), not into the system prompt, and is hidden from the transcript.
- `[web]` Docs', Mail's and Calendar's assistant panels send the browser's time zone with each turn.

## Feature

- The Event log in Organization settings now updates on its own and loads older events as you scroll.
- Your assistant knows today's date and the time where you are.
