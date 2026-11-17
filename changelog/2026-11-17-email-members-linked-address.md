# Email to members reaches people without hosted mail

- `[server]` `email_members` (and `POST /v1/contacts/email`) counts a member's linked mailbox when they have no hosted address, so "email me" works for people outside a custom mail domain; the Reply-To uses it too.

## Feature

- **"Email me" from your agent works without FreeFlow-hosted mail.** An automation or your assistant can now email you at the mailbox you use with FreeFlow, even when your organization has no custom mail domain.
