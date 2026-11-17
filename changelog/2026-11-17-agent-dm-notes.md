# Agent email: "email me" works for everyone, notes reach the DM, and the assistant runs locally

- `[server]` A personal agent's note in its DM (an email waiting for approval, a parked automation) is posted through its sponsor; it was refused.
- `[server]` Email to the person themself ("me", or one of their own addresses) needs no approval: `send_email` sends it at once, and `email_members` reaches "me" at the sign-in address when the account has no other.
- `[server]` With no mail account connected, an approved email goes from FreeFlow's address as "<name> via FreeFlow", Reply-To the person.
- `[web]` Every copy of an email's card updates when it is sent or discarded; the waiting list leaves out the ones the chat shows.
- `[server]` Local development: the organization's model comes from ANTHROPIC_API_KEY, OPENAI_API_KEY or OPENROUTER_API_KEY in .dev.vars (DEV_ADOPT_MODEL_KEYS, set by dev:suite only).

## Feature

- **Your assistant can email you at any time.** "Email me a summary" goes straight to your inbox with no approval step.
- **Your assistant tells you in Chat when an email waits for your approval**, with a link to review and send it.
- **Email works even without a connected mail account.** An approved email goes out from FreeFlow in your name, and replies come to you.
