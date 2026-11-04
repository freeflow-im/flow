# Mail: the prefetch cache

- `[server]` The Mail object keeps the newest 1000 messages of each account's INBOX, Sent, Drafts, Archive/All Mail and any folder opened lately in its SQLite (`src/imap/cache.ts`): a plain folder page is read from it after one small `UID SEARCH` for new mail, older pages outright, and the page's flags are checked in one FLAGS fetch. Its alarm refreshes flags (CONDSTORE where the server has it), forgets mail that left and fills in older mail: every 30 s while the person uses Mail, less often after, stopping after a day idle. A fourth IMAP connection per account ("cache") carries it; `GET …/debug/cache` shows it; the timing line ends with `cache=hit|fill|live`. Spec: docs/specs/mail-api.md, "The prefetch cache".

## Feature

- **Mail lists open faster.** Your inbox and other folders now show from a copy Mail keeps up to date in the background, so moving between folders and scrolling back through older mail is quicker. New mail still shows the moment you look.
