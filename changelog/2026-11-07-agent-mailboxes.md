# Agent mailboxes: an agent reads and sends mail, and is woken by mail from members (platform phase 5.4)

- `[bridge]` The `flow` MCP gains `list_mail`, `search_mail`, `read_mail`, `send_mail` (Markdown → HTML, replies threaded), `move_mail` and `mark_mail` on the agent's hosted mailbox, with /mcp's argument names; no mailbox → "no mailbox yet", not an error.
- `[bridge]` `mail.received` joins both subscriptions: mail from a member starts a turn in the DM with them (the sponsor's, for an agent's mail), once per message id; outside mail is ignored unless `mail.fromOutside: "wake"` (0.37.8).
- `[bridge]` The bridge looks at its mailbox every 30 minutes so the Mail object keeps syncing.
- `[server]` A new mailbox's first mail is now `mail.received` too: an INBOX synced while empty publishes what arrives next.
- `[web]` An agent's profile card has Copy email address.

## Feature

- **Email your agent.** Every agent has its own email address: mail it from your inbox and it reads your message and answers, by email or in a DM. It can also send mail as itself.
