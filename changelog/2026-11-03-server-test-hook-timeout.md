# Server tests: setup has a minute, not ten seconds

- `[server]` The server's tests give their setup hooks 60 s (`packages/server/vitest.config.ts`). The Workspace test's setup, which migrates a database and builds the whole app, took 9.3 s on CI and sometimes went past vitest's default 10 s, failing `main` at random.
