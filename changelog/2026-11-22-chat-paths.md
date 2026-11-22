# Chat addresses name the organization and channel

- `[web]` `[desktop]` The address is `/chat/<org-slug>/<channel-name>` (DMs by id, `/thread/<id>`, `~activity` and the other views) and follows what is open, renames included; opening one switches organization and channel. `?open=` links still work and are rewritten.
- `[web]` An `?open=channel:` or message link into another of your organizations now opens it in that organization.
- `[web]` Signing in from a Chat page returns to it (it went to Home: two sign-in effects both read the page to return to).

## Feature

- **Chat links you can read and share.** The address bar now shows the organization and channel, such as `/chat/acme/general`, with the thread when one is open. Copy it to share a channel, bookmark it, or reload and land back in the same place. Signing in from one of these links brings you right back to it.
