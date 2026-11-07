# Manifests: one declaration per app (platform phase 6.1)

- `[server]` `APP_MANIFESTS` in `@flow/shared` declares Chat, Docs, Mail, Calendar and Events once; the Worker's assembler,
  its page routes and the MCP consent page's scope groups read it instead of their own lists.
- `[web]` The four suite bars build their tabs with `suiteTabsFrom` from the manifests; same tabs, order and shortcuts.
