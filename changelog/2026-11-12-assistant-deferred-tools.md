# Assistant: deferred tools behind tool search

- `[server]` The live assistant loads only a few tools per page (files, plus the open page's main tools) and finds the rest with the provider's tool search (Claude `tool_search_tool_bm25`, OpenAI `tool_search`); Docs drops from ~95 loaded tools to ~8.
- `[server]` OpenRouter turns still load every tool: its Chat Completions API has no tool search.
- `[server]` A tool an earlier search loaded but this turn does not offer gets a deferred stand-in, so the history stays valid; `pause_turn` now continues the turn.
- `[server]` A search held open beside a browser tool is closed unrun when the user writes before the turn ends (the API refuses text after the results while it is open).
