# Attachment timing details, attachments kept ahead, lists from the cache

- `[server]` An attachment request's record and `Server-Timing` say how it was read (`kept`, `stored`, its own `part`,
  or the `whole` message parsed), its size, and `download: true` for Mail's Download links.
- `[server]` Docs previews of mail attachments log and send their steps (lookup, auth, mail read, store).
- `[server]` The Mail alarm keeps every attachment of the last 7 days' mail in R2, sealed, so opening or previewing one
  skips the mail server (1–3.5 s → under 0.2 s measured); older ones are deleted.
- `[server]` Conversation lists answer from the cache at once (no IMAP connection or folder lock) and check the
  server in the background, saying `refreshing` meanwhile; lists no longer queue behind a connection being opened.
- `[web]` A list page that says `refreshing` is asked for again every second until the check is done.
- `[server]` `isolateAgeMs` is the isolate's real age (it was the time since 1970).
- `[web]` Mail's call timings carry the bytes received, and a call answered from the browser's cache is marked
  `cache: browser` without the stored server timing.

## Feature

Attachments in mail from the last week open much faster: Mail fetches them in the background as new mail arrives.
Switching folders and inbox tabs is faster too, especially when you come back to Mail after a break: the list shows
at once, and new mail appears a moment later.
