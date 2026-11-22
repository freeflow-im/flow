# Every assistant panel names the agent and shows its model on hover

- `[web]` `[desktop]` Calendar's panel shows the assistant's name, not "Assistant"; Calendar, Docs and the suite panel (Home, Admin, installed apps) get the provider/model tooltip Mail has, on the name or the agent picker.
- `[web]` One tooltip for all of them: `useModelTooltip()` in `@flow/suite-bar/assistant-dock` (drawn over the page, on hover or focus); Mail's Radix tooltip goes.

## Feature

- **Your agent by name, everywhere.** The assistant panel in Calendar, Docs, Home and Admin now shows your agent's name, as Mail's does. Hover over the name to see which provider and model it runs on.
