# The Cloudflare front door (step 1 of the move)

- `[server]` `packages/edge`: the suite's Worker. It serves the clients' built files from Cloudflare and passes everything else to the AWS origin, WebSockets included, and it tries a GET again while the origin restarts. Not live until `docs/ops/EDGE_FRONT_DOOR.md` is run.
- `[server]` The stack's Caddy gains `origin.freeflow.im`, answering only the Worker, once `/flow/EDGE_ORIGIN_SECRET` exists.
- `[server]` Flow's server believes the proxy in front of it (`FLOW_TRUST_PROXY`, set by the stack): rate limits key on the visitor's address, not on Caddy's.
