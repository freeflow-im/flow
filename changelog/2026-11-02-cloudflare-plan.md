# The plan of record: phase 4, then Cloudflare

- `[docs]` `docs/specs/cloudflare-migration.md`: the suite's move to Cloudflare, one Durable Object per organization with its own SQLite and sockets, a small directory for identity, blobs in R2; what each Node piece becomes on Workers, the order (front door, directory, organizations one at a time, files, Docs, the long tail, retire the origin), the limits that shape it, the coding rules from now on, and the open questions.
- `[docs]` `docs/specs/freeflow-suite.md` §3.2 and §8, `decision_log.md`: the end-state ruling, the phase order from here (phase 4, then Cloudflare with Chat first, then Mail and Calendar), the §5 integrations dropped, one object per organization rather than per channel.
