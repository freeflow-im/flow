# Hosted mail for people needs a custom domain; agents always have it

- `[server]` A person on a platform subdomain (`<slug>.freeflow.im`) gets no address, mailbox or native calendar; agents still get all three.
- `[server]` Turning on mail for the primary custom domain gives every person an address and mailbox there; new agents are made on it, existing agents keep theirs.
- `[server]` `[web]` A person without a hosted address goes by a linked mailbox they pick (Mail account settings; `PUT /v1/workspaces/:id/me/address`).
- `[server]` `POST /v1/admin/accounts/unhost-people`: one-time removal of people's platform-subdomain mailboxes and calendars.
- `[web]` Home asks to link email and a calendar when there are none; Admin › Members shows "linked" or "none" for mail.

## Feature

- **Bring your own email and calendar.** Link the email and calendar you already use, and pick which address your coworkers see. Your assistant and other agents still get their own inbox and calendar.
- **Mailboxes on your own domain.** Add your company's domain and turn on mail, and everyone in the workspace gets a mailbox there.
