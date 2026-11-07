# Docs: a new file is private wherever it is made; shared crumbs hide the owner's folders (platform phase 3.5)

- `[web]` The home page makes a file shared only in Organization files' own list (`newFileShared`), not from Recents, Favorites or Shared with me shown over it; same at `/workspace/` and `/workspace`.
- `[server]` The Worker routes a create that names its organization only in the JSON body to that organization's Docs object, not the caller's first.
- `[web]` A file shared with you shows "Shared with me / <file>" (or the shared folder down), never the owner's folders.

## Feature

- **New files stay yours.** A file you make lands in My files unless you make it inside Organization files, and a file shared with you no longer shows where its owner keeps it.
