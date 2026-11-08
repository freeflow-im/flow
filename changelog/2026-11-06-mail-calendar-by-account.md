# Mail and Calendar are keyed by account (platform phase 1.4)

- `[server]` The Mail and Calendar objects are now `idFromName(accountId)` for the organization the request names (routes, Google's OAuth state, previews, the MCP and assistant tools); no account there is 403 `no_account`. Each object records its account and refuses a mis-keyed call.
- `[server]` `POST /v1/admin/accounts/rekey` copies each person's old per-person Mail and Calendar rows into their account's objects (`INSERT OR IGNORE`; the old objects stay as the rollback).
- `[web]` Mail and Calendar name the selected organization on every request, reload on switching, and show an empty state to someone in no organization.

## Feature

- **Mail and calendars belong to your organization.** The mail and calendars you see are the ones of the organization selected in the bar; switching organizations switches them.
