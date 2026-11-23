# Meet transcripts: transcribe every session, keep recorded ones

- `[server]` Rooms are created with RTK's `transcribe_on_end` on (older rooms at their next join); turning it on at Record gave empty transcripts in production. Only a recorded session's transcript is saved, as before.
- `[server]` Transcript times: RTK sends clock seconds, not the documented offsets; lines are now timed from the first one.

## Feature

- **Meeting transcripts now have the words in them.** Recorded meetings get a transcript with who said what and when, and an agent you sent writes its notes from it.
