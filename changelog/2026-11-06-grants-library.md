# The grants library (platform phase 3.1)

- `[server]` `@flow/shared` gains `grants.ts`: the `grants` table DDL, principal strings, `effectiveRole` over an object's container chain (owner column, inheritance, expiry), and parameterised SQL for chain lookup, "Shared with me", grant and revoke. No app uses it yet.
- `[server]` `@flow/shared` now has vitest tests, including an end-to-end run on `node:sqlite`.
