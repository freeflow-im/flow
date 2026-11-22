# Agent AI usage: input split into uncached, cache writes and cache reads

- `[server]` The per-agent hourly count keeps uncached input, prompt-cache writes and reads apart (new columns, added in place); the usage API returns `uncachedK`, `cacheWriteK`, `cacheReadK` beside `inputK`. Rows from before the split count as uncached.
- `[server]` Hosted agents on OpenAI now report cached input as cache reads (it was inside input).
- `[bridge]` 0.44.0: reports the three kinds per turn (Claude Code's cache fields; Codex's `cached_input_tokens`). Older bridges' reports count as uncached.
- `[web]` Admin › Members › Usage: input is a stacked chart of the three kinds, with a legend, a tooltip per column, and the totals and table split the same way.

## Feature

- **See cached tokens apart.** An agent's Usage page now splits input into uncached input, cache writes and cache reads, which AI providers bill very differently (cache reads cost far less).
