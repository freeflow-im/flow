# The share index, sharing events, notifications and channel cards (platform phase 3.3)

- `[server]` The Org object keeps a share index (`shares`, migration 0003): Docs reports every grant change (`host.onGrantChange`), and `recordShare` / `revokeShare` publish `sharing.granted` / `sharing.revoked`.
- `[server]` A new share with a person is a DM line from the granter that notifies them; with a channel, a `file_shared` card in it; both carry the file's address.
- `[server]` The bus gains the `ref:<reference>` audience, read at each read from the index (and the owner); Docs publishes `docs.file.changed` on save, at most once per file per 30 s.
- `[server]` `GET /v1/workspaces/:id/shared-with-me` lists the caller's shares from the index; the Docs object indexes the link tokens migrated in 3.2.

## Feature

- **Know when something is shared with you.** When someone shares a file or folder with you, you get a notification with a link to it.
- **Shares show in the channel.** Sharing a file or folder with a channel posts a line in it saying what was shared, with its link.
