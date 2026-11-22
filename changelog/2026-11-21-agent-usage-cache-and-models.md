# Agent AI usage: input split by cache, and usage per model

- `[server]` The per-agent hourly count is per model too and keeps uncached input, prompt-cache writes and reads apart (`_agent_usage`, replacing `_agent_usage_hourly`, whose rows move in as model unknown). The usage API adds `uncachedK`, `cacheWriteK`, `cacheReadK`, each model's totals (`models`) and a `?model=` filter.
- `[server]` Hosted agents record the model that answered; on OpenAI, cached input now counts as cache reads (it was inside input).
- `[bridge]` 0.44.0: reports each turn per model with the three input kinds, from Claude Code's per-result model usage (subagents included, which the main-loop `usage` it read before left out); Codex's `cached_input_tokens` as cache reads, on the configured model. Older bridges' reports count as uncached, model unknown.
- `[web]` Admin › Members › Usage: input is a stacked chart of the three kinds; a By model table and a model filter (All models by default) narrow the totals, charts and table to one model.

## Feature

- **See which models your agents use, and how much is cached.** An agent's Usage page now shows a table of each AI model it used, and a filter to see one model's usage on its own. Input is split into uncached input, cache writes and cache reads, which AI providers bill very differently (cache reads cost far less).
