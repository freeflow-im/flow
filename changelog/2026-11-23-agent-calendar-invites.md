# Invitations by email reach an assistant's calendar

- `[server]` When an assistant's mailbox check keeps an invitation (sender allowed, authenticated), the event goes on the assistant's own calendar, needing an answer (`Calendar.receiveImip`). The sender must be the event's organizer; platform account parameters in the email are dropped.
- `[server]` A sponsor's own addresses (FreeFlow address, connected mail and calendar accounts) may always mail their assistant, without the allowlist (decision_log 2026-11-23).
- `[web]` Admin › Your assistant lists those addresses as always allowed.

## Feature

- **Invite your assistant from any calendar.** Add your assistant's address to an event in Google Calendar, Outlook or any other calendar, and it shows on the assistant's own calendar, where it can answer it.
- **Your assistant always takes mail from you.** Mail and invitations from your own addresses (including the accounts you connected) reach it without adding yourself to its list of senders.
