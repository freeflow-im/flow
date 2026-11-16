# Scheduled agent runs start fresh

- [server] Each wake job starts a new conversation for its automation, so one failed run ("tools unavailable") is not repeated by the next. Earlier runs stay stored.

## Feature

A scheduled task for an agent now starts fresh every time it runs, so one bad run no longer makes the next ones fail.
