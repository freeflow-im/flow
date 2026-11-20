# Automations: pick events by app

- [web] Admin → Automations: Event type is a drop-down of every event, grouped by the app that publishes it (installed apps' `app.<name>.*` events included), with a readable name and "Other event type…" for typing one. Catalog in `@flow/shared` `eventCatalog.ts`.
- [server] Mail's manifest now lists `mail.sent`.

## Feature

When you make an automation, the Event type list now shows every event you can listen to, grouped by app, with plain names like "Message posted" or "Task created". Events from apps your organization installed, such as Taskboard, are listed too.
