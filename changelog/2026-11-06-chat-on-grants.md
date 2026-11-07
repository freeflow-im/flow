# Channels as principals, and one access function for Chat (platform phase 3.4)

- `[server]` `org/access.ts`: `accessOf` / `requireRole` answer every artifact and file check (and the app-token mint) through `effectiveRole`; channel membership is an implicit `editor` grant, so members see no change.
- `[server]` Explicit artifact grants (`grants`, migration 0004): `GET/PUT /v1/artifacts/:id/grants`, `DELETE …/grants/:principal` for `account:`, `channel:` and `org`; a grantee opens the artifact by id, and each change feeds the share index.
- `[server]` A folder moved in Docs re-keys the share index: grants under the old ids are revoked, the new ones given without a second notice.
- `[web]` The address in a share notice (`file_shared`) is a link.

## Feature

- **Share an artifact with someone outside its channel.** They can open it from the link in the notice they get, without joining the channel.
- **Share notices are links.** The address in "Ann shared … with you" now opens what was shared.
