# Mail: bodies in the prefetch cache, and tab pages from it

- `[server]` The alarm now also fetches the text and HTML of cached messages (unread and newest first, 25 or 4 MB a run, the folder looked at last first), so `GET …/messages/:uid` answers from SQLite with no round trip; a message opened before the alarm got to it is kept too. Bodies over 1 MB (HTML) / 256 KB (text), and messages that cannot be opened by their parts, open from the server as before; a folder's bodies past 150 MB lose the oldest. On Gmail a body is kept once per message (X-GM-MSGID), whichever folder it is opened from.
- `[server]` An inbox tab's page takes its summaries from the cache (its flags checked in one FLAGS fetch) instead of fetching them each time; only messages the cache does not have are fetched, and cached. A reply sent here marks the cached original answered.

## Feature

- **Messages open at once.** Mail fetches your recent messages in the background, so opening one shows it immediately instead of waiting for the server; the inbox tabs load faster too.
