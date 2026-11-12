# Admin: each assistant listed once; "Your assistant" settings move to Admin

- `[web]` Admin's Shared agents card leaves out personal agents; a person's assistant shows once, under Personal agents, as "assistant of Ann" with its address, no Remove, and a Rename link on your own.
- `[server]` Platform routes `GET/PUT /v1/workspaces/:id/assistant/{definition,senders,model}`; the model catalogue and settings types move to `@flow/shared/assistant` (Docs re-exports them).
- `[web]` New Admin section **Your assistant**, for every member: name, instructions, who may mail it, and the model and API key. Docs' Settings in the suite points there instead (the desktop app keeps its own). Admin depends on no app.

## Feature

- Your assistant's settings (name, instructions, who may mail it, and its model) are now in Organization settings → Your assistant, open to every member.
- In Organization settings → Agents, each assistant shows once.
