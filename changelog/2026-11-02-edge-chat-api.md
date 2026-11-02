# Chat's API on Cloudflare, on the rehearsal host

- `[server]` `packages/edge`: profile edits, avatars, notifications and devices across organizations, scheduled messages on Alarms, slugs unique across organizations. Still only on `edge.freeflow.im`.
- `[web]` A server that offers it gets one socket per organization, with the client sending the heartbeat so that objects can sleep. Against today's server nothing changes.
