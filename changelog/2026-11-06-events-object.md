# The event bus: one append-only log per organization (platform phase 2.1)

- `[server]` New `Events` Durable Object, one per organization: an append-only event log with `seq`, a publisher-set
  audience (organization, private channel, one account), and a 30-day / 200,000-row retention alarm.
- `[server]` The Org object also logs every socket event except presence and typing as `chat.<type>`, with the acting
  member's account as `actor`; member rows now keep their account id (new migration, backfilled at start-up).
- `[server]` Mail publishes `mail.received` for new INBOX mail after a folder's first sync, visible to the account alone.
- `[server]` `GET /v1/events?workspace=&since=&limit=&types=&ref=&channel=` reads the log once, filtered to what the caller may see.
