# Flow connection protocol 1: operator and client contract

This is the Flow backend contract for multi-server clients (issue #539). It does
not connect clients to Slack. Existing client releases keep their existing login,
app-link, device registration, and badge behavior. Connection management and the
browser/native handoff UI ship in later phases; these endpoints alone do not add
a workspace switcher to current releases.

## Discovery and deployment

Serve the API, WebSocket, discovery and proxied media at one HTTPS origin root.
Set `FLOW_WEB_URL` to that public origin (for example `https://flow.example.com`).
It is also the canonical server origin bound into handoffs. TLS may terminate at
your ingress; do not rewrite the API to another origin or rely on arbitrary
forwarded headers to establish trust. HTTP loopback is for development only.

`GET /v1/client-info` requires no authentication and returns:

```json
{
  "protocolVersion": 1,
  "displayName": "Research Flow",
  "authMethods": ["password", "email-link", "google", "apple"],
  "registrationAvailable": true,
  "capabilities": {
    "browserConnections": true,
    "authHandoff": true,
    "push": false,
    "pushRouting": true
  }
}
```

`FLOW_SERVER_NAME` controls the label (default `Flow`). Google/Apple appear only
when configured. Password and email-link are built-in; production email delivery
must be configured for links to work. `FLOW_REGISTRATION_ENABLED=0` disables new
email and OAuth registrations, including previously issued signup links; existing
accounts can still sign in. The default is enabled. Membership APIs remain the
authority for accessible workspaces. Discovery contains no workspace list or secrets.

Clients must check `protocolVersion === 1` **before collecting or submitting
credentials**; otherwise show “This Flow server uses an unsupported connection
protocol. Update your client or contact the server operator.” Ignore unknown
optional capabilities, treat missing ones as unavailable, and never treat a display
name as proof of an origin's identity. Do not silently follow discovery redirects
and then send credentials to the redirected origin. Version negotiation and that
message are client responsibilities in phase 2; the server advertises version 1.

`browserConnections` means this server implements the browser contract, not that
every origin is permitted. `authHandoff` is enabled when return destinations are
configured. `pushRouting` means registration/payload support; `push` additionally
requires the APNs driver and key/key ID/team ID configuration. It is a configuration
signal, not a connectivity guarantee. Dev push files are not background delivery.

## Shared message bus

Flow routes realtime events over NATS subjects keyed by workspace and channel
id (`ws.{workspaceId}.chan.{channelId}.msg`). Two deployments on the same NATS
therefore share a namespace, and the spec's warning applies directly: never
assume UUIDs are globally unique across independent or **cloned** databases.
Independently generated ids never collide; a staging database restored from
production collides on every row, and each deployment's events then surface in
the other's clients.

Set `FLOW_BUS_PREFIX` to one token (letters, digits, `-`, `_`) per deployment —
`FLOW_BUS_PREFIX=staging` — or give each deployment its own NATS. Empty is the
default and keeps every subject unchanged, which is correct for a single
deployment. `pnpm qa:up` sets a per-stack prefix automatically, which is what
lets two `--collide` stacks run against one dev NATS.

## Allowed browser origins

Set `FLOW_ALLOWED_WEB_ORIGINS` to a comma-separated list of exact serialized
origins, for example `https://app.freeflow.im,https://research.example.com`.
No wildcards, suffix matching, paths, trailing slashes, or `null`. Scheme and port
matter. The canonical `FLOW_WEB_URL` origin and direct same-origin requests are
accepted automatically; additional origins must be listed. Configure canonical
`FLOW_WEB_URL` even when TLS terminates at a proxy. WebSocket upgrades enforce
the same policy independently, before the authenticated socket handshake. Native
clients without an Origin still require the existing session authentication.
The desktop app's renderer origin, `app://flow`, is accepted automatically as
well (docs/specs/desktop-electron.md), and so is the Android shell's,
`https://flow.localhost` (docs/design/ANDROID.md; `.localhost` is reserved to
loopback, so no site on the network can be it): both are bundled clients like
the native apps, but they send an Origin and get the CORS headers back. A
server older than these changes refuses them at discovery.

The HTTP policy covers discovery, auth, API, and proxied media, including errors.
Allowed preflights return 204 with GET/HEAD/POST/PUT/PATCH/DELETE/OPTIONS and
Authorization/Content-Type/Range. Responses vary on Origin, and preflights also
vary on requested method and headers. A denied origin gets 403
`origin_not_allowed`; unsupported preflight methods/headers get
`preflight_not_allowed`. Browser clients should identify these as operator
configuration failures, not bad passwords.

Use `credentials: 'omit'` with bearer auth; no cross-origin cookie credentials are
allowed. Send a bearer only to the selected backend's exact origin, never to an
external presigned storage URL or cross-origin redirect. Your web deployment CSP
must allow the intended HTTPS/WSS and media destinations. Configure the storage
bucket's own CORS for direct presigned uploads; Flow's HTTP CORS cannot alter the
bucket. Mixed-content and private-network/browser restrictions still apply and
may make a server native-only.

## Connection-bound authentication handoff

Legacy `/v1/auth/app-link` and `/v1/auth/app-link/exchange` remain unchanged for
current releases. New connections must use the separate `/v1/auth/handoff/*`
contract; its codes cannot be exchanged through the legacy endpoint.

Set `FLOW_HANDOFF_RETURN_URLS` to comma-separated exact complete destinations,
e.g. `https://app.freeflow.im/auth/callback,flow://signin`. No query, fragment,
userinfo or wildcard. HTTPS and `flow:` are supported; HTTP is accepted only for
loopback development. Enabling a return destination does not configure browser
CORS: add that browser origin to the allowed origins too.

A client keeps a local pending operation with:

- `connectionId`: local connection identifier, 1–128 characters.
- `operationId` and `state`: independent client-generated random base64url values,
  32–128 characters (use 32 random bytes each).
- `serverOrigin`: the exact originating Flow backend, equal to `FLOW_WEB_URL`'s origin.
- `clientOrigin`: exact browser origin, or JSON `null` for a native client with no Origin.
- `returnUrl`: exact allowlisted destination; browser destinations must belong to
  `clientOrigin`.
- A random PKCE verifier, 43–128 unreserved ASCII characters, kept **only** by the
  initiating client; its challenge is base64url(SHA-256(verifier)).

All bodies are JSON. Responses use `Cache-Control: no-store`.

1. `POST /v1/auth/handoff/start`, unauthenticated, sends all six context fields
   plus `codeChallenge` and `codeChallengeMethod: "S256"`. The request's Origin
   must exactly match `clientOrigin` (absent for native). Returns `requestId` and
   `expiresAt`; the pending request lasts ten minutes. Persist `requestId` with
   the local operation. Start/exchange are rate limited across server replicas.
2. The backend's sign-in page authenticates using its existing password/email/
   provider flow, displays the destination and account for the user's handoff,
   and calls `POST /v1/auth/handoff/approve` with its human bearer session, all
   context fields, and `requestId`. It must pass the original context unchanged.
   Returns `callbackUrl` and `expiresAt`. Approval is single-use and gives the
   code sixty seconds to live. An unknown/expired operation cannot be approved.
   No new UI is included in this server phase; the next client phase supplies
   this sign-in/approval flow.
3. The approved callback carries only `code`, `state`, and `operationId`.
   Resolve an existing pending operation first, compare its state, connection
   and identity generation, and reject unsolicited/canceled/removed operations.
   Do not trust callback-supplied backend addresses. Browser popup messages must
   check both exact `event.origin` and the popup window's `event.source`; clean
   codes from browser history after handling. These are mandatory client checks,
   not something an HTTP server can enforce on a local callback.
4. `POST /v1/auth/handoff/exchange` goes to the original backend, with the stored
   six fields, `requestId`, `code`, and `codeVerifier`. It must have the same
   browser Origin as initiation, or no Origin for native. It returns the usual
   `{token, user}` JSON response. Every binding and S256 verifier is checked;
   code consumption and session creation are one database transaction. Replayed,
   expired, mismatched, and unapproved codes fail. A malformed exchange does not
   consume the valid code. Session tokens never travel in callback URLs.

Codes/operation handles are sensitive, short-lived artifacts: do not log request
bodies, callback URLs, or credentials at your reverse proxy or analytics layer.
Cancellation removes the pending client operation; unused server records expire
and are cleaned opportunistically. Expired email operations restart on the issuing
server. Removing an account prevents its approved handoff from minting a session.

## Provider configuration

`GOOGLE_CLIENT_ID` is this backend's OAuth **web client** audience. Register your
web sign-in origins in Google's configuration. Existing Google verification
checks issuer, audience, expiry and verified email; do not reuse another
operator's audience by assumption. `GOOGLE_CLIENT_SECRET` is not used by the
current identity-token flow. `APPLE_BUNDLE_ID` is the native Apple token audience;
Apple verification uses Apple's issuer and JWKS. The current Apple method is
native identity-token sign-in, not a newly implemented browser Apple OAuth flow.
A backend must be intentionally configured for the clients it serves. Account
matching and membership policies remain local to that backend.

## Per-connection push registration

Authenticate separately to each Flow backend, then send the existing
`POST /v1/me/devices` fields (`token`, `platform: "ios"`, `environment`, `bundleId`)
plus **both** `routingId` and `badgeMode: "omit"`. The routing ID is an opaque
client-generated identifier unique to the connection and signed-in identity:
16–128 base64url characters, preferably 32 random bytes. It is not a URL or an
authentication claim. Both new fields are required together. Store the routing
ID locally with that connection; the existing `{ok: true}` response is unchanged.

Alert pushes echo `routingId`, omit `aps.badge`, and namespace notification
thread grouping by routing ID. Badge-only and background badge corrections are
not sent to these registrations. Clients resolve routing IDs locally, ignore
unknown/removed ones, and scope notification identifiers, taps, dedup, read
operations and suppression to that connection. A push can never add a connection.

Unregister with `DELETE /v1/me/devices/:token?routingId=<stored-id>` while still
authenticated. A stale routing ID cannot unregister a newer registration. Legacy
unregisters without a routing ID affect legacy registrations only. Registration
still rebinds one device token to one user on each backend (V1 is one account per
Flow origin); independent servers have independent registries. Legacy register
bodies omit both new fields and retain absolute badges and token rebinding.

Each independent backend cannot know the global badge. Clients aggregate their
last-known counts when running and reconcile on foreground. An exact aggregate
iOS icon badge while suspended is **not guaranteed**; this product limitation must
be accepted before multi-server client release. There is no central aggregator.

Custom servers need their own authorized APNs delivery configuration:
`FLOW_PUSH_DRIVER=apns`, `FLOW_APNS_KEY` (base64 .p8), `FLOW_APNS_KEY_ID`,
`FLOW_APNS_TEAM_ID`, and an authorized app topic/environment. APNs credentials
must authorize the bundle ID the device registered. Arbitrary operators cannot
send to the official app just by knowing its topic: sharing production APNs
credentials is outside this feature. Without authorized delivery, advertise
`push: false` and do not promise suspended/background notifications. See
[the APNs design](../design/PUSH_APNS.md) for sender setup.
