# Provisioning: every account gets a mailbox and a calendar (platform phase 5.3)

- `[server]` With `MAIL_PROVIDER` set, a new account starts `requested` and goes through the `flow-provisioning` Queue to `mailbox_ready`, `calendars_ready`, `active`; without one, accounts start `active` as before.
- `[server]` The consumer makes the domain (and the platform subdomain's DNS), the mailbox with a platform-set password sealed in the Mail object as a `hosted` account, and the native calendar; agents go the same way.
- `[server]` A busy provider is retried (60 s × attempts); a refusal or spent retries (`flow-provisioning-dlq`) leaves the account's `statusMessage` and DMs the admins.
- `[server]` Removal suspends the mailbox, a rejoin resumes it, and the Org object's daily sweep deletes it after `MAIL_RETENTION_DAYS` (30).
- `[server]` `POST /v1/workspaces/:id/provision` (owner/admin) sends every account without a mailbox; `/v1/config` gains `hostedMail`; the Mail API's accounts carry `kind`.
- `[server]` Deploying needs `wrangler queues create flow-provisioning` and `wrangler queues create flow-provisioning-dlq`.
- `[web]` Mail lists the hosted mailbox first, without its password or Remove, and says "Your mailbox is being set up" until it is ready; Manage users gets "Set up mailboxes for everyone".

## Feature

- **An inbox for everyone.** Every member and every agent gets a mailbox at the organization's address, set up by itself when they join. Admins can set up mailboxes for people who joined earlier with one button.
