# Chat at /chat, Docs at /docs

- `[server]` `[web]` Each app's path is its manifest's: Chat moves from the root to `/chat` and Docs from `/workspace` (the tab's first name) to `/docs`. The Worker and the Node origin send `/`, `/workspace` and `/workspace/*` to the new pages (the root with its query kept, so emailed sign-in links, `?next=` and handoffs still land), and the address parser reads links written either way.
- `[web]` The addresses the apps write for Chat's objects, the share and create intents, Chat's home link and Mail's links to Docs follow the manifest; the desktop MCP Docs app's web link too.

## Feature

- **Cleaner addresses.** Chat is now at `/chat` and Docs at `/docs`, so the address bar says which app you are in. Old `/workspace` links and bookmarks still open the same page.
