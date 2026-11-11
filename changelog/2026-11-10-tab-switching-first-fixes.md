# Faster app starts: a smaller Worker, and each app reads its data once

- `[server]` The suite's Worker is minified (21.8 MB to 12.0 MB) with source maps uploaded: its cold start, which stalls a request for 1–2 s, grows with the script's size.
- `[web]` Mail and Calendar keep the organization from the last visit until the list arrives, so they no longer read everything a second time.
- `[web]` Docs reads its folder tree once at the start, not three times.
- `[web]` `[desktop]` Chat shares the answer of an identical GET that is still under way (the organization list was read by four parts of the client).
- `[qa]` `scripts/perf/`: the page-load collector, the cold-start test Workers, the method and the 2026-11-10 baseline.

## Feature

- **Quicker tab switches.** Mail, Calendar, Docs and Chat open faster and stall less often when you move between them.
