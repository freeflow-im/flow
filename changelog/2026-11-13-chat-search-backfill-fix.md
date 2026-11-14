# Chat search finds messages sent before it existed

- `[server]` The background pass that indexes older messages failed on its first batch in production: it bound 200 ids in one statement, past Durable Object SQLite's ~100 variables. Lists now go as one JSON value (`inList`/`json_each`); the pass also starts at every search; newest-first breaks ties by id.

## Feature

- **Chat search now finds older messages too.** Messages sent before search arrived were missing from results; they are found now.
