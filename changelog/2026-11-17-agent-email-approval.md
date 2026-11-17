# Agents send email after your click

- `[server]` New assistant tool `send_email`: composes the email (reply quoting, threading, forwarded attachments) and keeps it waiting in the person's Assistant object; `POST /api/agent/mail-approvals/:id/send|discard` (session only) sends or drops it. With no page open, the agent's DM gets a note linking to it.
- `[web]` Send message / Discard card in the assistant panels (the tool's row, and a "Waiting for your approval" list) and in Home (`?email-approval=`).

## Feature

- **Your agents can send email for you, after you approve it.** Ask your assistant to email anyone and it shows you the email with a **Send message** button; nothing goes out until you click it. When it works on its own (an automation, an email, a Chat message), it sends you the email in your direct messages with a link to review and send it.
