# Calendar: sync failures are in the Worker logs

- `[server]` A failed calendar sync logs one record (`sync = failed`: calendar id, account id, mode, error); a delta
  given up for a full listing or read in pages logs why. Before, the logs had only a count.
- `[qa]` `scripts/perf/README.md` § Reading production logs: live tail, stored logs, the Calendar sync records.
