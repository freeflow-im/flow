# Mail: Gmail's Updates and other tabs no longer fall into Primary

- `[edge]` Gmail inbox tabs never go to Primary on a missing answer: a failed or refused `X-GM-RAW` search (imapflow's `false`) changes nothing, the re-check searches ranges of at most 250 cached UIDs instead of `<floor>:*`, and a row left out is asked about again by UID before it is demoted (`src/imap/gmailTabs.ts`).
- `[edge]` Sorting new Gmail mail leaves a batch unsorted, to be retried, when a search fails; a large batch with no category at all is confirmed by UID first.
- `[edge]` One-time repair: folders with rows cached as `Gmail: no category` are re-checked on the next list, and older such rows are asked about again, 1000 per re-check.
- `[edge]` `GET /v1/mail/accounts/:id/debug/tabs` (the last sorting and re-check results, the cache by tab and reason, `?uids=`), and `categoryReason` on each tab's `MessageSummary`.
- `[web]` Mail: "Why is this in <Tab>?" in a row's menu.

## Feature

- **Gmail's tabs stay right.** Mail Gmail puts in Updates, Promotions, Social or Forums no longer ends up in Primary when Gmail answers slowly or partly, and mail that was put there wrongly moves back to its tab on its own.
- **Why is this here?** A message's menu in the inbox tells you why it is in its tab: Gmail's category, a sender you moved, or what its headers say.
