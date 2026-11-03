# The Worker serves the web-to-app sign-in handoff and the built-in help

- `[server]` `[macos]` `[ios]` `[desktop]` `[web]` The Cloudflare Worker answers `/v1/auth/handoff/start|approve|exchange` (PKCE, same bodies, checks, errors and rate limits as the AWS server), in the directory; `/v1/client-info` reports `authHandoff` from `FLOW_HANDOFF_RETURN_URLS` again.
- `[server]` `[web]` `/v1/help/topics` and `/v1/help/pages/:slug` are back on the Worker: `docs/help` and What's New are bundled at build time (`packages/edge/scripts/help.mjs`), byte-identical to the server's answers.
