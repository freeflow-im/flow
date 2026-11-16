# Addresses: aliases, changing an address, and the first domain made primary

- [server] Aliases for hosted mailboxes, as MXRoute forwarders. Changing an address moves a small mailbox (≤200 messages) to a new one with its mail copied; a bigger one keeps its mailbox and sends as the new address (platform.md §3.2).
- [server] A workspace's first own domain becomes primary when it is verified.
- [web] Members: an Addresses dialog to add or remove aliases and make one the main address.
- [server] [web] Members add and remove their own aliases in Mail's account settings (`/v1/workspaces/:id/me/addresses`).

## Feature

- Admins can give a member extra email addresses, and change the address they send from, under Members › Addresses. Mail to the old address still arrives.
- You can add your own extra email addresses in Mail: open your organization mailbox's settings.
- Your first custom domain becomes the workspace's main domain as soon as it is verified, so people get their mailboxes without an extra step.
