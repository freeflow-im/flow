# Desktop notifications row always in the account menu

- `[web]` `[desktop]` The account menu always has a desktop notifications row: "Turn on" when not yet asked, an on/off switch once allowed, and a "blocked" note with where to allow them. Before, it showed only while unasked, and Chat asks on load, so it was usually hidden.
- `[web]` `[desktop]` The switch turns meeting notifications off for Flow in this browser (localStorage, every tab follows); the browser's permission is not touched.

## Feature

- **Turn meeting notifications on or off from your account menu.** The menu now always shows whether desktop notifications are on, with a switch to turn them off or back on. If your browser blocks them, it tells you where to allow them.
