# Docs tests: the handoff test no longer fails CI after it ends

- `[qa]` `plugin/server/handoff.test.ts` silences the app's background logs and lets the last request settle before teardown; a log arriving while vitest closed the worker failed the whole Docs run ("Closing rpc while onUserConsoleLog was pending") with every test passing.
