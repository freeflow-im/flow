# Hosted mail is on: MXRoute

- `[server]` `MAIL_PROVIDER=mxroute` and `MXROUTE_SERVER` in the Worker's vars; with the secrets set, new accounts get a mailbox at `<slug>.freeflow.im` before they are active, and owners can set up mailboxes for existing members.

## Feature

Every new member of an organization now gets a mailbox at the organization's address, ready in Mail when they first sign in. Owners and admins can give existing members theirs from the organization's settings.
