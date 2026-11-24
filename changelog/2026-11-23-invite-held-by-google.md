# Answering an invite Google holds no longer fails

- `[server]` A CalDAV 400 on a new invitation re-syncs and answers the copy if it is there now; else the organizer is emailed the answer and the reply says `held`. Google refuses any copy of an invite from a new sender until "Add to calendar" in Gmail.
- `[server]` The reply email no longer fails on Outlook zone names ("Eastern Standard Time"); a refused CalDAV write logs the server's response text.
- `[web]` The invite card's notice says the organizer was told and points to Gmail's "Add to calendar".

## Feature

- **Answering invites from new senders works.** When Google will not yet add an invitation from someone you have not emailed before, your Yes, No or Maybe still reaches the organizer, and Mail tells you to choose "Add to calendar" in Gmail to put it on your calendar.
