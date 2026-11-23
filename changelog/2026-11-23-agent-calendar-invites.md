# Invitations by email reach an assistant's calendar

- `[server]` When an assistant's mailbox check keeps an invitation (sender on the allowlist, authenticated), the event goes on the assistant's own calendar, needing an answer (`Calendar.receiveImip`). The sender must be the event's organizer; platform account parameters in the email are dropped.
- `[server]` Before, only invitations from FreeFlow calendars reached it, so an invitation from Google or Outlook never did.

## Feature

- **Invite your assistant from any calendar.** Add your assistant's address to an event in Google Calendar, Outlook or any other calendar, and it shows on the assistant's own calendar, where it can answer it. Your address needs to be on the assistant's list of allowed senders (Organization settings → Your assistant).
