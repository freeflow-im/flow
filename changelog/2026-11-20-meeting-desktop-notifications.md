# Desktop notifications for meeting alerts

- `[web]` `[desktop]` A meeting alert under the suite bar also raises a desktop notification. It goes out once per meeting across all open tabs (Web Lock + localStorage claim) and closes when its alert does. Clicking it focuses the tab and opens Join.
- `[web]` Permission is asked only from a click: "Turn on desktop notifications" in the account menu, or the meeting card's "Notify me on the desktop too". The desktop shell already grants it, so its notifications are native ones.

## Feature

- **Meeting reminders on your desktop.** When a meeting is about to start, FreeFlow now also shows a desktop notification, even while you're in another window. Click it to join the call. You get just one, however many FreeFlow tabs are open. Turn them on from your account menu, or from the meeting card the first time one appears.
