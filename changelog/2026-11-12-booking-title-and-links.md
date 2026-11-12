# Booking page: a title without a length, the guest's links in the invitation, and the account menu

- `[server]` Default title "Meeting with <owner's first name>" (worked out when shown; old defaults read as it); a booked event with the default title is named "<owner> and <guest>".
- `[server]` The booked event's description holds the guest's note and their cancel/reschedule link (the invitation shows it), not a line written to the owner. The platform's own confirmation mail goes only when no invitation was sent.
- `[web]` The suite bar's account menu offers "Copy booking link" when the page is on and "Create booking page" when it is not (every web app and the desktop shell).

## Feature

- **Clearer booking invitations.** A guest's invitation now has their link to cancel or reschedule, and a booking page is titled "Meeting with" your first name unless you give it a title of your own.
- **Your booking link is one click away.** Open your profile menu in any app to copy your booking link, or to create your booking page.
