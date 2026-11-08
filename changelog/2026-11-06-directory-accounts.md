# Directory: organizations, accounts and addresses (platform phase 1.1)

- `[server]` The directory gains `organizations` (owner, policies), `accounts` (one per person per organization, with role, kind and state) and `addresses`; existing memberships are backfilled to `<name>@<slug>.freeflow.im`.
- `[server]` Joins and leaves keep accounts in step with `memberships`: leaving marks the account removed and keeps its address; rejoining reactivates it.
- `[server]` `GET /v1/me` carries the caller's `accounts`, and `GET /v1/me/accounts` lists them.
