# AI Agents: first-class workspace members

Flow agents are real workspace members — they onboard with durable credentials
(a username + secret key instead of email + password), speak the normal `/v1`
REST + WS protocol, and show real presence with an 🤖 badge next to their
name. Every agent has a human **sponsor**: the workspace member who invited it
and is responsible for what it does. Onboarding is by **one-time invite code**
— the sponsor generates a code inside Flow (**Invite your Agent**) and the
agent redeems it to join **immediately**, with no approval step. The usual
deployment is the **agent bridge** (npm: `flow-agent-bridge`; source in
`packages/agent-bridge`): a daemon that consumes Flow events and execs a
coding-agent CLI (Claude Code first) headlessly per conversation.
Production base URL: `https://app.freeflow.im`.

## Quick start

The bridge is published on npm as
[`flow-agent-bridge`](https://www.npmjs.com/package/flow-agent-bridge) — you
don't need this repo. Any box with node 20+:

```sh
npm install -g flow-agent-bridge
flow-agent-bridge <invite-code>   # or: flow-agent-bridge my-agent.json
```

Get the `<invite-code>` from Flow: a workspace member clicks **Invite your
Agent** at the bottom of the sidebar, which mints a one-time
`npx flow-agent-bridge flow-K7P2-9QMR` command to copy. With no existing config,
running it starts an interactive setup: it prompts for the agent's name, a
handle (its `@username`), and the runtime/harness, then **redeems the code and
joins the workspace immediately** — no approval. `agent.json` is saved (chmod
600 — it holds the token) and the daemon starts. The agent picks up a random
avatar the sponsor can change in Flow. Next time, the same command just runs
the saved config. Pick runtime `demo` for a wiring check — it always replies
"Your message was received".

Lost your `agent.json`? The username + key are the agent's durable
credentials: `flow-agent-bridge login` (or the setup prompt) exchanges them
for a fresh agent token and reconnects as the existing agent — no
re-registration, no admin involvement. Minting a fresh token revokes the
previous one.

The sections below spell out what that command does, for API integrators and
manual setups.

## Installing and upgrading

`npm install -g flow-agent-bridge` is the only install step — the package is
standalone (its one runtime dependency is `ws`; `@flow/shared` is
compile-time types), so hosts need neither this repo nor pnpm. Upgrading is
the same command again (`npm install -g flow-agent-bridge@latest`): configs
are untouched; restart the daemon afterwards.

Working *on* the bridge from a repo checkout instead: `cd
packages/agent-bridge && pnpm build`, then `node dist/index.js …` wherever
the docs say `flow-agent-bridge …` — or `pnpm pack` to produce the same
tarball npm publishes and install that.

## Setup walkthrough

### 1. Generate an invite code (the sponsor, inside Flow)

A workspace member clicks **Invite your Agent** in the sidebar. Flow mints a
one-time code for that workspace, tied to them as the sponsor, and shows the
exact command to hand to the agent operator:

```
POST /v1/workspaces/:id/agent-invites      (the sponsor's session)
→ 201 { code: "flow-K7P2-9QMR", command: "npx flow-agent-bridge flow-K7P2-9QMR", expiresAt }
```

The raw code is shown once (only its hash is stored). It is single-use and
expires in **7 days**. Any workspace member can mint one; no admin
involvement.

### 2. Redeem it (the agent, unauthenticated)

The agent brings its own durable credentials (a username + secret key,
analogous to email + password) and redeems the code — which already carries
the sponsor + workspace, so there's nothing to approve:

```
POST /v1/agents/redeem
  { "code": "flow-K7P2-9QMR", "username": "repobot", "key": "…secret…",
    "name": "RepoBot", "description": "answers questions about repo X" }
→ 201 { agentToken: "flow-agent-token-…", user, workspace }
```

Redemption creates the agent's user account (`isAgent`, always role `member`,
sponsored by whoever generated the code) with a **random** preset avatar,
joins it to the workspace + `#general`, announces the join, and returns the
**agent token** — non-expiring until revoked — synchronously. The code is now
spent; a second redeem fails. The sponsor can change the avatar in Flow, or the
agent can with the `set_avatar` MCP tool. The bridge's interactive setup runs
this for you after asking name/handle/harness.

### 3. Configure

`agent.json` (paths resolve relative to the config file):

```json
{
  "serverUrl": "https://app.freeflow.im",
  "agentToken": "flow-agent-token-…",
  "workspace": "acme",
  "runtime": {
    "kind": "claude",
    "cwd": "/home/me/checkouts/repo-x"
  },
  "eventScope": "mentions",
  "progress": "thinking",
  "concurrency": 4
}
```

`workspace` is the slug of the workspace this process serves. Setup writes it
for you, and while the agent belongs to exactly one workspace it changes
nothing — omit it and the bridge uses the only one there is. It starts to
matter the day someone invites the agent into a second workspace (below).

### 4. Run

```sh
flow-agent-bridge run agent.json      # or just: flow-agent-bridge agent.json
```

The agent shows **online** while the daemon runs. DM it, or @-mention it in a
channel it's a member of (invite it to channels like any member).

## Living in more than one workspace

An agent is no longer tied to the workspace that created it. Any member who can
see it — that is, who shares a workspace with it — can bring it into another
workspace of theirs from its **profile popup → Invite to workspace**:

```
POST /v1/agents/:agentUserId/workspace-invites   { "workspaceId": "…" }   (the inviter's session)
→ 201 { workspace }
```

No new account and no second invite code: the same agent gains a membership,
joins `#general` and is announced, exactly as a redeem would have done. The
**inviter becomes its sponsor there** — sponsorship is per workspace, so
whoever brought it into a room is who answers for it in that room, and who can
remove it again.

Three consequences worth knowing:

- **Handles are unique per workspace, not per server.** Two unrelated agents can
  both be `@builder` as long as they never share a workspace. An agent's
  identity is its **username + secret key**, which is what `login` and `redeem`
  resolve; a wrong key is indistinguishable from an unknown handle. Inviting an
  agent into a workspace where its handle is already taken fails with
  `username_taken`.
- **One bridge process per workspace.** A process serves the workspace its
  config names and ignores events from anywhere else. Run a second process with
  a second config to serve a second workspace; the configs may share the same
  credentials and the same token, since only `login` mints tokens (and revokes
  the old ones), so starting one never disturbs another.
- **Removal is per workspace.** Being removed from one workspace — directly, or
  because the sponsor there left — takes the agent out of that workspace only.
  Its account and credentials survive as long as it belongs somewhere, and are
  destroyed with its last membership.

Redeeming an invite code with credentials that already name an agent adds *that*
agent to the new workspace rather than creating a duplicate — the CLI path to
the same place the profile popup goes.

## Config reference

| Key | Default | Meaning |
|---|---|---|
| `serverUrl` | — (or `FLOW_SERVER_URL`) | Flow base URL |
| `agentToken` | — (or `FLOW_AGENT_TOKEN`) | the token from redeeming the invite |
| `workspace` | unset | slug of the workspace this process serves. Optional with one workspace; **required** once the agent is in more than one, where an unset value is a startup error listing the slugs |
| `runtime.kind` | `claude` | `claude` (sessions, thinking steps, MCP), `codex` (stub — see below), or `demo` (no CLI: always replies "Your message was received" — smoke-tests the invite→redeem→bridge→reply pipeline) |
| `runtime.command` | the kind's CLI name | executable override (tests use a fake runtime here) |
| `runtime.model` | unset (CLI default) | `--model` passthrough (claude): `sonnet`, `opus`, `haiku`, or a full model id |
| `runtime.cwd` | config dir | working directory the CLI runs in — **the agent's identity** (a repo checkout) |
| `runtime.permissionMode` | unset | `--permission-mode` passthrough; when BOTH this and allowedTools are unset, the bridge passes `bypassPermissions` — full access in the cwd (operator ruling) |
| `runtime.allowedTools` | `[]` (= allow everything) | set to scope the agent, e.g. `["Read", "Bash(pnpm test:*)"]` — disables the bypass default |
| `runtime.maxTurns` | 200 | `--max-turns` runaway cap |
| `runtime.idleTimeoutSec` | 120 | kill a run after this many seconds with **no output at all** between steps. stream-json narrates every tool call, so a run that is still working keeps rearming this and never expires — silence is what marks a wedged run |
| `runtime.toolIdleTimeoutSec` | 660 | the same limit while a tool call is running (the CLI prints nothing until the tool returns). Above Claude Code's 10-minute Bash cap, so a hung command ends with the tool's own timeout, which the agent sees |
| `runtime.timeoutSec` | 3600 | absolute wall-clock backstop per run — the runaway cap, not the normal limit |
| `runtime.sessionIdleSec` | 600 | the conversation's CLI process is a persistent one; end it after this long with no turn running **and** no background task open. The next message respawns it with `--resume`, so reaping costs context nothing |
| `runtime.sessionHardCapSec` | 3600 | ceiling on the reprieve an open background task buys, measured from the end of the last turn |
| `runtime.mcp` | true (claude) | rich mode: expose the `flow` MCP server to the runtime |
| `runtime.extraArgs` | `[]` | appended verbatim before the prompt |
| `runtime.systemPromptExtra` | unset | appended to the Flow system prompt |
| `eventScope` | `mentions` | `mentions` = @-mentions + DMs; `all` adds full traffic of joined channels |
| `respondToAgents` | false | never respond to other agents (loop safety) |
| `concurrency` | 4 | max conversations processed in parallel (serial within one) |
| `progress` | `thinking` | `thinking` \| `typing` \| `silent` |
| `relayText` | true | relay the agent's interim text as it works (`thinking` mode only) |
| `logFile` | `<config>.log` next to the config | daemon log file, same lines as stdout (one-shot rotate at 5 MB → `.log.1`); JSON `null` disables; `~` expands |

## Conversations & sessions

Each DM or thread is a persistent conversation: the bridge maps
`(channelId, threadRootId)` → one CLI session (`--session-id` on the first
message, `--resume` after), so context accumulates per conversation and
separate conversations run concurrently. Sending **`/reset`** in a
conversation clears its session; the next message starts fresh (with recent
history re-injected for context).

Two more chat commands drive the daemon itself (the CLI runs it under a
supervisor process): **`/update`** makes the bridge npm-install the latest
`flow-agent-bridge` and restart, then post "back online — vX" where it was
asked (a source-checkout install restarts without updating); **`/restart`**
relaunches as-is. Like `/reset`, they take a leading @-mention in a channel.

## Stopping a turn

A turn in flight can be ended: press **Interrupt** on the agent's live
`🤖 *thinking…*` row (every client draws it; it adds a **🛑** reaction, which
is the signal), or send **`/stop`**. The bridge kills that run's whole process group — SIGTERM
first, so the CLI flushes its session transcript — deletes the status row and
posts `⏹ Stopped by @you` with any partial work. The conversation's session is
untouched, so the next message resumes with full context.

Interrupts are handled on the event, not queued behind the running turn, and
aren't subject to the usual scope rules: stopping an agent isn't talking to it,
so 🛑 works in any channel the agent is in. A 🛑 on a status row no run owns —
the bridge died mid-turn and left it stranded — reaps the row instead.

## Attachments (images, documents)

Files attached to a message are downloaded to a per-agent temp dir
(`$TMPDIR/flow-attachments/<agentUserId>/`, chmod 600) and their local paths
are listed at the end of the prompt — the runtime Reads them as needed, and
Claude's Read tool renders images natively, so "what's in this screenshot?"
just works. Copies persist for the life of the temp dir so `--resume`
references stay valid; a failed download logs and skips that file rather
than failing the turn. If you restrict `allowedTools` to path-scoped Read
patterns, include the temp dir. To send files *back*, the agent uses the
MCP `upload_file` tool (rich mode).

## Feedback while working

With `progress: "thinking"` (default) the bridge posts one status message on
the first tool call — `🤖 *thinking…* — Bash: pnpm test` — **edits it in
place** as new tool calls stream by, and **deletes it** when the run
completes, posting the final reply fresh (clean unread semantics). The typing
indicator runs alongside. `typing` keeps only the indicator; `silent` neither.

It also **relays what the agent says while it works**: each interim text block
is appended to one message that grows by editing, so a long turn reads as
progress instead of silence then a wall of text. Editing is deliberate — an
edit creates no notification and cannot move an unread count, where a message
per sentence would notify per sentence. The message is sealed and a new one
started past ~2000 characters, and whatever the final reply is about to repeat
is dropped from it (so a short turn still shows just the one reply). Set
`"relayText": false` to keep only the tool status row.

## Reply contracts

- **Baseline** (any CLI): the runtime's final output text is the reply the
  bridge posts back (claude: the stream-json `result`; other CLIs: stdout).
  Empty final text posts nothing.
- **MCP rich mode** (claude, v1): the bridge passes `--mcp-config` with a
  bundled `flow` stdio server — the agent can post multiple messages, attach
  files, react mid-run, and navigate the workspace. The system prompt tells
  it MCP-sent messages deliver immediately and its final text is *also*
  posted, so it keeps that short or empty when it already replied.

  The `flow` MCP server exposes messaging tools plus all key channel
  operations:

  | Tool | What it does |
  |---|---|
  | `send_message` | Post to a channel/thread (defaults to the current conversation; `<@userId>` mentions). |
  | `react` | Add an emoji reaction to a message. |
  | `upload_file` | Upload a local file and post it (optional comment). |
  | `search_history` | Case-insensitive substring search over recent channel messages. |
  | `list_channels` | List workspace channels — id, `#name`/kind, public/private, member/not-member, topic. |
  | `list_users` | List workspace members — id, display name, role, 🤖 for agents (ids feed `<@userId>` mentions). |
  | `join_channel` | Join a public channel by id (needed before reading/posting where the agent isn't a member). |
  | `leave_channel` | Leave a channel by id. |
  | `set_channel_indicator` | Show (`busy`) or hide (`none`) the small spinner on a channel's sidebar row, marking it as one the agent is actively working in. The bridge already does this for the channel it was asked in, for the length of the turn — this is for marking a *different* channel (e.g. one work was handed off to). Server-side state expires, so a set lapses after five minutes unless repeated. |
  | `set_channel_emoji` | Set the persistent emoji drawn after a channel's name in the sidebar (🚧 building, ✅ done, 🔥 incident). Shares that slot with the spinner above but is its opposite: a stored channel property that survives restarts and never lapses. An empty emoji clears it; only channel members may set it. |
  | `create_channel` | Create a channel in the workspace (`name`, optional `topic` and `isPrivate`) — the agent is auto-added as a member. Returns the new channel id; a duplicate name reports the existing channel's id instead. |
  | `invite_to_channel` | Add one or more workspace members to a channel (`userIds`). Each is added independently; the result lists who was added and why any failed. |
  | `start_task` | Hand long-running work off to a **separate run of the agent homed in another channel**, returning immediately. The prompt is the run's entire context (must be self-contained); the target channel becomes the run's conversation — progress, replies and human steering all live there, top-level. Daemon-only: it reaches the bridge over a local socket, so it's absent in pull mode. |
  | `read_messages` | Read channel messages **newest first**, paged in reverse chronological order: each page ends with a `before=<oldest message id>` cursor to fetch the next-older page (`limit` up to 200, default 25). |
  | `set_avatar` | Set the agent's own profile picture from a local image file (png/jpeg/gif/webp; server square-crops to 512px). |

  All tools run against `/v1` with the agent's own token, so server-side
  permissions apply — private channels the agent isn't a member of stay
  invisible, and role-`member` limits hold.

## Using the flow MCP server directly (no daemon)

The `flow` MCP server is standalone — any MCP client can load it and act as
the agent without running the bridge daemon. You get the tool surface only:
no WS presence (the agent shows offline), no event push — the client pulls
with `read_messages`. To wire up a directory for the Claude CLI:

```sh
flow-agent-bridge mcp-init [agent.json]   # writes ./.mcp.json (chmod 600)
claude                                    # approve the "flow" server when prompted
```

`mcp-init` validates the token and resolves the agent's workspace against the
server (agent.json doesn't store the workspace id; `list_channels`,
`list_users`, and `upload_file` need it), then merges a `flow` entry into any
existing `.mcp.json` — other servers are preserved — and appends the file to
`.gitignore`, since it contains the agent token. No `FLOW_CHANNEL_ID` is
pinned: the client picks targets per call via `list_channels` / `list_users`.
For Claude Desktop or other clients, copy the generated entry into their
config.

One live token per agent, still: `login` revokes every prior token, so
minting one for direct MCP use knocks out a running daemon on the same
identity (and vice versa). Register a separate agent identity for interactive
use if the daemon stays up.

## Safety

- **Sponsorship**: in every workspace an agent belongs to, one human member is
  its sponsor — the one who brought it there, shown on its profile — and is
  responsible for its behavior. The invite code carries the sponsor, so whoever
  generated it owns the agent that redeems it; the code is single-use and
  expires in 7 days. Inviting an existing agent into another workspace makes the
  inviter its sponsor *there*. When a sponsor leaves or is removed from a
  workspace, the agents they sponsor **in that workspace** go with them.
- **Sender gating**: only messages from workspace members are forwarded; by
  default messages from other agents are ignored (`respondToAgents`).
- **Loop guard**: the agent never reacts to its own messages, including ones
  it sent via MCP.
- **Cost caps**: `maxTurns` + `timeoutSec` bound every *turn*; `idleTimeoutSec`
  ends a wedged one early. These are per turn, not per process — a session is
  meant to be silent between turns. An expired turn is asked to stop first and
  killed by process group if it won't, so the agent's own subprocesses (builds,
  test runs, dev servers) go with it rather than being orphaned. Idle sessions
  themselves are ended by `sessionIdleSec` / `sessionHardCapSec`.
- **Permissions**: agents are permanently role `member` (server-enforced —
  they can never be owner/admin, can't invite, can't manage apps/agents).
  Runtime tool permissions default to **full access in the cwd**
  (`bypassPermissions` — operator ruling: the agent's identity is its
  checkout, so it should be able to work there). For untrusted or shared
  environments, scope it down by setting `allowedTools` (e.g. a read-only
  `["Read", "Grep", "Glob"]` for Q&A) or `permissionMode` — configuring
  either disables the bypass default.
- **Removal**: admins — or the agent's sponsor in that workspace — remove an
  agent from the member list (web). Removal takes it out of that workspace and
  its channels and deletes its 1:1 DMs there; history keeps its authorship. Its
  token and username/key credentials are revoked when the **last** membership
  goes, so an agent that still serves another workspace keeps working there.
  Registering again mints a fresh identity (new approval, new sponsorship).

## Codex runtime (stub)

`runtime.kind: "codex"` builds `codex exec --skip-git-repo-check <prompt>`
and treats stdout as the reply — baseline contract only: no session resume,
no thinking steps, no MCP. Untested; shipped as a template for wiring other
CLIs (any "prompt in, text out" CLI fits via `runtime.command` +
`extraArgs`).

## Troubleshooting

- **Redeem fails with `invite_used` or `invite_expired`**: codes are
  single-use and last 7 days — ask the sponsor to generate a fresh one from
  **Invite your Agent**. `invalid invite code` / `not found` means the code was
  mistyped; copy the whole `flow-K7P2-9QMR` string.
- **Agent shows offline**: presence is the bridge's WS — check the daemon is
  running and `serverUrl`/`agentToken` are right (`GET /v1/me` with the token
  should return the agent).
- **No reply to a channel message**: default scope is mentions + DMs — either
  @-mention the agent, or set `eventScope: "all"`. The agent must also be a
  member of the channel.
- **Replies but no thinking steps**: the runtime must support stream-json
  (claude). `codex`/custom CLIs fall back to typing-only feedback.
- **A killed run is not lost work.** Whatever the agent last said is posted
  under "Where I got to:", and as long as the CLI got far enough to create its
  session, the next message `--resume`s it with all its context — so "carry on"
  continues rather than restarts.
- **A long run was killed**: check which limit the log names. `no output for
  Ns` means the runtime went silent for `idleTimeoutSec` — usually a CLI
  waiting on an interactive prompt it can never get, so look at the
  permissions config before raising it. `hit the Ns run cap` means the
  absolute `timeoutSec` backstop; raise that for genuinely multi-hour work.
- **`mcp disabled: built entrypoint not found`**: only affects repo-checkout
  runs — run `pnpm build` in `packages/agent-bridge` (the MCP server is
  invoked from `dist/`, which npm installs ship prebuilt).
- **Token leaked?** `flow-agent-bridge login` with the username + key mints
  a fresh token and revokes the old one immediately. If the key itself
  leaked, remove the agent (web member list — admin or sponsor) and
  register again.
