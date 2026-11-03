# Pushes and huddles on the Cloudflare Worker

- `[server]` The Worker sends iOS pushes again: each organization's object drains its push outbox from its alarm,
  straight to APNs over `fetch` (ES256 provider token via jose), with the Node server's retries, dead-token disabling
  and multi-server routing. `FLOW_PUSH_DRIVER=apns` plus the APNs secrets turns it on; otherwise the dev driver logs.
- `[server]` Huddles on the Worker: LiveKit tokens are minted in the object, the roster is kept in its SQLite (it
  survives hibernation), `/v1/livekit/webhook` is verified by signature and routed to the room's organization, and
  `/v1/config` reports huddles once the LiveKit settings are set. `/v1/client-info` reports push as the server does.
- `[qa]` Edge tests for the APNs driver, the outbox in an object (over node:sqlite), huddles and the webhook; e2e
  checks a dev-driver push and a huddle join.

## Feature

- **Notifications and huddles are back.** Phones get push notifications for mentions and messages again, and voice
  and video huddles work, once the service's keys are in place.
