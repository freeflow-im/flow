# Calendar: one calendar that fails to sync no longer breaks the whole account

- `[server]` A change sync (sync-collection) that the server cut short (507 on the collection) is read on from its
  token; any other refused entry falls back to a full listing. Before, it failed every minute and never moved on.
- `[server]` One calendar failing while the account's other calendars synced in the last 5 minutes no longer marks
  the account "could not be reached".

## Feature

- **A connected calendar account stays connected.** One shared calendar that failed to update could make Calendar
  say your whole Google account "could not be reached", even after you signed in again. That calendar now updates,
  and one calendar in trouble no longer puts the warning on the account.
