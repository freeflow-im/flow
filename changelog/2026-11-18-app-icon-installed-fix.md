# Apps: the icon route without a version

- `[server]` `GET /v1/workspaces/:id/apps/:name/icon` with no `?v=` answered 500 in production. It now reads the installed version with a plain query, takes the version as an object field, and returns any failure's reason, which is also logged.
