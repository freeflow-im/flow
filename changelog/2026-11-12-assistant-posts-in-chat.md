# Assistant: posts in other channels on the sponsor's ✅

- `[server]` A Chat turn gets page `chat` and four Chat tools the Worker runs with the sponsor's access: `list_channels`, `read_messages`, `leave_channel`, and `send_message`, which leaves a card in the DM and posts only on the sponsor's ✅ (joining the channel first); ❌ or a new message cancels.
- `[server]` A person's assistant may leave #general, and its sponsor may remove it from any channel (before, only owners and admins could remove a member).
- `[server]` Asked where others read, the assistant leaves no card (it would show the post) and asks for the DM. `test/e2e-assistant-chat.mjs` covers the flow on a local Worker.

## Feature

- **Your assistant can post in other channels for you.** Ask it in your direct messages, for example "post the lunch order reminder in #general". It shows you the exact message first; react ✅ to post it or ❌ to cancel. It can also read the channels you are in, and leave any channel when you ask, #general included.
