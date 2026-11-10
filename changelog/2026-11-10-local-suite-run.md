# Run the whole suite locally with one command

- `[qa]` `pnpm dev:suite` (`scripts/dev-suite.mjs`): builds the clients for their base paths, assembles `packages/edge/public`, writes `.dev.vars` once and starts the Worker on localhost:8787 with production's hostname vars set for localhost. The backend has been one process since the move to the Worker; the only recipe was in the e2e tests' comments.
- `[qa]` BUILD.md "Local development" rewritten around the Worker: one-URL suite, hot reload per client, and the Node server + Postgres + NATS moved to "the origin stack", needed only to work on the server itself.
- `[web]` Docs' Vite dev server takes `DOCS_API` (the suite's Worker instead of the standalone server on 3001) and `PORT`, so it can run beside Chat's, which also defaults to 5173.
