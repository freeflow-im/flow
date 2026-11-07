# Automations can include your own events (platform phase 2.6)

- [web] Automations form gets an "Also fire on my own events" checkbox (sets `action.includeSelf`), with a hint on why self-caused events are skipped by default.
- [web] Automation rows note "including your own events" when it is set.

## Feature

Automations can now also fire on events you cause yourself, so you can test your own automation by posting.
