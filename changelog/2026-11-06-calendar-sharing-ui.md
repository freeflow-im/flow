# Share a calendar, see calendars shared with you (platform phase 4.4)

- `[server]` The share index's `org` rows reach members: `sharedRefsOf` includes them (so the bus lets `ref:` events about organization-shared objects through), `GET /v1/calendar/shared` lists them as `principal: 'org'`, and `GET /v1/workspaces/:id/shared-with-me?org=1` adds them. Docs' Shared with me still leaves them out.
- `[server]` An `account:` grant on a calendar, a Docs file or an artifact must name an active member of the organization, else 400 `not_a_member`.
- `[web]` Calendar: Share… on a native calendar (people, agents, channels, everyone; Can view / Can edit / Can share), a Shared with me group drawn beside your own calendars with the role respected, `?calendar=<id>` links tick it, and guests on native events marked member or outside.

## Feature

- **Share your calendar.** Choose Share… from a calendar's menu to let a person, an agent, a channel or everyone in your organization see it, edit it, or share it on.
- **Calendars shared with you.** They appear under Shared with me in Calendar's sidebar; tick one to see its events beside yours. A calendar you can only view opens its events read-only; one you can edit works like your own. The link in a share's message opens Calendar with that calendar shown.
- **Who is coming.** On your calendar's events, each guest shows whether they are in your organization or outside it, with their answer.
