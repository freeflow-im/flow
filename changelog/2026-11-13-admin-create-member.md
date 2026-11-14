# Admin › Members: create a member at an address on the org's domain

- `[server]` `POST/GET /v1/workspaces/:id/created-members` and `…/:accountId/setup-link`: a native account at `username@domain` (verified domains only) with no password, provisioned as any native join; a new `users.backup_email` column.
- `[server]` New `account_setup` email token (7 days), `GET/POST /v1/auth/setup`; "Forgot password" also mails the backup email.
- `[web]` Admin's Invite card is now "Add people" with Invite by email / Create member tabs; Pending lists members still to set a password, with Resend setup link.
- `[web]` `?setup=` opens a Set your password page showing the sign-in address, then signs in.

## Feature

- **Create members with your own domain's address.** In Admin › Members › Add people, choose Create member: give a name, a username on one of your verified domains and a backup email. The account exists right away, mailbox included. A setup link good for 7 days goes to the backup email. The new member opens it, sees the address they will sign in with, and chooses a password. Admins can resend the link from the Pending list. If they later forget their password, the reset link also goes to the backup email.
