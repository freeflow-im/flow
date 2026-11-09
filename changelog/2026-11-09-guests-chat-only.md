# Guests use Chat only

- `[server]` Mail, Calendar and Contacts refuse a guest with 403 `guest` (`resolveAccountCaller`); Docs' API answers 403 for a guest too, public links excepted (`docs/specs/workspace-admin.md` §6.5, decision_log 2026-11-09).
- `[web]` Every suite bar greys the other apps' tabs for a guest ("Guests use Chat only"); Mail, Calendar and Contacts show a page saying so instead of an error.

## Feature

A chat guest sees Chat alone: the other apps' tabs say "Guests use Chat only", and opening one shows the same note with a way back to Chat.
