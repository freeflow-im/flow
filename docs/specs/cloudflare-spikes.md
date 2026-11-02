# Cloudflare migration: the two spikes

Steps 0.3 and 0.4 of `cloudflare-migration.md`, run on 2026-11-02. All of it ran locally in `wrangler dev`, which runs
workerd, Cloudflare's own runtime. Timings show relative cost and are not production latencies, and nothing has run on
Cloudflare's network yet. The prototypes were throwaway and are not in the repository.

## Spike A: the socket topology

**Ruling proposed: one client runtime for the suite, with one socket per organization at `/v1/ws?workspace=<id>`.**

The plan assumed each edge organization could look like "another server" to the client. Reading the client, it cannot
cheaply. A `ConnectionRuntime` is one origin and one token, and every organization here shares one origin and one
session, so "another server" would mean a host name and a sign-in per organization. What the client does already have
is a socket for each connection, kept alive in the background and started under a concurrency limit
(`backgroundSync.ts`). So one runtime holds a socket for each of its organizations, and events already carry the
organization's id. The alternative, a per-user object fanning out, was rejected: outbound WebSockets do not hibernate
(an open one keeps its object in memory for up to 15 minutes), and over RPC every message would wake one object per
recipient.

Measured: one object, SQLite-backed, using the client's real frames (`auth`, `hello`, `event`, `ping`, `pong`).

| Measure, 300 sockets on one object | Result |
|---|---|
| Connect and authenticate all of them | 274 ms |
| Message written and delivered to all, object awake | 7–11 ms |
| The same from hibernation, including waking it | 22 ms |
| Wakes caused by 500 auto-answered pings over 20 s | 0 handler calls, 1 hibernation cycle observed |
| Socket's attachment (who it is) after hibernation | present |
| 10,000 message inserts, then the latest 50 of a channel | 47 ms, then under 1 ms; 2.4 MB |

**The heartbeat conflicts with hibernation, which the plan missed.** Flow's server sends `{op:"ping"}` every 30 s, and
web and macOS drop a socket after 70 s of silence. The server can only start a ping from an alarm or a timer, and those
wake the object. In the test, alarms 3 s apart kept the object from ever hibernating. At 30 s it would sleep between
pings, at about 10 s of each 30 awake. Estimated from the published prices, with 128 MB billed per object:

| Per organization, per month | Duration | Cost above the included 400,000 GB-s |
|---|---|---|
| Hibernating with client pings | Only when there is real traffic | Effectively nothing |
| Server pings by alarm every 30 s, while anyone is connected | About 110,000 GB-s at most | About $1.40 at most |
| Awake all the time | About 332,000 GB-s | About $4.15 |

**Ruling proposed: clients ping, the runtime answers.** A client that says so in its `auth` frame sends `{"op":"ping"}`
every 30 s and gets `{"op":"pong"}` from `setWebSocketAutoResponse`, without waking the object. The object runs its
30 s alarm only while a socket that has not said so is connected, so old native builds keep working and cost a little
more until they update. Whether an auto-answered text frame counts as a billed message is not clear from the pricing
page; at 20 messages to a request it is small either way, and the rehearsal should check it.

**What this requires of the native apps.** A macOS or iOS build that opens one `/v1/ws` per server sees no events from
an organization on the edge. The native apps therefore need the socket-per-organization change before an organization
with native users moves. The first organization moved should be one with none.

**Sessions.** A socket authenticates in its first frame, so the object asks the directory once and keeps the answer in
the socket's attachment (16 KiB at most; it survives hibernation but not a close). Signing out or removing a member
therefore has to reach the object, which closes that user's sockets: the directory calls each organization the user
belongs to.

## Spike B: Docs' libraries on Workers

Each ran real work inside workerd with `nodejs_compat`. Sizes are one library's gzipped bundle.

| Library | Result | Size | Decision |
|---|---|---|---|
| `exceljs` | Wrote and read back an `.xlsx` | 1.1 MB | Worker |
| `xlsx` | Wrote and read back | 0.6 MB | Worker |
| `pptxgenjs` | Wrote a `.pptx` | 0.4 MB | Worker |
| `jszip` | Round trip | 0.1 MB | Worker |
| `fast-xml-parser` | Round trip | 0.1 MB | Worker |
| `@cantoo/pdf-lib` | Made and reloaded a PDF | 0.9 MB | Worker |
| `pdfjs-dist` | Read a PDF's text, with its worker imported into the same thread | 3.0 MB | Worker, for plain text |
| `marked`, `unified`, `remark-*` | Worked | 0.3 MB | Worker |
| `prosemirror-*` | Worked | 0.1 MB | Worker |
| `@anthropic-ai/sdk`, `openai` | Built a request and reached the network layer | 0.6, 0.9 MB | Worker |
| `@modelcontextprotocol/sdk` | Registered a tool | 0.6 MB | Worker; its HTTP transport is still to try |
| `@llamaindex/liteparse` | **Fails at load**: it needs a real file path | | A container |
| Tesseract, through LiteParse | Native; not attempted on its own | | A container |
| `sharp` | Native; cannot load | | Cloudflare Images, or resize in the client |
| Playwright and Chromium | Replaced by Browser Rendering, which needs an account to try | | Try at step 5.3 |

| Identity and signing | Result | Decision |
|---|---|---|
| `hash-wasm` argon2id | **Fails**: "Wasm code generation disallowed by embedder" | Not usable; the plan named it |
| `@noble/hashes` argon2id, at 64 MiB, far above Flow's 19 MiB | 411 ms, in JavaScript | Use this for existing hashes |
| `node:crypto` scrypt, N=16384 | 16 ms | Use this for imported Docs hashes |
| WebCrypto PBKDF2, 600,000 rounds | 36 ms | Not needed |
| `aws4fetch` R2 presigning | Signed a URL | Replaces `@aws-sdk/client-s3`, whose presigner is not a Docs dependency |

**What this changes in the plan:**

- **Password hashing costs CPU.** The Free plan's CPU limit per request is far below an argon2 hash, so the paid plan
  is required for this reason. SQLite Durable Objects themselves are available on the Free plan, at 1 GB per object.
- **A container replaces the "small origin service".** LiteParse and Tesseract have to run outside workerd. Cloudflare
  Containers (Workers Paid) run a Linux image started from a Durable Object, so PDF-to-Markdown can move too and step 7
  can really retire AWS. It has not been tried; step 5.3 starts with a trial on a real scanned PDF.
- **Bundle size needs watching.** The libraries above add up to roughly 8 MB gzipped against the Worker limit. Imports
  and exports may belong in their own Worker behind a service binding, which also keeps their load cost away from
  chat. Measure it when 5.2 is built.
- **`node:fs` is the larger part of the Docs port.** 27 server files import the file system or `child_process`. The
  `child_process` ones (`supervise`, `claudeAgent`, `jobs`, `worker`, `git`, `localStore`, `recents`) belong to the
  desktop app and the retired jobs, so they stay out of the Worker. Step 5.1's split has to keep them on the desktop's side.
