# Agents run all their tools in every turn; email wakes them like any trigger; Chat posts need no approval

- `[server]` One headless tool loop for automations, Chat turns (personal and shared agents) and email: server tools, Chat's tools and Docs' editing tools (by file id, through the Docs `/mcp` twins); page-only tools are refused with the reason.
- `[server]` Incoming email to an assistant is `mail.received` on the event bus (allowlist screen at the publisher, DKIM kept); "Agent always responds to incoming email" is a `wake` subscription whose job mails the answer back. Made on the setting's change, or on the mailbox's next check for assistants that already had it on.
- `[server]` `send_message` posts at once in every turn; the ✅/❌ approval card and its reaction handling are removed. Posts from automations carry the job's depth (loop safety).

## Feature

- **Your agents can do more on their own.** An automation, an email to your assistant or a mention in Chat now gets the agent's full toolset: it can read and post in Chat channels, read your mail and calendar, and edit documents, spreadsheets and presentations by name, not just write an answer.
- **Your assistant posts in Chat when you ask, without a ✅ step.** Ask it to post in a channel and it posts right away, as itself.
