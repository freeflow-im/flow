# A card under the suite bar asks to reconnect a calendar

- `[web]` `[desktop]` When a connected calendar's sync is refused (`auth_failed`), a card slides down from the suite bar on every page; for Google its Reconnect button goes straight to Google's consent page and back to the same page. A CalDAV account's card opens Calendar.
- `[web]` Calendar's sidebar says "Reconnect needed" for a Google account, not "Password needed".

## Feature

- **FreeFlow tells you when a calendar needs reconnecting.** If Google (or another calendar) stops letting FreeFlow in, a card appears at the top of every page. Choose Reconnect to sign in to Google again, and you come straight back to where you were.
