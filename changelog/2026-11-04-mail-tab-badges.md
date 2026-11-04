# Mail: the inbox tabs say what is new

- `[server]` `GET …/accounts/:id/tabs?after=tab:uid,…` answers each inbox tab's message, unread and new-since counts and its newest message, from the prefetch cache the alarm keeps (no mail server round trip).
- `[web]` A tab that is not open shows "N new" (what arrived after the newest message seen there, remembered per browser) and the newest message's sender and subject under its name, as Gmail's tabs do; polled every minute with the lists.

## Feature

- **See what's waiting in the other tabs.** Promotions, Social, Updates and Forums show how many messages arrived since you last looked, and who the newest is from.
