# Calendar: invitations across Mail and Calendar

- `[server]` `POST /v1/calendar/invites`, `…/respond` and `…/cancel`: an invitation's `text/calendar` part read from the person's Mail object by binding, the answer set on the calendar (or the event put there), a cancellation removed.
- `[server]` iMIP for calendar servers that do not schedule (Radicale): answers, and an organizer's invitations, updates and cancellations, sent from the person's mail account; event writes answer `invitationsSent`.
- `[web]` Mail: an invitation card above the message (Yes · No · Maybe, the calendar to use, Remove for a cancellation, who replied), and Create event in a thread's menu, which opens Calendar's edit dialog filled in (`?new=`).
- `[qa]` `test/e2e-calendar-invites.mjs` against GreenMail and Radicale.

## Feature

- **Answer invitations from Mail.** A message with a meeting invitation shows the event above it: when, where, who and how it repeats, with Yes, No and Maybe. Your answer goes on your calendar and the organizer is told. A cancellation offers to take the event off your calendar.
- **Invite people from Calendar on any calendar server.** On servers that do not send invitations themselves, FreeFlow emails your guests the invitation, its updates and its cancellation from your mail account.
- **Create an event from a conversation.** The ⋮ menu of a thread opens Calendar with the subject and everyone on the thread already filled in.
