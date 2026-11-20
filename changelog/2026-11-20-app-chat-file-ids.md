# Hosted apps: read Chat files by id (`files:read`)

- `[server]` New `files:read` use: `ctx.chat.file(id)` gives a Chat file's name, type, size and image size, and
  `ctx.files.copyFromChat(id, key?)` copies it into the app's own files. Both act as the caller through Chat's file check.
- `[server]` The app keeps a copy, so its screen shows it to the app's viewers and it survives the Chat message's deletion.

## Feature

- **Apps can use files posted in Chat.** An agent can hand an app a picture someone posted in Chat (for example, to
  put on a task card) by its id, with no upload step. The app only gets files the person or agent asking can open.
