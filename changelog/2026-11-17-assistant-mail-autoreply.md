# Agents answer email on their own only when you turn it on

- `[server]` `[web]` New assistant setting "Agent always responds to incoming email", off by default (existing assistants too): off, allowlisted mail stays in the inbox and starts no turn; the prompt says which.
- `[server]` `GET`/`PUT /v1/workspaces/:id/assistant/senders` carry `autoReply` beside `senders`; each is set alone.

## Feature

- **Your assistant no longer answers email by itself unless you say so.** Mail from the senders you allow waits in its inbox for you to ask about. Turn on "Agent always responds to incoming email" in your assistant's settings if you want it to reply on its own.
