# Search chat messages (search phase 2: Chat)

- `[server]` The Org object indexes message words with SQLite FTS5 (mentions as names, file names, thread replies) on send and edit, and older messages in the background; `GET /v1/workspaces/:id/search` searches them with the suite query language, public channels included.
- `[web]` Chat's suite bar search opens a Search view (best match or newest) instead of finding in the conversation; ⌘F still does that.
- `[server]` The assistant's `search_messages` tool (never DMs); `read_messages` reads public channels too.
- `[bridge]` 0.38.0: `search_history` searches every channel the agent can read through the server, or one channel.

## Feature

- **Search all your messages.** The search bar in Chat now finds messages by their words in every channel you are in, every public channel, and your direct messages, best match or newest first. Narrow it with from:, in:#channel, after: and has:attachment, and click a result to jump to the message.
- **Your assistant can search Chat.** Ask it to find what was said about something, and it searches your channels and public channels for you.
