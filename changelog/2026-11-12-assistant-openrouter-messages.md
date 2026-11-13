# Assistant on OpenRouter: Messages API and deferred tools

- `[server]` OpenRouter turns use OpenRouter's Anthropic Messages API instead of Chat Completions, so they defer tools behind `openrouter:tool_search` like Claude and OpenAI.
- `[server]` A chat that moves between providers no longer fails: another provider's search steps and thinking are taken out of the history (`history.ts`). Switching an OpenAI chat to Claude had failed since the deferred tools shipped.
