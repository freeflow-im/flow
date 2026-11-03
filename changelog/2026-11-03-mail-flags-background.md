# Mail: marking a message read no longer delays opening the next

- `[server]` Read, unread and starred changes go over Mail's background IMAP connection, not the one that opens messages. Opening a message no longer waits behind the previous one being marked read (production showed 0.5–2.2 s of that wait); the app already shows the change at once.
