# Mail: pages from a folder the alarm just synced skip the server

- `[server]` A folder the alarm synced within 45 s is served as the cache stands: a plain page, a tab's page and the conversations do no NOOP, `UID SEARCH`, tab sort or FLAGS round trip (new mail and flags are the alarm's, every 30 s while Mail is in use); older or unsynced folders keep the live checks. The alarm sorts INBOX's new mail into the inbox tabs itself. A flag change the alarm or a page finds also reaches the kept copy of an open message.

## Feature

- **Switching tabs and folders is instant.** Mail answers from its own copy whenever its background check ran in the last moments, instead of asking your mail server on every click.
