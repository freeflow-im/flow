# Admin → Prompts: the assistant's suggested prompts

- [web] Admin → Prompts: owners and admins edit the assistant's suggested prompts for Home, Admin, Mail inbox, Mail message, Chat, Calendar, Docs list and Open doc.
- [server] `GET`/`PUT /v1/workspaces/:id/assistant-prompts`, kept by the Org object; only changed pages are stored, the rest follow the defaults.
- [web] Every assistant panel (Home, Admin, Mail, Calendar, Docs) reads them through `useSuggestedPrompts`; Home's and Admin's panel now shows suggestions too.

## Feature

Owners and admins can now choose the prompts the assistant suggests on each page, in Admin → Prompts. The assistant on Home and in Admin now suggests prompts too.
