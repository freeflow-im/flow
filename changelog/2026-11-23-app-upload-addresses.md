# Hosted apps: one-use upload addresses, so agents can send local files (Taskboard #33)

- `[server]` `ctx.files.uploadUrl(path)`: a signed, one-use, 5-minute address on the app's host
  (`/__freeflow/upload/<token>`); its POST body (≤ 10 MB) goes to that app route as the caller, with scopes rechecked.
- `[server]` Drafts get addresses on their preview host; the SDK guide tells app builders how to offer one.
- `[qa]` `packages/edge/test/e2e-app-uploads.mjs` (22 checks) and unit tests for the route check and the token.

## Feature

- **Agents can attach screenshots from their own computer to Taskboard tasks.** The new `attach_image_upload` tool
  gives the agent a short-lived upload address; it sends the image there and it appears on the card.
