# Native calendars: your own calendar on the platform, shareable, with events on the bus (platform phase 4.1)

- `[server]` Each Calendar object gets a `native` account and a default calendar "Calendar" on first use (id `n.<ownerAccountId>.<random>`); its writes go to the object's store (own etags, If-Match, the three recurrence scopes), no sync, no alarm.
- `[server]` Native writes publish `calendar.event.added` / `.updated` / `.cancelled` into the organization's event log, `ref:` the calendar, visible to its owner and whoever it is shared with.
- `[server]` Grants on native calendars: `GET`/`PUT …/calendars/:id/grants`, `DELETE …/grants/:principal` (manager+, no `link:`), reported to the share index; a request naming another account's native calendar is forwarded to the owner's object, which checks the reader's role (none is 404). `GET /v1/calendar/shared` lists the calendars shared with the caller.
- `[server]` `POST /v1/calendar/freebusy` answers members of the organization from their own native calendars (busy intervals only).
- `[web]` Calendar shows the native calendar without account settings.

## Feature

Everyone now has a calendar of their own in FreeFlow Calendar, with no server to connect: new events go on it unless you pick another. It can be shared with a person, a channel or the whole organization, and people in your organization can see when you are busy.
