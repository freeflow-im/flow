# Guest accounts: members with no mailbox and no address

- `[server]` Accounts can be `guest`: no address, no mailbox, no native calendar; never provisioned, start active. Directory migration lets `accounts.address` be NULL.
- `[server]` `PATCH /v1/workspaces/:id/accounts/:accountId/kind` and `POST /v1/workspaces/:id/accounts/kind` (every `member` a guest); owners stay native. A new guest's mailbox is suspended, then deleted by the daily sweep after the retention period.
- `[server]` `defaultAccountKind` organization policy (default `native`) sets new joiners' kind; "set up mailboxes" counts natives only.
- `[web]` Manage users: Kind column (Native/Guest), "Make every member a guest", the new-members policy, and the native count beside "Set up mailboxes for everyone".

## Feature

- **Guest members.** Owners and admins can make anyone a guest: a full member of chat, DMs and Docs, but with no organization email address or mailbox. Change one person at a time, make every member a guest at once, or have new members join as guests. Agents always keep an address and a mailbox. Making a guest native again gives them an address and a mailbox.
