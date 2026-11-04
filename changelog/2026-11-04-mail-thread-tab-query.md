# Mail: a tab's conversations page no longer scans the inbox-tabs cache

- `[server]` The query behind `GET …/threads?category=` joined the folder's threads to `mail_categories` in an order that made SQLite scan every cached category row of the folder (tens of thousands on a long-used inbox) and re-run the GROUP BY for each: 30 s of CPU, the Durable Object reset by the runtime, and every request in flight a 500. The threads are now materialized first and each one's category found by its key (1 ms on 150k rows); a test checks the query plan.
