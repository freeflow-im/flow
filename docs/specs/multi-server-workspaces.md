# Multi-server workspaces

Status: Draft proposal · 2026-09-09
Platforms: web, macOS, iOS

## Outcome and scope

A person can add a workspace hosted on another Flow backend, authenticate with
that server, and use it alongside existing workspaces in the same client.
(Slack workspaces were part of this proposal until 2026-11-01; the Slack
provider was removed for the FreeFlow suite, docs/specs/freeflow-suite.md §2.0.)
Switching workspaces automatically selects the owning backend and identity.
Signing out of or losing connectivity to one backend does not affect others.

Example: Scott uses Product on app.freeflow.im and Research on flow.example.com.
He signs in separately to each server, potentially with different email addresses.
Both workspaces appear in the switcher. Messages, uploads, search, unread counts,
and huddles always use the selected workspace's server and account.

Required by this feature: additional servers and independent authentication on
all three clients. The remaining decisions below are proposed defaults, subject
to product review; this document does not describe shipped functionality.

V1 supports one signed-in account per Flow server per client profile, and multiple
selected workspaces from that account. It does not federate servers, move existing
workspaces, merge identities, share membership, or provide cross-server search
or DMs. Adding a workspace means connecting to its existing host, not changing
where the workspace's data lives. Connection settings are local to each device
or browser profile in V1.

## User experience

The workspace switcher lists all added workspaces, grouped by server, with a
server hostname and signed-in account visible in each group. Duplicate workspace
names remain distinguishable. Each workspace shows its own unread indicator;
each server group can show Offline or Sign in required.

**Add workspace** offers the current server's workspaces and **Connect another
Flow server**. The Flow server option accepts a server URL or Flow workspace
invite URL:

1. Normalize the address and check that it is a compatible Flow backend.
2. Display the destination hostname before asking for credentials. Backend names
   and logos are supplemental; they cannot hide the actual destination.
3. Authenticate using that server's advertised sign-in methods. Do not prefill or
   submit another server's password or session. Existing provider browser sessions
   may simplify provider login, but the backend still issues its own Flow session.
4. List workspaces available to that identity; select one or more to add. An invite
   instead completes the join on its issuing server before adding the workspace.
5. Select the newly added workspace. Canceling leaves existing connections intact.

An already connected origin reuses its session and opens its workspace chooser.
If the account belongs to no workspaces, show the server's supported create/join
options, or an explanation that membership is required. Adding a connection does
not imply permission to create a workspace or register an account.

Switching restores that workspace's navigation, drafts, and scroll position.
An unavailable server shows its cached workspace with an offline state; other
servers remain usable. V1 does not introduce offline mutation queues. A session
expiry shows a server-specific sign-in action and preserves workspace labels,
but authenticated cached content is hidden until sign-in succeeds.

Connection management distinguishes:

- **Hide workspace:** remove its local switcher entry; do not leave membership.
- **Sign out of [server]:** revoke that session when reachable, clear its local
  credentials and private caches, and keep server/workspace labels for sign-in.
- **Remove server:** perform local sign-out cleanup and remove its entries.
- **Leave workspace / Delete account:** existing server-side actions, scoped to
  the explicitly displayed server and identity. Never reinterpret these as local
  removal. Account deletion affects all of that account's workspaces on that server.

If remote revocation is unavailable, local sign-out still completes; do not
claim the remote session was revoked. Signing back in as another user clears the
previous identity's workspace bindings and loads the new user's memberships.

## Connection and identity model

Persist a versioned connection registry, without embedding credentials:

| Record | Required fields |
| --- | --- |
| ServerConnection | local connectionId, provider (`flow`), provider identity, canonical origin/transport endpoint, display label, API/capability version |
| ServerSession | connectionId, server-issued userId, credential reference, auth generation, status |
| WorkspaceBinding | connectionId, userId, workspaceId, cached name, local visibility/order |
| NavigationTarget | connectionId, userId, workspaceId, optional channel/message/thread/artifact ids |

For Flow connections, canonical origin includes scheme, lowercased hostname, and effective port.
Normalize default ports and trailing slash. V1 requires an origin-root deployment;
reject userinfo, query strings, fragments, and non-root paths in server address
input (parse known invite links separately). Require HTTPS in release clients;
HTTP loopback is an explicit development allowance. Do not bypass certificate
validation. Private-network HTTPS deployments are allowed when reachable, subject
to browser/OS network permissions. Redirected discovery never silently changes
which server receives credentials: display and confirm the destination first.

The local connectionId is stable and is not an authentication claim. A server
cannot declare itself equivalent to another connection through discovery metadata.
Changing an origin creates a new connection in V1; server migration is separate.
Never assume UUIDs are globally unique across independent or cloned databases.

Every credential, cache key, object URL, database, sync cursor, navigation entry,
draft, notification, and read marker is scoped by connection and identity. Workspace
resources add workspaceId. Token replacement increments auth generation so a late
401 from an old request cannot invalidate a newly authenticated session.

## Runtime architecture

Introduce a ConnectionManager that owns a session runtime per connection. Each
runtime owns an API client, authenticated socket/sync state, caches, and current
identity. Views receive an explicit workspace context referencing that runtime.
An operation captures its context when started; switching workspaces must never
retarget an upload, pending send, read receipt, or response to another server.

REST, WebSocket, avatar/blob fetches, presigned-upload fallback paths, downloads,
link previews, mini-app tokens, and huddle credentials must all use this context.
Relative API/media URLs resolve against the owning backend, not the web page's
origin. Only attach the backend bearer to that exact origin; never to external
presigned storage URLs or cross-origin redirects. API helpers accept relative API
paths, not arbitrary authenticated absolute URLs.

Maintain background synchronization for connected sessions while web/macOS is
running, using the existing subscription model for added workspaces. Reconnect
backoff, rate limits, errors, and authorization failures are independent per
connection. iOS follows its existing foreground/background lifecycle and uses
push when suspended. No continuously running background sockets are promised.
Bound concurrency and reconnect with jitter; avoid eager transcript downloads for
all workspaces. Aggregate switcher unread state from per-connection values.

Support independent selected workspaces in native windows and browser tabs.
Sign-out propagates to other windows/tabs for that connection only. Dispose its
sockets, queries, object URLs, databases/caches and pending operations on removal.
Late responses must not recreate removed state.

Keep one joined huddle per client instance in V1. A workspace switch may leave the
existing huddle running with its original context and a visible return control.
Joining another requires the existing leave/join transition. Huddle invitations
and notification actions must carry the owning connection context.

## Flow backend and browser contract

Add an unauthenticated, versioned `GET /v1/client-info` discovery endpoint. Proposed
response: protocol version, display name, supported auth methods, registration
availability, and capabilities for browser connections, auth handoff, and push.
Keep REST and socket routes on the entered origin in V1. Expose no secrets or
private workspace list. Unknown optional capabilities are ignored; incompatible
protocol versions give an actionable error before authentication.

Existing login and membership endpoints remain authoritative. Password, email-link,
Google, and Apple are enabled only when supported/configured by that backend.
Provider configuration belongs to the target backend; it must validate the correct
audience and issuer. Do not assume the primary deployment's OAuth configuration
works for independently operated servers.

For Flow providers, web connects directly from its hosting origin to each backend. Add operator-managed
allowed web origins with exact-origin CORS handling, OPTIONS support, appropriate
methods and headers (including Authorization and Content-Type), and Vary: Origin.
Apply this to discovery, authentication, APIs, and proxied media. Use bearer auth
without ambient cross-origin cookies. Validate browser WebSocket Origin separately;
CORS is not a WebSocket authorization mechanism. Native clients continue to require
authentication even though they do not use browser CORS.

The web client's deployment CSP must permit supported HTTPS/WSS destinations and
required media; align storage CORS for presigned uploads too. A backend rejecting
the web origin is reported as a browser-connection configuration problem, with
operator guidance. Do not add a central server proxy for arbitrary backend URLs.
Browser mixed-content or private-network restrictions may make a backend usable
only from native clients; describe the actual failure instead of reporting bad
credentials.

For provider or email authentication that opens the backend's web page, extend the
existing app-link handoff into a connection-bound flow: client-generated state and
PKCE challenge, short-lived single-use authorization code, exact allowlisted return
destination, and verifier-bound exchange against the initiating origin. Bind state
to connection, origin, and operation; reject unsolicited/mismatched callbacks.
Never place session tokens in URLs. Web popup messages require exact origin and
source checks. Native flow:// callbacks must resolve a pending operation rather
than trust a callback-supplied server URL. Expired email flows may restart sign-in
on the issuing server. Clean callback codes from browser history after handling.

## Notifications and native extensions

For Flow providers, register each device with each authenticated backend separately.
Registration
includes an opaque client-generated routing identifier unique to that connection
and identity; backend pushes echo it. Map it locally rather than accepting a
push-supplied URL. Unknown/removed identifiers cannot add connections or navigate.
Scope notification IDs, deduplication, suppression while viewing, and mark-read
operations to the same connection. Unregister only the relevant registration on
sign-out; ignore stale pushes if remote unregister failed.

Independent backends cannot each write a correct global `aps.badge`: the last push
would overwrite the others. V1 multi-server registrations request alert delivery
without a backend-owned absolute badge. The client aggregates last-known counts
when running and reconciles on foreground. An exact aggregate icon badge while iOS
is suspended is explicitly not guaranteed; no central push aggregator is proposed.
Legacy registrations retain existing behavior. Decide whether this badge limitation
is acceptable before implementation is considered ready for release.

The iOS share extension reads the registry from the app group, shows workspace
and hostname, and loads only the selected connection's Keychain credential. It
must not fall back to the build-time default server. Audit notification extensions,
attachment downloads, deep links, and native windows for the same assumption.
Custom servers without configured APNs delivery advertise that limitation; the
client does not promise background notifications for them. Sharing production APNs
credentials with arbitrary backend operators is outside this feature.

## Current implementation and migration

Observed starting points:

- Web `packages/web/src/lib/api.ts` has one `flow.token`, same-origin fetches,
  and path-only blob/text caches. `packages/web/src/App.tsx` owns one user and
  workspace selection; sign-out clears the shared query cache.
- Native `apps/macos/Sources/Flow/Support/Server.swift` resolves a static backend.
  Its storage suffix already separates some deployments but is not a connection
  registry. `Keychain.swift` uses a static profile-specific account.
- Native `Networking/APIClient.swift` already accepts a base URL internally;
  `App/AppState.swift`, `Database/AppDatabase.swift`, and `Sync/SyncEngine.swift`
  need session ownership audited. Shared sources also serve iOS.
- `Support/PushPayload.swift` routes using workspace/channel/message IDs and
  currently treats the badge as a single server-authoritative total.
- Server `routes/index.ts` contains login/provider and app-link endpoints;
  `gateway/upgrade.ts` routes socket upgrades.

On first upgrade, create a default connection from the current web origin or native
configured server. Migrate the existing token, selected workspace, and identity to
it after validation. Native migration reads the exact legacy profile storage slot;
preserve QA profile isolation. Use a crash-safe, idempotent migration marker and
retain the old state until the new state is committed. Unknown cache ownership is
discarded and refetched, never assigned to another connection. Never copy a token
to additional origins. Older backends remain usable as the existing default;
adding remote Flow backends requires the new discovery/connection contract.

## Delivery and acceptance

1. Shared contract and server discovery/CORS/handoff/push changes, preserving
   current clients. Document operator setup and the supported protocol version.
2. Explicit session runtimes and storage isolation; migrate the existing single
   connection without changing ordinary use.
3. Add/manage/switch UI on web, macOS, and iOS; native share/deep-link integration.
4. Multi-server sync, notification routing, failure cases, and parity verification.

Acceptance uses two independent backends with deliberately overlapping user,
workspace, channel, and file IDs, and different credentials/content:

- Both accounts stay signed in across restart; same email never links identities.
- Switching sends every request/socket event to the correct server. Delayed sends,
  uploads, responses, and old-session 401s cannot cross contexts or resurrect state.
- Cached images, drafts, search, unread counts, and navigation remain isolated,
  including two windows/tabs showing different servers.
- Expire, disconnect, sign out, delete an account, and remove membership on A;
  verify B remains usable and its state intact. Reauthenticate A as a different user.
- Exercise each advertised auth method, invite links, canceled and mismatched
  callbacks, replayed codes, and a backend with registration disabled.
- Validate allowed/rejected web origins, preflights, WS origin policy, external
  storage uploads, and no bearer forwarding across origin/port/scheme changes.
- Push and share-extension actions select the correct connection despite duplicate
  IDs; stale pushes after removal are ignored; badge behavior matches this spec.
- Upgrade existing profiles and interrupt migration midway; no lost session or
  credential reassignment. Verify all three clients against a legacy default server.

Product decisions to confirm: one account per Flow server in V1; local-only connection
configuration; all connected servers syncing while the client is running; and the
iOS background badge limitation. These defaults keep the core per-workspace
experience complete without introducing server federation or central identity.
