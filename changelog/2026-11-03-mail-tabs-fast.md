# Mail: inbox tabs without counts, tab lists that answer at once, and dragging messages onto a tab

- `[edge]` `GET .../categories` and the tab counts are gone (with their cache and `since`). A tab's list sorts only new mail above the high-water mark (at most 100), reads its page from the cache, and when the page is short while older mail is unsorted answers with `sorting: true` and `next`; a background sorter extends the cache (300 a step, up to 3000 a run, two pages ahead).
- `[edge]` A third IMAP connection per account, the sorter, for background sorting and the re-check, so neither holds up a list. The re-check covers the newest 2000 cached messages (`UID SEARCH <floor>:*`, and Gmail's category searches over the same range) instead of the whole mailbox.
- `[edge]` The per-request timing line is logged by the Worker (`routes/mail.ts`) from an `x-mail-timing` header: logged in the Mail object it reached `wrangler tail` late or never, because the object's open IMAP sockets keep a request's tail event open.
- `[web]` The tab bar is plain labels and icons (no "N new" pills, latest line or last-opened bookkeeping); a short tab page shows "Sorting older mail…" and is asked for again every 2 s; with a mouse, rows (or all checked rows) drag onto a tab or a folder in the left panel.

## Feature

- **Inbox tabs open at once.** Even on a very large inbox, a tab shows its newest mail straight away while older mail is sorted in the background ("Sorting older mail…" at the end of the list). The tabs no longer show counts.
- **Drag a message onto a tab.** Drag a message (or all the ones you've checked) onto Promotions, Social or another tab to send that sender's mail there, with Undo; or drop it on a folder to move it there.
