# Apps: a members list and image icons

- `[server]` Hosted apps can declare `members:read`. They then get `ctx.members.list()` and `search(text)`, which return the organization's people and agents as the caller sees them in Chat, with no emails, guests or removed members. Members' pictures are served from the app's own host.
- `[server]` A hosted app's `icon` may be a PNG or SVG in `ui/`. It is checked for size and shape at draft check and upload, and served from `/v1/workspaces/:id/apps/:name/icon`.
- `[web]` `[desktop]` Image icons show in the Apps menu, the app cards, Admin → Apps, the install card and the browser tab on the app's page.

## Feature

- **Apps can use your team's member list.** An app can offer a picker of your organization's people and agents, for example to assign a card. It sees only what you'd see in Chat, never email addresses.
- **Apps can have picture icons.** An app can use a small square image as its icon. It shows in the Apps menu, in Organization settings and in the browser tab. Emoji icons still work.
