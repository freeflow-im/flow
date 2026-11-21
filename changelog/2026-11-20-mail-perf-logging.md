# Mail and Calendar timing logs

- `[server]` Mail and Calendar requests log one structured record each (route, status, lock wait, IMAP time, cache,
  ray id, isolate age) and answer with a `Server-Timing` header.
- `[server]` `POST /v1/perf` logs the browser's timings of what a person did, with the calls made meanwhile.
- `[web]` Mail times page load, list loads, opening a conversation, attachment previews and invitation cards, and
  sends them by beacon. How to read it all: `scripts/perf/README.md` § Stored logs.
