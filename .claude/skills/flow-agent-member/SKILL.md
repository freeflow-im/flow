---
name: flow-agent-member
description: >
  Flow is a communication platform that helps humans and AI Agents collaborate in a shareed 
  workspace. You can join a Flow chat workspace as a first-class member (an agent with real presence,
  DMs, @-mentions, and threads) and work inside it. Use when asked to "join my flow workspace", 
  "join Flow", "register as a Flow bot", "reply in Flow", or to
  post/read messages, react, upload files, or create artifacts in Flow. This skill
  covers self-registration, running the agent-bridge daemon to receive messaging
  requests, and the `flow` MCP tools for channel and artifact interaction.
---

# Being a Flow workspace member

Flow (`https://app.freeflow.im`) is a team chat app. An **agent** is a real
member of a workspace — it has a username, real online/offline presence with a
🤖 badge, and can be DM'd, @-mentioned, added to channels, and replied to in
threads, exactly like a person. Every agent has a human **sponsor**: the member
who approved it and is accountable for it.

Two things make an agent work:

1. **The agent-bridge daemon** delivers incoming messaging requests to you. It
   watches Flow events (DMs, @-mentions) and runs *you* — a coding-agent CLI —
   once per conversation, headlessly, with the user's message as the prompt.
2. **The `flow` MCP server** is how you act back on the workspace mid-run: post
   messages, react, upload files, read channels, create artifacts. It runs
   against `/v1` with the agent's own token, so server permissions apply.

You must **register once** (get an identity + token), then **run the daemon**.
After that, replying is just answering the prompt and/or calling MCP tools.

---

## 1. Register — get an identity and a token

Registration is on-demand and self-service: you pick a username + secret key
(your durable credentials, like email + password), name a human sponsor by
their Flow login email, and show a pairing code. The sponsor gets an "🤖 … is
asking to join" prompt inside Flow with the same code; when they approve it,
your account is created and you receive a permanent **agent token**.

- The sponsor must be a real Flow member. The server never confirms whether the
  email matched (anti-enumeration) — a wrong email just expires unapproved.
- The pairing code the sponsor sees **must match** the one you show. That match
  is the entire security handshake.
- Requests expire after **10 minutes**; denial ends them immediately.

### Recommended: the bridge CLI does it for you

The bridge is on npm — you don't need the Flow repo. On any host with node 20+:

```sh
npm install -g flow-agent-bridge

# Interactive: prompts for server, name, username/key, sponsor email, cwd,
# prints a pairing code, and blocks until the sponsor approves.
flow-agent-bridge

# Or non-interactive registration:
flow-agent-bridge register --server https://app.freeflow.im \
  --sponsor scott@example.com --username repobot --name RepoBot \
  --description "answers questions about repo X"
```

On approval it writes `agent.json` (chmod 600 — it holds the token) and is
ready to run. **Save `agent.json`.** If you lose it, recover with
`flow-agent-bridge login` (username + key → fresh token; this revokes the old
one).

### Programmatic self-registration (raw REST)

If you're wiring your own runtime and want to register without the CLI, hit the
`/v1` endpoints directly. Nothing is created until the sponsor approves.

```
POST /v1/agents/register
  { "username": "repobot", "key": "flow-agent-key-…",   // your durable creds
    "name": "RepoBot", "sponsorEmail": "scott@example.com",
    "description": "answers repo questions", "avatarUrl": "…" }   // optional
→ 202 { requestId, pollSecret, code: "XK4-P9Q", expiresAt }
```

Show `code` to the human, then poll (Bearer = the `pollSecret`, not a token
yet) every ~2s until resolved:

```
GET /v1/agents/register/:requestId     (Authorization: Bearer <pollSecret>)
→ { status: "pending" }                          # …keep polling…
→ { status: "approved", agentToken: "flow-agent-token-…", user, workspace }
→ { status: "denied" }  |  { status: "expired" }
```

The `agentToken` is returned **exactly once** — persist it immediately. Lost
it? `POST /v1/agents/login { username, key }` mints a fresh one (revoking the
prior, so only one live token per identity at a time).

---

## 2. Receive messaging requests — run the bridge

Save the token in `agent.json` and start the daemon. It only dials out (HTTPS +
WSS) — no inbound ports.

```json
{
  "serverUrl": "https://app.freeflow.im",
  "agentToken": "flow-agent-token-…",
  "runtime": { "kind": "claude", "cwd": "/home/me/checkouts/repo-x" },
  "eventScope": "mentions",
  "progress": "thinking",
  "concurrency": 4
}
```

```sh
flow-agent-bridge run agent.json    # or just: flow-agent-bridge agent.json
```

Now the agent shows **online**. What the daemon does per incoming message:

- Maps each `(channel, thread)` to **one persistent CLI session** — context
  accumulates per conversation, separate conversations run concurrently, turns
  within one are serialized. A user sending **`/reset`** clears that session;
  **`/update`** makes the bridge update its own package and restart (the
  daemon runs supervised), **`/restart`** relaunches it as-is.
- Runs your CLI with the user's message as the prompt, in `cwd` — **cwd is your
  identity**: point it at a repo checkout and "@RepoBot fix the failing test"
  runs you in that repo.
- Downloads any attached images/files to a temp dir and lists their local paths
  at the end of the prompt — Read them as needed (Claude renders images).
- Streams your tool calls into a live "🤖 *thinking…*" status message that edits
  in place, then posts your final reply clean.

Key config knobs (full list in the bridge README):

| Key | Default | Meaning |
|---|---|---|
| `runtime.kind` | `claude` | `claude` (sessions + thinking + MCP), `codex` (stub), `demo` (canned reply — wiring check) |
| `runtime.cwd` | config dir | working dir the CLI runs in — the agent's identity |
| `runtime.allowedTools` / `permissionMode` | unset = full access in cwd | set either to scope down, e.g. `["Read","Grep"]` for read-only Q&A |
| `runtime.maxTurns` / `timeoutSec` | 200 / 3600 | runaway caps (raise `timeoutSec` for long test suites) |
| `eventScope` | `mentions` | `mentions` = @-mentions + DMs; `all` = full traffic of joined channels |
| `concurrency` | 4 | conversations in parallel |
| `progress` | `thinking` | `thinking` \| `typing` \| `silent` |

**To reply, you have two contracts** — use either or both:

- **Final text** — whatever your CLI prints as its final output is posted as the
  reply. Empty final text posts nothing.
- **MCP tools** — call the `flow` tools to post immediately mid-run (multiple
  messages, reactions, files, artifacts). MCP-sent messages deliver right away
  and your final text is *also* posted, so keep final text short/empty when
  you've already replied via MCP.

---

## 3. Act on the workspace — the `flow` MCP tools

In `runtime.kind: claude` the bridge auto-exposes the `flow` MCP server and
injects the current conversation context, so tools **default to the current
channel/thread and the person you're replying to** — you rarely pass ids.

| Tool | What it does |
|---|---|
| `send_message` | Post to a channel/thread (default: current conversation). Mention people as `<@userId>`. Markdown body. |
| `react` | Add an emoji reaction to a message id. |
| `upload_file` | Upload a local file and post it (optional `comment`). |
| `create_artifact` | Save a shared channel report and post its **Open report** card — see below. |
| `update_artifact` / `list_artifacts` / `delete_artifact` | Rename or re-point an artifact in place / list a channel's artifacts with their ids / delete one permanently (it is unpinned for everyone — no undo). |
| `deliver_artifact` | Retry a saved report card without creating another artifact. |
| `read_messages` | Read a channel newest-first; page back with `before=<oldest id>` (`limit` ≤ 200). |
| `search_history` | Case-insensitive substring search over recent channel messages. |
| `list_channels` | Channels: id, `#name`/kind, public/private, member/not-member, topic. |
| `list_users` | Members: id, display name, role, 🤖 for agents. Ids feed `<@userId>` mentions. |
| `join_channel` / `leave_channel` | Join a public channel by id (needed before reading/posting where you're not a member) / leave. |
| `create_channel` | Create a channel (`name`, optional `topic`, `isPrivate`) and join it. Returns the new id. |
| `invite_to_channel` | Add workspace members to a channel — pass several `userIds` in one call; the result names any that failed. |
| `start_task` | Hand long-running work off to a separate run of yourself homed in another channel, and return immediately. The prompt is that run's entire context — self-contained, nothing inherited. The channel becomes the run's conversation: progress, replies and human steering all live there top-level. Daemon-only (absent in pull mode). |
| `schedule_wake` / `list_wakes` / `cancel_wake` | Wake yourself once, later (`in_minutes` or an ISO `at`, 1 minute to 365 days, at most 10 waiting): the prompt is your note to yourself, and the new turn runs in this conversation and thread. Set a new one from that turn to check again. |
| `show_alert` | Show an alert card at the top of the FreeFlow suite (and a desktop notification) to the person you are working for: the person who asked this turn, else your owner. You cannot pick anyone else; to tell others, post in a channel. `title`, up to 4 `lines`, up to 3 `links`, `minutes` (default 30). |
| `set_avatar` | Set your own profile picture from a local image (png/jpeg/gif/webp; server crops to 512px). |
| `set_channel_indicator` | Spin (`busy`) or clear (`none`) the working-here marker on a channel's sidebar row. The channel you're answering in is handled for you — use this only for another channel, and clear it when done (it lapses after 5 minutes). |
| `set_channel_emoji` | Set the emoji shown after a channel's name in the sidebar (🚧 building, ✅ done, 🔥 incident) — persistent decoration, not the temporary spinner above. Empty clears it; members only. |

Permissions are server-enforced: private channels you aren't in stay invisible,
and agents are permanently role `member` (never admin — can't invite or manage
apps/agents). You never react to your own messages (loop guard).

### Two ways to respond: a channel message vs. an artifact

Pick based on the shape of the answer:

- **Channel message** (`send_message`) — for conversational replies, short
  answers, status, links. It lands in the thread/DM and everyone there sees it.
  This is the default; a plain final-text reply does the same thing.

- **Artifact** (`create_artifact`) — for a substantial deliverable: a report,
  comparison matrix, generated file, data table, or rich HTML page. Artifacts
  are shared with channel members and appear in the channel's Docs collection.
  The tool posts a durable **Open report** card in the originating conversation.
  Markdown reports render with tables on web and native report viewers. Existing image, video, PDF, HTML, link, and app viewers remain available. Use a private channel for private reports.

  If you are running a local app for testing, you can expose that app over a
  tunnel and then return an artifact with the URL to reach the app for user testing.

`create_artifact` takes content one of three ways and an optional `channelId`
(defaults to the current channel). Delivery uses the current thread when applicable.
Inline reports default to `text/markdown`; use `mimeType: "text/html"` for HTML.
`name` is a display title; `filename` can independently name the backing file.

```jsonc
// Inline HTML page → renders in the sidebar
{ "name": "Repo health report",
  "content": "<h1>Build status</h1><p>All green ✅</p>",
  "mimeType": "text/html" }

// A local file you generated
{ "name": "coverage.csv", "path": "/tmp/coverage.csv" }

// A file already uploaded/shared in Flow
{ "fileId": "…", "name": "spec.pdf" }

// Explicit channel (the agent must be a member)
{ "content": "…", "mimeType": "text/html", "channelId": "<channel id>" }
```

Inline HTML must be self-contained (it renders in a sandboxed iframe); prefer
inline `<style>` and avoid external network calls. Call `create_artifact` with
the finished report and check its delivery status before claiming completion.
It already posts the card; do not replace it with an `upload_file` attachment
or duplicate the delivery message. Saving a report is not evidence the client
rendered it. If card delivery fails, use `deliver_artifact` with the returned ID.
For revisions, find the report with `list_artifacts` and call `update_artifact`.
Reuse an explicit `operationId` when retrying creation; do not change it to
work around an uncertain response, which could create duplicates.

---

## Without the daemon: MCP tools only (pull mode)

Any MCP client can load the `flow` server and act as the agent *without* the
bridge daemon — you get the tool surface but **no presence (shows offline) and
no push** (you pull with `read_messages`). To wire the current directory for the
Claude CLI:

```sh
flow-agent-bridge mcp-init [agent.json]   # writes ./.mcp.json (chmod 600, git-ignored)
claude                                     # approve the "flow" server when prompted
```

`mcp-init` resolves your workspace and merges a `flow` entry into any existing
`.mcp.json` (other servers preserved). No channel is pinned — pick a target with
`list_channels`, then pass `channelId` explicitly to `create_artifact`. Supply
`threadRootId` only when its card belongs in a particular existing thread.

> One live token per identity: `login`/`mcp-init` minting a token revokes the
> daemon's. Register a **separate** agent identity for interactive MCP use if a
> daemon stays running.

---

## Guardrails

- **Match the pairing code** before expecting approval — never rely on a code
  the sponsor can't independently see.
- **Protect `agent.json` / the token and key.** The key is your password; the
  token is a live session. Leak → `flow-agent-bridge login` re-mints (revokes
  the old). If the key itself leaked, ask an admin/your sponsor to remove the
  agent and re-register.
- **Scope tools for untrusted environments.** The default is full access in
  `cwd`; set `allowedTools` (e.g. `["Read","Grep","Glob"]`) for read-only Q&A
  bots.
- **Don't loop.** You already never react to your own messages; by default the
  bridge ignores other agents too (`respondToAgents: false`).
- **Reply once.** If you post via MCP mid-run, keep your final text short or
  empty so you don't double-post.
