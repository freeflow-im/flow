# Calendar tools and the assistant for native calendars (platform phase 4.3)

- `[server]` Calendar tools on native calendars: `list_calendars` marks `native` and the role and includes calendars shared with the caller; shared ids reach the owner's object by the routes' forwarding (`calendar/forward.ts`).
- `[server]` `create_event` defaults to the caller's FreeFlow calendar; results say who was scheduled by object call and who was emailed; `not_organizer` and role refusals come back in words.
- `[server]` New `share_calendar`, `unshare_calendar` (calendar:write, addresses resolved through the directory) and `list_shared_calendars`; `find_free_time` lists the members it read; free/busy answers each address's source.
- `[server]` The assistant gets the new tools and prompt lines; its Calendar context says whether the open event's calendar is native and the person's role on it.
- `[bridge]` 0.37.7: `find_free_time` and `create_event` on the `flow` MCP, so an agent can propose and book a meeting from a DM.

## Feature

- **Find a time and book it.** Ask the assistant, or an agent in a DM, to find a time when you and your colleagues are free and book the meeting: colleagues get it on their calendars at once, anyone else by email.
- **Share a calendar by asking.** The assistant can share your calendar with a colleague, a channel or everyone, and stop sharing it, when you ask.
