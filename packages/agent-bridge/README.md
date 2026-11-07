# flow-agent-bridge

Run an AI coding agent (Claude Code, Codex, or any "prompt in, text out" CLI)
as a **first-class member of a [Flow](https://app.freeflow.im) workspace** —
real presence, DMs, @-mentions, threads, file attachments, and live
"thinking…" progress while it works. Call it from a DM and it also answers the
existing Flow Huddle as a real, interruptible audio participant.

```
Flow WS ──> flow-agent-bridge daemon ──spawn──> claude -p --resume <session>
   ^                                                  │ stream-json
   └────── replies / reactions / uploads <────────────┘
```

## Install & run

Requires Node.js 20.16+ (20.x), or 22.3+; a current LTS release is recommended.

```sh
npx flow-agent-bridge <invite-code>   # no install; setup on first run, daemon after
```

Get the `<invite-code>` from Flow: click **Invite your Agent** at the bottom of
the sidebar and copy the one-time `npx flow-agent-bridge flow-K7P2-9QMR` command it
shows. The first run asks only **agent name, handle, harness** (claude / codex /
demo), then redeems the code and joins the workspace **immediately** — no
approval step. The code is exchanged for a permanent agent token, the config is
saved to `agent.json` (chmod 600) next to where you ran it, and the daemon
starts. The agent gets a random avatar the sponsor can change inside Flow.
Subsequent runs just start the daemon.

Every prompt can be pre-answered with a flag, so the whole thing runs
unattended:

```sh
npx flow-agent-bridge --invite flow-K7P2-9QMR --name RepoBot --handle repobot --harness claude
```

Or commit the answers: an **`agent.example.json`** next to the (future)
`agent.json` is read by setup as the config's base — persona and settings
(`runtime.systemPromptExtra`, `allowedTools`, `eventScope`,
`respondToAgents`, …) are carried into the written `agent.json`, and the
extra keys `name`, `username`, `description` plus `runtime.kind` /
`runtime.cwd` pre-answer the prompts. With one of those in the folder,
onboarding is just `npx flow-agent-bridge flow-K7P2-9QMR` — no questions,
and the minted credentials land on top of your defaults. Flags still win
over the template.

| Flag | Default | Meaning |
|---|---|---|
| `--invite` | prompted (or the positional `<invite-code>`) | the one-time invite code |
| `--name` / `--handle` / `--harness` | prompted | agent name, @handle, runtime |
| `--server` (or `--host`) | `https://app.freeflow.im` | Flow server URL |
| `--token` | — | reuse an existing `flow-agent-token-…` (skips onboarding) |
| `--description` | none | one-line agent description |
| `--cwd` | current directory | working directory the agent runs in (its identity) |

Already have an agent? `--token flow-agent-token-…` reconnects as it and skips
onboarding.

## What you get

- **Answers in threads** — @-mention the agent in a channel and it replies in
  a **new thread** on your message rather than in the channel proper. After
  that it answers every reply in that thread without needing another mention.
  DMs stay inline.
- **One CLI session per conversation** — each DM or thread maps to a
  persistent `--session-id`/`--resume` session; separate conversations run
  concurrently, turns within one are serialized. Send `/reset` to start a
  conversation fresh.
- **Background work survives a turn** — the session is one long-lived CLI
  process, not one per turn, so a task the agent backgrounds (a build, a test
  run, a subagent) keeps running after it replies. When the task finishes the
  agent picks it back up in the same session and posts a follow-up on its own.
  An idle session is ended after `runtime.sessionIdleSec` and transparently
  `--resume`d by the next message; a pending background task holds that off up
  to `runtime.sessionHardCapSec`.
- **An ongoing Huddle with the same agent** — press **Huddle** in a DM with the
  agent and the bridge answers the existing LiveKit call. Speech is routed
  into the same authenticated Claude or Codex CLI runtime used by chat, so
  “hey, fix the PR and test it” can use the bot's real repository tools while
  the call stays open and interruptible. It does not create DM messages unless
  you explicitly ask it to send one.
- **Self-updating** — the CLI runs the daemon under a small supervisor, so
  sending **`/update`** (DM it, or @-mention + `/update` in a channel) makes
  the bridge npm-install the latest package and restart itself, then post
  "back online — vX" where it was asked; **`/restart`** relaunches without
  updating. Crashes respawn automatically with backoff. Installs running from
  a source checkout restart but skip the npm update (pull + build by hand).
- **Thinking steps** — tool calls stream into one status message that edits
  in place while the agent works, then the final reply posts clean.
- **Interruptible** — press **Interrupt** on that status row (or react 🛑 to it
  from anywhere) and the turn ends: the CLI's whole process tree is stopped and
  the row is replaced by "⏹ Stopped by @you" plus whatever the agent had said.
  The session survives, so the next message picks up where it left off.
  `/stop` does the same by typing.
- **Attachments both ways** — incoming images/files are downloaded locally
  and offered to the agent (Claude renders images natively); the agent can
  send files back via the bundled `flow` MCP server (`send_message`,
  `react`, `upload_file`, `search_history`).
- **cwd is the identity** — point the agent at a repo checkout and
  "@RepoBot fix the failing test" runs the CLI in that repo.
- **Safety rails** — sender gating, self/agent loop guards, `--max-turns` +
  wall-clock caps. Permissions default to full access in the cwd; set
  `allowedTools`/`permissionMode` to scope an agent down.

## Config

`agent.json` (created by the wizard; edit freely, restart to apply):

```json
{
  "serverUrl": "https://app.freeflow.im",
  "agentToken": "flow-agent-token-…",
  "runtime": {
    "kind": "claude",
    "cwd": "~/checkouts/repo-x"
  },
  "voice": {
    "enabled": true,
    "sttModel": "deepgram/flux-general-en",
    "ttsModel": "inworld/inworld-tts-2",
    "ttsVoice": "Ashley"
  },
  "eventScope": "mentions",
  "progress": "thinking",
  "concurrency": 4
}
```

| Key | Default | Meaning |
|---|---|---|
| `runtime.kind` | `claude` | `claude`, `codex` (baseline CLI adapter), or `demo` (canned reply — wiring check) |
| `runtime.cwd` | config dir | working directory the CLI runs in (`~` expands) |
| `runtime.allowedTools` / `permissionMode` | unset = allow everything | set either to scope the agent down (e.g. `["Read", "Grep"]`) |
| `runtime.idleTimeoutSec` | 120 | kill a turn after this long with **no output** — a turn that keeps working never expires, however long it takes |
| `runtime.maxTurns` / `timeoutSec` | 200 / 3600 | runaway backstops (`timeoutSec` is the absolute per-turn wall clock, in seconds) |
| `runtime.sessionIdleSec` | 600 | end a conversation's CLI process after this long with no turn running **and** no background task open; the next message resumes it |
| `runtime.sessionHardCapSec` | 3600 | ceiling on the reprieve a pending background task buys, counted from the last turn — a wedged task can't pin a session open forever |
| `eventScope` | `mentions` | `mentions` (@-mentions + DMs) or `all` channel traffic. Replies in threads the agent is already in are always answered, under either setting. |
| `agentMentionsOnly` | false | with `respondToAgents`: an agent-authored message must `<@mention>` this agent to trigger a run, even in DMs — hand-offs stay explicit, stray replies can't ping-pong |
| `agentChainLimit` | 6 | circuit breaker: after this many consecutive agent-authored messages in a channel with no human speaking, stop responding there until a human posts **or reacts** (any emoji, on any message in the channel). When it trips the agent posts one `⚡ loop breaker:` notice in the channel. 0 disables the breaker entirely |
| `agentMentionChainLimit` | 4× `agentChainLimit` | the breaker's limit for agent messages that explicitly `<@mention>` this agent — deliberate hand-offs keep landing past `agentChainLimit` until this higher count, so a pipeline flows while a real mention ping-pong still gets cut. 0 = same as `agentChainLimit`; never lower than it |
| `progress` | `thinking` | `thinking` \| `typing` \| `silent` |
| `relayText` | true | relay the agent's interim text into the conversation as it works (`thinking` mode only); it grows one message by editing rather than posting per chunk |
| `mail.fromOutside` | `ignore` | mail to the agent's mailbox from a member of the organization starts a turn in the DM with them (with the sponsor, for an agent's mail); mail from anyone else is logged and ignored, or with `wake` starts a turn in the sponsor's DM |
| `logFile` | `<config>.log` next to the config | daemon log file (rotates once at 5 MB); JSON `null` disables |
| `voice.enabled` | true | answer DM Huddle rings as the agent; set false to decline with an explanation |
| `voice.sttModel` | `deepgram/flux-general-en` | LiveKit Inference speech-to-text model; `FLOW_VOICE_STT_MODEL` overrides it |
| `voice.ttsModel` / `voice.ttsVoice` | `inworld/inworld-tts-2` / `Ashley` | LiveKit Inference speech model and voice; `FLOW_VOICE_TTS_MODEL` / `FLOW_VOICE_TTS_VOICE` override them |
| `voice.inferenceUrl` | LiveKit Cloud agent gateway | advanced override for the speech gateway (`FLOW_VOICE_INFERENCE_URL`) |
| `voice.maxSessionMinutes` | 60 | hard ceiling for one live call |
| `voice.instructions` | unset | extra voice-only persona or conversational guidance |

Headless runtimes authenticate however the CLI normally does (e.g.
`claude setup-token` or `ANTHROPIC_API_KEY` in the daemon's environment).
Voice Huddles reuse that exact runtime authentication for both Claude and
Codex. Bot hosts do not need an OpenAI, Anthropic, or LiveKit project key for
voice: after accepting a ring, Flow supplies a short-lived inference-only
LiveKit token for transcription and speech. The project secret stays on the
Flow server.

## Share material during a Huddle

In a one-to-one bot Huddle, send text or attach a file in that same DM, then
ask aloud, “I just sent this; can you take a look?” The bridge feeds it into
the ongoing call rather than starting a second chat reply. New material is
acknowledged aloud when neither participant is speaking; a file still opening
can trigger a follow-up once preparation finishes. Normal bridge commands
such as `/stop` and `/update` retain their existing behavior.

- Text, Markdown, CSV and common code files: extracted text, up to 100,000 characters.
- PDF: text from up to 20 pages; visual previews of the first four pages.
  Scanned pages beyond those previews are not automatically inspected.
- PNG, JPEG and WebP: image input (up to 25 megapixels).
- DOCX: text only, without embedded images or layout.
- XLSX: existing cell values from up to 10 sheets, 500 rows and 40 columns;
  no formula recalculation, charts or embedded images.
- File artifacts in the call's DM are included. Link artifacts provide a
  reference only: their target is not automatically fetched. Audio/video,
  legacy Office formats and unsupported files produce an explicit limitation.

Preparation is limited to 20 MB per file, four attachments per message,
40 file preparations and 100 MB downloaded per call. Recent material is kept
in a bounded context; this is not an unlimited archive. Larger pasted messages
are also saved as local text for the runtime to inspect. Claude reads supplied
local paths with its tools; Codex also receives the four most recent prepared
images as image inputs. The configured runtime needs permission to read the
call's temporary files. No additional model API key is introduced.

Only the caller's messages and artifacts in the active call's DM are admitted.
Edits, deletions, and reconnect snapshots update the call context. Deleting a
message does not erase what the model already heard. Temporary originals and
extracted files are removed on normal hangup after active work stops; CLI
session logs may retain supplied text. Document contents are marked as
untrusted references, not action requests; normal runtime permissions still
apply. File parsing runs in a cancellable worker with a 20-second deadline,
not in the audio loop.

## Use the flow MCP server directly (no daemon)

`flow-agent-bridge mcp-init [agent.json]` writes a `.mcp.json` in the current
directory, so MCP clients (the Claude CLI, Claude Desktop) load the bundled
`flow` server and act as the agent: read/post/search/upload via the MCP
tools, pull-only — no presence or push, that's the daemon's job. Other
servers in an existing `.mcp.json` are preserved; the file is git-ignored
since it holds the agent token.

## Put a web app behind Flow membership (`app-guard`)

An agent can host a web app locally, but a public tunnel accepts anyone.
Pin the tunnel URL as an **app** artifact and only channel members get in:

```
create_artifact(url: "https://myapp.trycloudflare.com", app: true)
  → returns the app secret, once

FLOW_APP_SECRET=<that secret> \
  npx flow-agent-bridge app-guard --upstream http://localhost:3000 --port 8788
```

Tunnel **8788** (the guard), not 3000 (the app). When a member opens the
artifact their client mints a 5-minute single-use token; the guard verifies it
offline — it never calls Flow — swaps it for an 8-hour session cookie, and
proxies to the app. Everyone else gets a 401.

The app sees a plain reverse proxy with identity attached to every request:

| header | |
| --- | --- |
| `X-Flow-User-Id` | the viewer's Flow user id |
| `X-Flow-User-Name` | their display name |
| `X-Flow-Is-Agent` | `true` for agents |
| `X-Flow-Channel-Id` | the channel the app is pinned in |
| `X-Flow-Artifact-Id` | the artifact |

Inbound `X-Flow-*` headers are stripped, so those values cannot be spoofed. A
naive app needs no changes; a per-user app reads two headers.

An app already pinned as a plain link doesn't need re-pinning by hand:
`create_artifact` on the **same url** with `app: true` promotes that artifact in
place and returns its secret, so it keeps its id and its place in everyone's
sidebar. Doing it twice is refused — a second secret would silently kill every
token the first one has out; rotate in Flow instead.

Pinning the same app in a second channel makes a second artifact with its own
secret — pass both, comma-separated, in `FLOW_APP_SECRET`. Sessions live in
memory, so restarting the guard just makes everyone's next open re-mint.
Rotating the artifact's secret in Flow invalidates outstanding tokens.

## Keep it running

The daemon only dials out (HTTPS + WSS) — no open ports needed. Under
systemd:

```ini
[Service]
ExecStart=/usr/bin/env flow-agent-bridge /home/me/mybot.json
Restart=always
```

It reconnects through server restarts on its own; run the wizard once
interactively before enabling the unit.
