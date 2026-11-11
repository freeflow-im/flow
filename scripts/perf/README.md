# Suite tab-switching measurements

How long an app takes to show its content after a tab switch (a full page load today), and where the time goes.

## How to measure

1. Sign in at app.freeflow.im in Chrome.
2. Open an app (`/chat`, `/docs`, `/mail`, `/calendar`), then paste `collect-load.js` into the console. It waits for the
   network to go quiet and returns one object: `lcp` (main content painted), `lastCallEnd` (data finished), the calls
   made more than once (`repeated`) and the calls over 400 ms (`slow`).
3. Do each app at least four times, going round the apps, so each load follows about 30 s away from that app.
4. To see the server's side of a slow call, record the Worker's logs while loading:
   `cd packages/edge && npx wrangler tail freeflow-edge --format json > tail.jsonl`. Each event has `wallTime` and
   `cpuTime`; Mail and Calendar also log `[mail] ...` / `[calendar] ...` lines with their object's own time.
   The tail drops events when many arrive together, so a missing event proves nothing.

For one call, the browser's resource timing separates the browser's wait from the server's:
`requestStart - startTime` is time queued in the browser, `responseStart - requestStart` is time waiting for the server.

## Baseline, 2026-11-10 (production, one signed-in user, code already cached)

| App | Main content painted (LCP), 4 loads | Data finished | Calls | Calls made more than once |
|---|---|---|---|---|
| Chat | 0.68–1.02 s | 1.1–4.1 s | 22–33 | `/v1/me/workspaces` x3–4, channels x2–3; some loads fetch everything twice |
| Mail | 0.80–1.10 s | 1.1–1.5 s (3.9 s in one load) | 15 | accounts, folders, tabs, threads: each x2 |
| Docs | 1.35–3.74 s | 2.2–4.3 s | 17–18 | `/api/library` x4 |
| Calendar | 0.98–3.02 s (4.2 s with code not cached) | 0.9–3.6 s | 14–17 | accounts, calendars, shared: each x2 |

What the numbers show:

- A slow load is a stalled call, not slow code: unrelated calls wait 1.8–3.2 s for the server and then answer together.
  In the Worker's logs those calls use 1–4 ms of CPU and their Durable Object events run 20–40 ms, but start 1–2 s after
  the Worker asked. `/v1/me/workspaces` (one Org object per organization, waiting for all of them) is the most frequent.
- A repeated call costs more than its own time: Chrome holds the second identical GET until the first has answered
  (seen as 1.7–3.0 s "queued in browser"), so a duplicate of a stalled call stalls too.
- Docs starts nothing until `/api/auth/me` has answered.
- All calls go over HTTP/2, with no new connections, so connection limits are not the cause.

## Cold starts, 2026-11-10

Signed out, so nothing but the Worker answers: bursts of 12 parallel requests, 36 bursts per target, each timed from the
end of the TLS handshake to the first byte. The test Workers are in `probe/` (deploy one with
`packages/edge/node_modules/.bin/wrangler deploy --config <file>.toml` from a folder that has the libraries, e.g. a
temporary folder in `packages/docs`; delete it afterwards with `wrangler delete`).

| Target | Script size | Reported startup | Slowest answers | Bursts with a stall over 0.4 s |
|---|---|---|---|---|
| `probe/index.js`, nothing in it | 0.3 KB | 1 ms | 0.15–0.30 s | 0 of 36 |
| `probe/static.js`, five heavy libraries loaded at start | 4.7 MB | 67 ms | 0.42–0.55 s | 3 of 36 |
| `probe/lazy.js`, the same libraries behind `import()` | 5.1 MB | 3 ms | 0.43–0.57 s | 3 of 36 |
| The suite's Worker (`/v1/calendar/providers`, a 401) | 21.8 MB | 307 ms | 1.2–2.1 s | 15 of 36 |

- The stall is the Worker's cold start, and it grows with the script's size, about 90 ms per MB.
- Loading a library late (`import()`) does not help while it is in the same script: the two 5 MB Workers stall alike.
- So the fix is a smaller script: minify it (12.0 MB), and move what a page load never uses (the assistant's AI
  libraries, browser control, PDF and Office conversion) to a Worker of its own.
