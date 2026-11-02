# The suite bar's design: Docs and Chat tabs, the account menu

- `[docs]` `docs/specs/freeflow-suite.md` §2.5 and `decision_log.md`: the bar as designed with the operator (mark, FreeFlow, the organization's name, Docs | Chat, search, Assistant, notifications, account), one top tab per app with its own left column, the "Work" hub rejected.
- `[docs]` §3.2 and the decision log: the suite's end state is Cloudflare with one Durable Object per organization and a small directory; the rules that keep the move cheap (organization as partition key, SQLite as the dialect of record, Postgres and NATS not permanent).
