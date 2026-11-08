# The event bus: subscriptions with a cursor, read by HTTP at any time (platform phase 2.2)

- `[server]` Subscriptions in the Events object: a filter (types, ref, channel, actor kind, text, `self`), a cursor that starts at the log's head, monotonic ack, and a `gap` marker when retention passed the cursor.
- `[server]` `/v1/events/subscriptions`: create, list, read with `wait` long-poll (up to 30 s), ack and delete, as the caller's account; another account's subscription is 404.
- `[server]` A read's `next` is now the last seq examined, so a filtered reader moves past rows it skipped.
- `[server]` `/mcp`: an Events consent group (`events:read`) with `list_subscriptions`, `create_subscription`, `read_events` and `ack_events`.
