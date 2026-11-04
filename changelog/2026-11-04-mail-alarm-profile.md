# Mail: the alarm's run is profiled, and can be run on demand

- `[server]` A run of the prefetch cache times its synchronous sections (inserts, the flag diff, trims, body parsing and storing, evictions, the body queue) into `mail_state.alarm_profile` as it goes; `GET …/debug/cache` answers it with the table row counts and the database size, and `POST …/debug/alarm` runs the cache once now for the account's owner, alarm or not.
