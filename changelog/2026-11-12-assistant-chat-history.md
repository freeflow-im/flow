# Assistant panel: back to earlier chats

- `[server]` `GET /api/agent/history?scope=` lists a chat's conversations, newest first, with their first message; `POST /api/agent/reopen` makes one the active conversation again (the current one ends, as New chat ends it). Docs' server and the Worker's Assistant object both serve them.
- `[web]` ‹ › in the header of every assistant panel (Docs, Mail, Calendar, Home/Admin), shared from the suite bar (`ChatHistoryNav`): steps to the earlier or later chat, which then goes on from where it stopped.

## Feature

- **Go back to an earlier chat with the assistant.** The arrows next to New chat in the assistant panel step through your earlier conversations in that place, newest first. Pick one and keep going where you left off.
