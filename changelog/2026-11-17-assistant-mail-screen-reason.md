# The assistant's mail screening says why it refuses

- `[server]` A refused message's log line says whether its sender is not on the allowlist or failed the authentication check; for an allowlisted sender, it lists the authentication headers the receiving server wrote.
- `[server]` Authentication-Results comments in `( … )` are removed before parsing, so a `;` inside one no longer breaks a clause.
