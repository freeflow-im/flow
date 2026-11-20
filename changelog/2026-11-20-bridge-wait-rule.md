# Bridge: agents wait for CI in a way that reports back

- `[bridge]` The system prompt now says how to wait: one blocking `run_in_background` command (e.g. `gh pr checks --watch`), not a cron, scheduled wakeup or detached process, which die with the idle session. Version 0.41.2.
- `[qa]` A bridge runtime test got room for its two runs (it timed out under load).

## Feature

- **Agents that say they will report back on CI now do.** An agent waiting on a build posts in the conversation when it finishes, instead of going quiet.
