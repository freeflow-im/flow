# FreeFlow on Cloudflare: the migration plan

The end state ruled on 2026-11-02 (`freeflow-suite.md` §3.2, `decision_log.md`): the suite runs on Cloudflare
with no central database. Each organization is one Durable Object holding its own SQLite and its live
connections; blobs are in R2; a small directory holds identity. This page is the plan for getting there from
the AWS instance the suite runs on today, one bounded context at a time, with both stacks serving during the
move. It comes after phase 4 (Docs respecting the current organization) and before Mail and Calendar.

## 1. The shape

```
                    ┌────────────────────────────── Cloudflare ──────────────────────────────┐
  app.freeflow.im → │ Worker "suite"                                                          │
  docs.freeflow.im   │   static assets: the web client (Chat + Docs)                           │
                    │   Hono router: /v1/*, /api/*, /mcp, /oauth/*                            │
                    │      ├─ Directory DO (one): users, sessions, identities, memberships,   │
                    │      │                       invites by email, app-link codes           │
                    │      ├─ Org DO (one per organization): members (profile copies),        │
                    │      │     channels, messages, reactions, pins, notifications, files'   │
                    │      │     and documents' metadata, folders, public links, assistant     │
                    │      │     conversations, presence, unread; its WebSockets (hibernating) │
                    │      └─ R2: blobs (attachments, document bodies, uploads, avatars)       │
                    │   Browser Rendering (PDFs) · Email (Cloudflare) · Cron Triggers · Queues │
                    └─────────────────────────────────────────────────────────────────────────┘
                              ▲ during the move: paths not yet ported are proxied to the AWS origin
```

- **Directory DO.** One object, keyed by a constant. Tables: `users` (id, email, display name, avatar key,
  password hash, status), `sessions` (token hash → user, kind, client), `oauth_identities`, `memberships`
  (user → organization ids with role), `invites`, `app_link_codes`, `auth_handoffs`, `email_tokens`. Everything
  that must be found before the tenant is known. Small and append-mostly; its SQLite is well under a gigabyte for
  years. A user's profile edit is written here and pushed to each organization they belong to.
- **Org DO.** One object per organization, keyed by the organization id. Everything the organization owns, the
  rows keyed by `channel_id` where they are channel-scoped and never joined across channels on a hot path, so a
  channel can be split into its own object later for one tenant. Its WebSockets are hibernating: the object
  wakes for a message, writes it, fans it out to the members' sockets, and sleeps. Presence and typing live in
  memory with a storage-backed fallback. Unread counts and the activity feed are local reads.
- **Blobs** keep today's R2 layout with the organization id as the first path segment of every new key; keys
  made before the move are rewritten at migration (a rename is a copy in R2).
- **What is not a DO:** the ChatGPT plugin's OAuth server and MCP endpoint are stateless handlers in the Worker
  over the directory (grants) and the user's organizations (tools); LiveKit stays LiveKit Cloud; the desktop
  app's local mode stays the Node Docs server on the Mac.

## 2. What ports, and how

| Today (Node on the instance) | On Workers |
|---|---|
| Fastify, `@fastify/*` | Hono. The 126 routes in `routes/index.ts` keep their paths and DTOs (`@flow/shared`); the handlers become thin: parse, pick the DO, call it. |
| drizzle over Postgres, 48 SQL migrations | The DO's SQLite (`ctx.storage.sql`), migrations as numbered SQL run on first access of each object. `citext` → `COLLATE NOCASE`; `jsonb` → `TEXT` with JSON functions; `FOR UPDATE SKIP LOCKED` queues → Queues or Alarms. |
| The `ws` gateway + NATS bus | Hibernating WebSockets on the Org DO; no bus, the object is the bus. The multi-server client contract (`shared/backend.ts`) is unchanged. |
| argon2 (native) | argon2 in WebAssembly (`@noble/hashes` has argon2id), or re-hash to PBKDF2/scrypt on first sign-in as the scrypt → argon2 path does today. |
| `sharp` (avatar resize) | Cloudflare Images, or decode in the client before upload. |
| Playwright + Chromium (Docs PDFs) | Browser Rendering API with the same print pages. |
| `node:sqlite` in the Docs server (synchronous) | The DO's SQL is synchronous too: a `DatabaseSync`-shaped adapter over `ctx.storage.sql` lets `sheets.ts`, `files.ts`, `folders.ts` run almost as they are. |
| Files on disk under `DATA_DIR` | R2 for every body; the stores already have a `blob` path (`backup.ts`). |
| `@aws-sdk/client-s3` presigning | R2 bindings in the Worker; presigned URLs for direct upload/download stay (R2's S3 API). |
| APNs pushes (`pushOutbox`) | A Worker fetching APNs over HTTP/2 from a Queue consumer. |
| Cloudflare Email (already) | Unchanged. Inbound community email (`communityEmail`) becomes an Email Worker. |
| Nightly dumps, orphan sweeps | Cron Triggers; each Org DO exports itself to R2 on an alarm. |
| LiteParse / Tesseract (PDF text, OCR in Docs import) | Stays on a small origin service until a Worker-side equivalent is chosen; proxied, like any path not yet ported. |

## 3. The order: one context at a time, both stacks live

Cloudflare goes in front of `app.freeflow.im` first (orange cloud, the Worker on the zone). Every path is
proxied to the AWS origin until its context is ported; a ported context answers in the Worker. The clients do
not change for this; they keep calling the same paths on the same origin.

1. **The front door.** Worker with the static clients and a catch-all proxy to the origin. Nothing moves yet.
   Caddy on the instance keeps its certificates for the proxied traffic. This step also ends the few seconds of
   502s on deploys, as the Worker can retry the origin.
2. **The directory.** `users`, `sessions`, identities, memberships, invites, app links and handoffs move into
   the Directory DO; sign-in, sign-up, OAuth, the session cookie and bearer, `/v1/me` answer from the Worker.
   The origin reads sessions from the directory through a private route (or the Worker passes the user in a
   signed header to the origin) so everything still proxied keeps working. Migration: a one-time import from
   Postgres, then a short write-freeze and re-import at the switch.
3. **Organizations, channels and messages**, the heart: the Org DO with its sockets. Per organization, not
   all at once: a flag on the organization says whether it lives in the object yet; the Worker routes by it.
   Migrate the smallest organization, run it for days, then the rest in batches. Messages' encryption key stays
   the data key; the object decrypts on read as the server does now.
4. **Files and artifacts** (chat attachments, mini apps, task boards) into the same object; blobs re-keyed.
5. **Docs** into the same object: the Docs stores over the SQL adapter, bodies to R2, PDFs to Browser Rendering,
   the ChatGPT plugin's OAuth and MCP as Worker handlers, the assistant's loop as a Worker calling the model
   providers (its browser tools are unchanged; its server tools call the object).
6. **The long tail:** scheduled messages and pushes (Queues), unfurls (a fetch with a cache), huddles' server
   side (LiveKit tokens, in the Worker), community email (Email Worker), help pages (static).
7. **Retire the origin.** The instance keeps only the desktop app's release build until that moves to CI; then
   the stack is deleted and Postgres, NATS and Caddy with it.

Each step has a rehearsal on a copy, a switch, and a rollback that is the flag flipped back while the origin's
data is still current (steps 2–4 keep writing through to Postgres during their first week, so rollback is a
flag, not a restore).

## 4. Sizing and limits that shape the design

- A Durable Object is single-threaded: one organization's requests serialize. Thousands of requests a second
  and tens of thousands of hibernating sockets per object; far beyond a tenant of a few hundred people.
- 10 GB of SQLite per object; blobs are in R2, so metadata alone has to fit, which it does by a wide margin.
- A Worker invocation has CPU time limits (ms per request on the paid plan, more for DOs); long jobs (a big
  Office import, a PDF of a long deck, the assistant's turns) run in a DO, a Queue consumer or Browser
  Rendering, never inline in a request.
- Objects live in one location each; an organization's object sits near where it was first touched. Users on
  the other side of the world pay one round trip per request; fine for chat, and the sockets are long-lived.
- No file system: every library that reads or writes files (LiteParse, Tesseract, some of the Office importers)
  is checked before step 5; the ones that cannot run stay on a small origin service behind the proxy.

## 5. What the code does from now on (the rules of §3.2, as checklists)

- A new table or column in Flow carries `workspace_id` unless it is identity; in Docs every row carries the
  organization id from phase 4 on.
- SQL is written to run on SQLite and Postgres both: no `citext` (compare with `LOWER`), no `jsonb` operators
  (store text, parse in code), no `FOR UPDATE SKIP LOCKED` in new code (queues go through the existing
  `pushOutbox`-style tables with a claimed-at column).
- Services take their store through a small interface, so the Worker can hand them the object's SQL and the
  Node server its Postgres. `services/auth.ts`, `users.ts`, `workspaces.ts` first: they become the directory.
- Nothing new on NATS; `publishEvent` stays the one seam, and an in-process emitter replaces it when
  `NATS_URL` is unset.
- The clients keep the multi-server contract (`shared/backend.ts`): a Cloudflare suite is just another backend
  to them, which is what lets the Electron and native apps follow without a rewrite.

## 6. Open questions, to settle before step 2

- **Where private files live**: ruled with phase 4 (2026-11-02): My files is per organization, so a private file
  lives in its organization's object with a private flag; no per-user object. Files from before organizations
  are assigned to one at migration.
- **Direct messages across organizations** do not exist in Flow today; keep it so.
- **Search**: SQLite FTS5 inside each object (messages and file names), per organization. Cross-organization
  search is a fan-out over the user's objects; probably never needed.
- **The data key**: one key for all tenants as today, or a key per organization wrapped by a master, which
  the per-object layout makes natural. Decide at step 3.
- **Billing and limits** per organization become trivial to meter inside the object; out of scope here.

## 7. The steps, as pull requests

Each step is one or a few PRs on `main`, deployable on its own, with the previous step live. Where a step
needs a decision, a short spike comes first and its result goes in `decision_log.md`.

**Step 0, before any of it (after phase 4 merges).**
- 0.1 `packages/edge`: the Worker package. Hono, TypeScript, `wrangler.toml` with the zone routes for
  `app.freeflow.im` and `docs.freeflow.im`, bindings declared but empty, a `deploy-edge.yml` workflow
  (`wrangler deploy` on main with an API token in the repo's secrets). Deploys nothing that answers yet.
- 0.2 Cloudflare account: Workers paid plan (Durable Objects with SQLite need it), R2 already there, the
  `freeflow.im` zone already on Cloudflare DNS. An `origin.freeflow.im` A record for the instance, DNS only,
  so the Worker has a name to proxy to; Caddy serves it with its own certificate.
- 0.3 Spike A, the socket topology: one client socket per organization (the multi-server runtime already
  keeps one connection per server, so an organization on the edge is "another server" to it) versus one
  socket into a per-user session object that fans out. Decide with a day's prototype; the first is simpler
  and the plan assumes it.
- 0.4 Spike B, Docs' libraries on Workers: LiteParse, Tesseract, `exceljs`, `pptxgenjs`, `@cantoo/pdf-lib`,
  `sharp`. Each either runs in a Worker, runs in Browser Rendering, or stays on a small origin service.
  A list with one line each.

**Step 1, the front door.** (one PR, then a DNS change)
- 1.1 The Worker serves the static clients (`packages/web/dist`, the Docs client under `/workspace`) and
  proxies every other path to `origin.freeflow.im`, including WebSocket upgrades on `/v1/ws` and the
  plugin's paths, with the client's IP and host forwarded.
- 1.2 `app.freeflow.im` and `docs.freeflow.im` move to the Worker (orange cloud). Everything behaves as
  before; deploys of the origin no longer show 502s because the Worker retries.
- 1.3 Rollback: grey cloud, the records back to the instance.

**Step 2, the directory.** (three PRs)
- 2.1 Identity behind an interface: `services/auth.ts`, `users.ts`, the membership queries of
  `workspaces.ts`, `oauthGoogle/Apple`, `handoff`, `appToken` take a `DirectoryStore`; the Node
  implementation is today's Postgres code. No behaviour change. `pushOutbox`-style tables are not identity.
- 2.2 The Directory Durable Object in `packages/edge`: its SQLite schema and migrations, the
  `DirectoryStore` implementation over `ctx.storage.sql`, argon2id through WebAssembly (`hash-wasm`), the
  scrypt check for imported Docs hashes through `@noble/hashes`. The Worker answers `/v1/auth/*`, `/v1/me`,
  `/v1/me/workspaces` (memberships; the organizations' rows still come from the origin until step 3), the
  session cookie and bearer. A one-time import from Postgres (`scripts/import-directory.ts`) and
  **dual-write** from the origin: identity writes on the origin also go to the directory through a private
  Worker route with a shared secret, for the first week.
- 2.3 The origin trusts the Worker for the user: the Worker passes a short-lived signed token (HS256, a
  shared secret) naming the user and session kind; the origin's `requireAuth` accepts it on requests that
  arrived through the Worker and falls back to its own lookup otherwise. Flag `IDENTITY_SOURCE` in the
  Worker (`origin` | `directory`) is the switch and the rollback.

**Step 3, organizations, one at a time.** (the big one; four PRs and a per-organization procedure)
- 3.1 The Org Durable Object: schema for everything in §1 that the organization owns, migrations, the
  event protocol of `shared/events.ts` over hibernating WebSockets, presence and typing in memory. The
  messages, channels, reactions, pins, notifications and scheduled-messages services ported over the
  object's SQL (SQLite dialect; the `SKIP LOCKED` queue becomes an Alarm). Unit tests with `miniflare`.
- 3.2 Routing by organization: the directory keeps `hosted_on` per organization (`origin` | `edge`) and an
  index `channel_id → organization` so a channel route finds its object. The Worker routes
  `/v1/workspaces/:id/*`, `/v1/channels/:id/*`, `/v1/messages/*` and the socket for an edge organization to
  its object and proxies the rest to the origin. The client opens one socket per edge organization (Spike A).
- 3.3 The move tool: an admin route that exports one organization from Postgres (its rows and the blob keys
  it references) and imports it into its object; dual-write from the origin to the object while
  `hosted_on = origin` for that organization, so the switch is only the flag. Rehearse on a copy.
- 3.4 The procedure, per organization: import, dual-write a few days, flip the flag, verify (messages,
  sockets, unread, search, huddles' invites), keep the flag reversible for a week. The smallest organization
  first, then batches, then all. Postgres stays the system of record for organizations still on the origin.

**Step 4, files and artifacts.** (two PRs)
- 4.1 Blob keys gain the organization prefix; the Worker signs R2 upload and download URLs itself
  (`aws4fetch` against R2's S3 API, or an R2 binding with a signed route). The files and artifacts services
  move into the Org object with the rest of its rows; the move tool copies the organization's blobs to their
  new keys.
- 4.2 Avatars and custom emoji: Cloudflare Images for the resize, R2 for the bytes.

**Step 5, Docs.** (four PRs, after Spike B)
- 5.1 On the origin first: split `packages/docs/server/app.ts` into route modules and make the stores take
  their database through the one interface `DatabaseSync` already implies, so the same modules run over
  the object's SQL. No behaviour change; the desktop app keeps `node:sqlite`.
- 5.2 The Docs stores in the Org object (the organization's files, folders, public links, assistant
  conversations, the per-organization My files), bodies and uploads in R2, the Docs routes in the Worker
  under `/api/*`, the revision feed as object events over the same socket.
- 5.3 PDFs through Browser Rendering (the print pages are served by the Worker); Office import and OCR per
  Spike B's list, the ones that cannot run on Workers behind the proxy on a small origin service.
- 5.4 The assistant's loop as a Cloudflare Workflow (an agent turn can run minutes; a request cannot), its
  server tools calling the object, its browser tools unchanged; the ChatGPT plugin's OAuth server and
  `/mcp` as Worker handlers over the directory's grants.

**Step 6, the long tail.** (small PRs as each is reached)
- Pushes: a Queue consumer speaking APNs over HTTP/2. Email: already Cloudflare; inbound community email
  as an Email Worker. Unfurls: a fetch with the Cache API. Huddles: LiveKit tokens minted in the Worker.
  Help pages: static. Nightly: each object exports itself to R2 on an Alarm; a Cron Trigger checks they did.

**Step 7, retire the origin.**
- The desktop app's release build moves to CI (it already is for the Windows and Mac builds; the instance
  is not needed for it), the proxy is removed, the stack deleted with Postgres, NATS and Caddy. The Electron
  shell and the native apps point at the edge, which to them is one more server.

Rough sizes: step 0 a few days (the spikes are most of it); step 1 two days; step 2 one to two weeks; step 3
three to four weeks including the moves; step 4 one week; step 5 two to three weeks; step 6 one week spread
out; step 7 a day. Steps 2 to 5 each end with a rehearsal, a switch and a flag to flip back.
