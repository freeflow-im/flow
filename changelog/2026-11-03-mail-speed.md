# Mail: opening a message no longer waits behind the inbox tabs, and Gmail inboxes load faster

- `[edge]` Two IMAP connections per account in the Mail object: interactive (open, attachments, flags, move, delete, send) and background (lists, folders, tab counts, sorting), each opened lazily with its own idle close and locks, so a slow count never queues an open or a mark-read.
- `[edge]` Inbox tabs from a cache in the Mail object's SQLite for Gmail too: new UIDs above a per-folder high-water mark (`mail_sync`) are sorted with `UID <range> X-GM-RAW "category:…"` plus one envelope FETCH; tab lists page through cached UIDs and fetch only that page's summaries; `GET .../categories` is one `SEARCH UNSEEN` joined with the cache, kept 20 s; a background re-check every 10 minutes picks up Gmail's re-sorting and mail that left INBOX.
- `[edge]` `GET .../messages/:uid` fetches the structure, then only the text parts (and inline pictures and small parts), and parses a rebuilt minimal message with postal-mime; attachments download by their part alone. Messages over 50 MB open. Attachment `index` values are unchanged in shape and documented in docs/specs/mail-api.md.
- `[edge]` One timing line per request: `[mail] <route> <status> <ms>ms (lock wait <ms>, imap <ms>)`, with no ids or content.
- `[web]` Mail updates folder and tab unread counts at once after read, flag, move and delete, and refreshes them once, quietly, 4 s after a burst; tab counts poll every 2 minutes; the next message is read ahead so j is instant; a message is marked read once it is on screen.
- `[qa]` `test/e2e-mail.mjs` covers opening by parts (multipart/alternative with an inline picture and an attachment, plain text, quoted-printable/base64, non-UTF-8 charsets, a forwarded message, a 78 MB message), a slow count not holding up an open, and the tabs' cache; unit tests for the Gmail range searches, the tab SQL and the client's counts.

## Feature

- **Faster mail.** Messages open right away even while your inbox tabs are being counted, large messages open without downloading their attachments, and the next message is ready before you press j. Unread counts update as you read.
