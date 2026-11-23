# Agents picked in the Build page edit the author's draft

- `[server]` A shared agent picked in the Build page's panel becomes an editor of the open draft; building tools act on
  the drafts the caller may edit, with an optional `owner` to choose. Before, it only edited its own copy.
- `[server]` An editor's `try_tool` runs in the author's dev install with the editor's own access, never the author's.
- `[web]` `[desktop]` The Build page lists the agents that edit the draft, each with Remove.

## Feature

- **Build an app with any agent you choose.** Pick a shared agent in the Build page's assistant panel and it now
  changes your app, and the preview shows its work. The page lists the agents that can edit your app, and you can
  remove any of them.
