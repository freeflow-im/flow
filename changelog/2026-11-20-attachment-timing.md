# Attachment timing details, and attachments kept ahead

- `[server]` An attachment request's record and `Server-Timing` say how it was read (`kept`, `stored`, its own `part`,
  or the `whole` message parsed), its size, and `download: true` for Mail's Download links.
- `[server]` Docs previews of mail attachments log and send their steps (lookup, auth, mail read, store).
- `[server]` The Mail alarm keeps every attachment of the last 7 days' mail in R2, sealed, so opening or previewing one
  skips the mail server (1–3.5 s → under 0.2 s measured); older ones are deleted.
- `[server]` `isolateAgeMs` is the isolate's real age (it was the time since 1970).
- `[web]` Mail's call timings carry the bytes received, and a call answered from the browser's cache is marked
  `cache: browser` without the stored server timing.

## Feature

Attachments in mail from the last week open much faster: Mail fetches them in the background as new mail arrives.
