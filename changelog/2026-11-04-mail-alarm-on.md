# Mail: the prefetch cache's alarm is back on

- `[server]` `MAIL_ALARM = "off"` comes out of wrangler.toml: the slow tab query that reset the Mail object (#697) is fixed, so the alarm refreshes the cache again every 30 s while Mail is in use, and pages of a folder it synced within 45 s are served without a round trip.

## Feature

- **Mail is quick again.** Folders and tabs open at once while you're using Mail; new mail and changes from other devices show within half a minute.
