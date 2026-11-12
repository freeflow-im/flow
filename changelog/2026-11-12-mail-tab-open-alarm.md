# Mail checks for new mail every 5 minutes while a tab is open

- `[server]` `[web]` An open Mail tab (even hidden) sends a heartbeat every 5 min; while it does, the mail cache alarm runs every 5 min, or every 15 after a day with no use, instead of slowing to 30 min and stopping after a day.

## Feature

- **Mail stays fresh in a background tab.** While Mail is open in a tab, new mail is checked for every few minutes, even if you have not used it for a while.
