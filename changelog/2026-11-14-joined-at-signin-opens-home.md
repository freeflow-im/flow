# A workspace joined at sign-in opens Home, not Chat

- `[web]` A Google domain auto-join, an emailed invite accepted at sign-in and a join link now open Home directly (lib/openHome.ts, shared with the chooser); Chat is never mounted on the way. The desktop app and `?next=` sign-ins are unchanged.
- `[web]` The "You've joined …" line is carried to Home (sessionStorage `flow.homeNotice`) and shown there once.

## Feature

- **Joining lands on Home.** When signing in adds you to a workspace (through your email domain, an invite or a join link), Home opens directly and tells you what you joined.
