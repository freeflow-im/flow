# After the Cloudflare cut-over: tidying up

- `[edge]` `/v1/ws?workspace=<id>` is refused (404) for an organization nobody belongs to, before an object is woken or made (Directory `organizationKnown`).
- `[edge]` `scripts/check-front-door.mjs` checks the per-organization socket the way the Worker serves it (an HTTP/1.1 upgrade, no credentials) instead of the old server's `/v1/ws`.
- `[infra]` `docs-aws-deploy.yml` is removed: the Workspace app ships with the suite's image and the Worker; it failed on every push.
- `[docs]` The cut-over runbook says what was run and what is left; decision log: the ChatGPT plugin stays on AWS.
