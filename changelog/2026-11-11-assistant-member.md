# The assistant is a member; the Org owns the member list

- `[server]` The Org object's member list holds every member's kind (`native`, `guest`, `personal_agent`) and each person's assistant; the Org decides when an assistant is made or set aside, and the directory only records it. Kind changes go through the Org. `GET …/members?all=1` (admins) adds external personal agents.
- `[server]` A personal agent is never a grant target, never acts as itself, and is DMed or brought into a channel by its sponsor alone; only its sponsor may point a wake automation at it (owners and admins could before).
- `[server]` The assistant in Chat: its sponsor's DM, a private channel of the two, a mention (it joins the channel), or a reply in a thread it answers in starts its turn, run with the sponsor's access; it posts as itself, in the thread where others can read. Nobody else's message starts one; others' messages reach it as quoted content.
- `[server]` The assistant's mailbox: its first name gives it `name@domain`, a mailbox and calendar ("Ada 🤖 Ann" on what it sends). Mail only from the sponsor's addresses and senders they add, authenticated by SPF/DKIM/DMARC, reaches it and is answered by mail; the rest goes to its Refused folder. Its mailbox is checked every minute.
- `[web]` Docs: "Name your assistant" in the panel; Settings edits who may mail it.
- `[web]` Admin Members lists assistants and personal agents with their sponsor.
- `[qa]` New `e2e-assistant-mail.mjs` (naming, Refused, the mail answer). e2e-admin: assistants on the Org's list, DM and wake refusals; e2e: the shared agent's address check skips assistants.

## Feature

- The organization's Members list now shows everyone's assistant, marked with whose it is.
- Message your assistant in Chat: DM it, or mention it in any channel and it answers you in the thread. It answers only you.
- Name your assistant, and it gets its own email address and calendar. Mail it from your own address; mail from anyone else is set aside unread, unless you add the sender in Settings.
