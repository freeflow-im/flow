# Calendar: tools for agents and the assistant in Calendar

- `[server]` Calendar tools on `/mcp` (`list_calendars`, `list_events`, `get_event`, `find_free_time`, `create_event`,
  `update_event`, `delete_event`, `respond_to_event`) under new `calendar:read` / `calendar:write` scopes, a consent checkbox.
- `[server]` The Docs assistant gets them too, with a Calendar page context and the browser tools `open_calendar_event`,
  `show_calendar_range`; its `delete_event` asks the user in the app first.
- `[web]` Calendar's Assistant button opens the assistant beside the calendar; an event it makes or changes has Open event.
- `[qa]` `packages/edge/test/e2e-calendar-mcp.mjs` against Radicale.

## Feature

- **Ask the assistant about your calendar.** In Calendar, open the Assistant to ask what your week looks like, find a time
  when you and others are free, add or move events, or answer invitations. It tells you what it changed, and asks before it
  deletes anything.
- **Agents can use your calendar.** Agents you connect to FreeFlow (Claude, ChatGPT and others) can now see your events,
  find free time and, if you allow it, create, change and answer events for you.
