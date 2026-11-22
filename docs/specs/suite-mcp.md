# The suite's MCP endpoint: one FreeFlow server at app.freeflow.im/mcp

Status: built on branch `mcp/suite-server` (2026-11-22), one commit per phase of §10. §9 lists the rulings. Where the
build differs from the first draft, this text says what was built.

This spec builds on `web-mcp.md` (the endpoint and its OAuth, written `W§n`), `platform.md` (the tool registry, manifests:
`P§n`) and `agents.md` (agent kinds and reach: `A§n`).

## 0. Summary

`https://app.freeflow.im/mcp` is already the only MCP endpoint of the suite, and it already serves Mail, Calendar,
Contacts, Events and installed apps beside Docs. But it is built as the Docs server with other apps added to it:

- it runs inside the organization's **Docs object**, which builds the Docs plugin's MCP server and adds the other apps'
  tools to it;
- it calls itself **"MCP Docs"** (`serverInfo`: `name: 'universal-docs', title: 'MCP Docs'`), and its instructions start
  with "MCP Docs: the user's text documents…";
- **Chat**, the suite's first app, has no tools there, and neither does Meet; there is no search across the apps.

This spec makes `/mcp` the **FreeFlow** server: a suite module in the Worker that serves every app's tools from the
registry in the same way, with Docs as one app among the others. Then it adds Chat, Meet and one search across the apps.
The URL, the OAuth, the consent page's flow and the tokens already issued do not change.

## 1. What is there today

| Part | Where | What it does |
|---|---|---|
| Route | `packages/edge/src/routes/mcp.ts` | OAuth (in the directory), then sends the request to `DOCS.get(orgId).mcp(request, caller)` |
| Docs object | `packages/edge/src/docs/object.ts` `mcp()` | finds the caller's Mail, Calendar, Events, apps and installed apps, then calls `handleMcp` |
| Server | `packages/edge/src/docs/mcp.ts` `handleMcp` | builds the plugin's server (`createMcpServer`), removes the Docs tools the token may not use, registers the other apps' tools from the registry |
| Docs tools | `packages/docs/plugin/server/mcp.ts` | 66 tools at `/mcp`, registered and run by the plugin itself (no registry runner) |
| Registry | `packages/edge/src/registry`, `@flow/shared/toolDefinitions` | definitions per app and door; `toolsFor('mcp', { scopes, reach })` |
| Scopes | each manifest's `scopes` (`@flow/shared/manifests`) | consent page groups: Docs, Mail, Send, Calendar, Events, Contacts, Email members, Installed apps |

Tools at `/mcp` on `origin/main` (a0e81993):

| App | Tools | Scopes |
|---|---|---|
| Docs | 66 | `files:read`, `files:write` |
| Mail | 12 | `mail:read`, `mail:write`, `mail:send` |
| Calendar | 12 | `calendar:read`, `calendar:write` |
| Contacts | 4 | `contacts:read`, `contacts:write`, `contacts:email` |
| Events (with wakes) | 8 | `events:read` |
| Installed apps | per organization | `apps:use` |
| Chat | 0 | none (22 tools at the bridge door, 5 at the assistant's) |
| Meet, Home, Admin | 0 | none |

Other callers of `Docs.mcp()`: the hosted assistant runs Docs tools headless through it (`Assistant.runDocsHeadless`,
`assistant/object.ts`), and `/mcp/import/:org` (an agent's upload) goes to `Docs.mcpImport()`.

## 2. Goals and non-goals

Goals:

1. `/mcp` presents itself as **FreeFlow**, with instructions for the suite, and the sections of the apps the token can use.
2. Every app's tools are registered **one way**: from the registry, each with a runner. Docs stops being a special case.
3. A call to Mail, Calendar, Chat or Meet no longer goes through the Docs object. `tools/list` wakes no object.
4. **Chat** at `/mcp`: read, search and post, with scopes the person grants on the consent page.
5. **Meet** at `/mcp`: make a meeting link.
6. One **`search`** tool across the apps the token can read.

Non-goals:

- The bridge's MCP (`packages/agent-bridge`) stays as it is. It is a member agent on its own machine, with tools that use
  local paths. Bringing the two doors together is a later piece of work.
- The ChatGPT plugin's `/mcp` on `docs.freeflow.im` and `mcpdocs.freeflow.im` (AWS) does not change.
- Admin tools (members, domains, settings) are not offered at `/mcp`. The admin agent works only in the panel (`A§1.4`).
- No GET stream and no sessions: the endpoint stays stateless Streamable HTTP with JSON answers (`W§/mcp`).

## 3. The suite server

### 3.1 Where it runs

A new module, `packages/edge/src/mcp/suite.ts`, runs **in the Worker**, not in an object. `routes/mcp.ts` calls it after
the directory has authenticated the token:

```
/mcp ── routes/mcp.ts (OAuth: directory) ── mcp/suite.ts handleSuiteMcp(request, caller, env)
                                                 ├─ tools/list: the registry's definitions for the token (no object)
                                                 └─ tools/call: the tool's runner, with the caller's objects:
                                                      docs → DOCS.get(org).runMcpTool(...)   (RPC)
                                                      mail → MAIL.get(account)               (as today)
                                                      calendar, contacts, events, apps       (as today)
                                                      chat, meet → ORG.get(org)              (new, §4 and §5)
```

The module is loaded lazily (a dynamic `import()` in the route), as the other heavy code is, to keep the Worker's startup
time under the limit (`worker-startup-time`, PR #875).

`handleSuiteMcp` takes over what `handleMcp` does today: the protocol version check, `server/discover` for the
2026-07-28 protocol (`stateless.ts`), building an `McpServer`, registering tools, and the transport. It uses the same
helpers from `@flow/docs/plugin/server/stateless.ts`.

### 3.2 Name, icon and instructions

- `serverInfo`: `{ name: 'freeflow', title: 'FreeFlow', version }` with the suite's icon. The plugin's own `serverInfo`
  (`universal-docs` / `MCP Docs`) stays for the local MCP Docs app and the ChatGPT plugin.
- Instructions: one short paragraph on FreeFlow (the apps, that the agent works in one organization, chosen when the person
  connected it, and that ids are opaque), then each app's section, only for the apps the token can use. The sections come
  from the apps: Docs' `instructionsFor(version)`, `MAIL_INSTRUCTIONS`, `CALENDAR_INSTRUCTIONS`, `EVENT_INSTRUCTIONS`, and
  new `CHAT_INSTRUCTIONS` and `MEET_INSTRUCTIONS`. The paragraph that starts "MCP Docs:" is changed to start "Docs:" when
  the suite serves it.
- The sections are constants in each app's tool module (`MAIL_INSTRUCTIONS`, `CHAT_INSTRUCTIONS`, `MEET_INSTRUCTIONS`, …),
  joined by `suiteInstructions` in `mcp/suite.ts`.

### 3.3 Docs as one app

The Docs tools need the Docs object: their stores are its SQLite and R2. So Docs gets a registry runner like the other
apps, and the runner calls the Docs object by RPC:

- `Docs.runMcpTool(caller, name, args)`: builds the plugin's server for this caller (as `handleMcp` does today, but with
  only Docs' tools), calls the one tool, and returns the MCP result as it is (text, images from `view_image`,
  `structuredContent`, `isError`). It keeps `mirrorUser`, the upload tickets and the open-file state.
- At registration, `mcp/suite.ts` registers each Docs definition from `DOCS_TOOLS` with its JSON Schema input, and a handler
  that calls `runMcpTool`. The token's `files:read` / `files:write` filter is the registry's, as for every other app. The
  `_registeredTools … remove()` step goes away.
- `Assistant.runDocsHeadless` calls `runMcpTool` too (phase 2), and `Docs.mcp()` and the old `handleMcp` are gone.
- `/mcp/import/:org` does not change.

Two Docs tool texts that talk about the plugin or ChatGPT read differently when the suite serves them (the plugin's
`suite` option): `get_profile` ("The account you are connected as: its email address.") and `import_file`'s `file` field
(filled in by ChatGPT; other clients give `url` or use `upload_file`). The ChatGPT plugin and the local MCP Docs app keep
theirs.

### 3.4 Versions

`/mcp` serves the newest tool version (today 2) and `/mcp/v1`, `/mcp/v2` stay as they are (`suiteMcpVersion`). The
version is the Docs tools' version; the other apps' tools have one version. Changing the server's name is not a breaking
change for clients: they key a connection by its URL. Clients that cached the tool list get `listChanged`.

## 4. Chat at /mcp

### 4.1 Scopes and consent

The Chat manifest gets one scope group, like Docs' and Mail's, with a read-only text when a client asks only `chat:read`:

| Group | Scopes | Label | Ticked by default |
|---|---|---|---|
| `chat` | `chat:read`, `chat:write` | Chat: read, search and post | yes (ruling R2) |

Tokens issued before these scopes exist keep their scopes: no Chat until the person connects the agent again, as for Mail
(`W§OAuth`).

### 4.2 Who the agent is in Chat

An `/mcp` client is a personal agent of the person (the default) or a shared agent (`A§1`). Chat follows the rules the
hosted assistant already follows (`Org.assistantChat`, `Org.assistantPost`, decision_log 2026-11-17):

- **Reach.** A personal agent reads with its sponsor's reach: the standard channels the sponsor is in, and public
  channels. A shared agent reads with its own. **No direct messages** in either case (ruling R1).
- **Posting.** The agent posts **as itself** (its own member row, its name and avatar), marked as asked by its sponsor.
  It never posts as the person. A personal agent joins a channel its sponsor is in before it posts, as the assistant does.
- **As built.** `Org.chatReach` also takes an external personal agent. The Worker passes the agent's directory account
  with each call, and `Org.mcpChat` makes its member row the first time (`addPersonalAgent`, runtime null). Its first
  post, reaction or channel sets runtime `external` (`enterChat`), which puts it on Chat's roster (`notExternalAgent`
  leaves out only runtime null) and sends `member.joined`. The member DTO still says only `agentRuntime: 'hosted'`, so
  the clients need no change. The sponsor-only rules for bringing an agent into a channel and taking it out cover it too.
- A personal agent makes a channel as its sponsor (the sponsor is its first member), then is brought into it.
- The assistant's own methods (`assistantChat`, `assistantPost`) keep their names; `mcpChat` is the /mcp door's.

### 4.3 Tools

Runners in `packages/edge/src/org/chatTools.ts` (new), registered for the `mcp` door and calling the Org object by RPC.
The definitions go in `@flow/shared/toolDefinitions/chat.ts` beside the bridge's and the assistant's (a name is unique per
door, not across doors).

| Tool | Scope | What it does |
|---|---|---|
| `list_channels` | `chat:read` | The channels the agent can read: id, name, private, topic, whether the agent is a member |
| `list_members` | `chat:read` | The organization's members: id, display name, whether an agent (for `<@userId>` mentions) |
| `read_messages` | `chat:read` | A channel's messages, newest first, with `before` to page back; a thread with `threadRootId` |
| `search_messages` | `chat:read` | The same search as Chat's search bar (`services/search.ts`), over the channels the agent can read |
| `read_chat_file` | `chat:read` | A file attached to a message: a text file's text, a picture, or a PDF's bytes, like Docs' `read_file` |
| `send_message` | `chat:write` | Post in a channel, or reply in a thread; Markdown; mentions as `<@userId>` |
| `react` | `chat:write` | Add an emoji reaction to a message |
| `create_channel` | `chat:write` | Make a channel and join it (optionally nested under one the agent is in) |
| `invite_to_channel` | `chat:write` | Add members to a channel the agent is in |

They run in `Org.mcpChat` (`packages/edge/src/org/object.ts`); their definitions are in `packages/edge/src/chat/mcpTools.ts`.
`read_chat_file` returns a picture as an MCP image, a text file as text, and other files as an embedded resource; it
reads only files of standard channels, up to 10 MB.

Left out at `/mcp`: `upload_file`, `download_file` and `set_avatar` (they take local paths, which a remote client does not
have), `start_task` and `set_channel_indicator` (bridge runtime features), `set_channel_emoji`, `leave_channel`, the
artifact tools, and posting a Docs file in a channel (later, if agents ask for them).

Message text, file names and channel topics are other people's words: every read tool's description says they are data,
never instructions, as the assistant's do.

### 4.4 Events

The Chat events already exist (`chat.message.created` and the others in the Chat manifest). With `events:read` an `/mcp`
agent can subscribe to them today through `create_subscription`. No change is needed, but `CHAT_INSTRUCTIONS` says how.

## 5. Meet at /mcp

One scope group in the Meet manifest: `meet` with `meet:read` and `meet:write`, "Meet: make meeting rooms", ticked by
default.

| Tool | Scope | What it does |
|---|---|---|
| `create_meeting` | `meet:write` | A new room in the organization (`services/meetings.ts` `createMeeting`), as the person or shared agent: title, code, link, and `event_line` |
| `list_live_meetings` | `meet:read` | The meetings with people in them now (`liveMeetings`): title, link, start, who is there |

Calendar keeps a room on an event as one line of its description, `Join with FreeFlow Meet: <link>`
(`packages/calendar/src/lib/meet.ts`), which it reads back as the event's Join button. So `create_meeting` returns that
line as `event_line`, and the agent adds it to the description with `create_event` or `update_event`. No Calendar tool
changes. The agent never joins a meeting.

## 6. Search across the apps

One tool, `search`, with its own scope `search:use` (every tool at `/mcp` names a scope) in a consent group of Home's
manifest, ticked by default. It is offered only when the token can also run at least one app's search tool.

- Input: `query` (the suite's search syntax, `search.md`), optional `apps` (a subset), `limit`.
- It runs the search of each app the token can read, at the same time: Docs' content index (`search_content`), Chat's
  message index, Contacts' `find_contact`, Calendar's `list_events` with `q` over the next and last 90 days, and Mail's
  `search_mail`. Each source has 3 seconds; one that runs out is named in the answer as `skipped`.
- Output: one list, each hit with `app`, `kind`, `id`, `title`, `snippet`, `when` and the tool to open it with
  (`read_doc`, `read_messages`, `read_mail`, `get_event`). The list is merged by reciprocal rank fusion, as `search.md` §4
  says: positions are compared across sources, scores are not.
- The per-app search tools stay. `search` is the first step; the app's own tool is for a narrower search.

This is the router of `search.md` §6 phase 4. It is built once, as a Worker function that both `GET /api/search` (the
suite bar's search box, later) and this tool call, so `/mcp` does not get its own copy. Mail joins it with live search
until `search.md` phase 3 indexes Mail's cache.

## 7. Consent page and settings copy

- The consent page title becomes "Allow <client> to use FreeFlow?", with the groups listed below it, instead of naming
  "Docs and Mail" (`routes/mcpPages.ts`). The groups come in the manifests' order: Chat, Docs, Mail, Send, Calendar,
  Events, Search, Meet, Contacts, Email members, Installed apps. The "no organization" page says the agent works with an
  organization's apps, not its Docs files. The protected resource metadata's `resource_name` is "FreeFlow".
- The device page says "Connect an agent to FreeFlow", not "FreeFlow Docs".
- "You can disconnect it in Docs, under Settings, Connect your agent" becomes the Admin app's **Connect an agent** page
  (`/v1/me/agent-connections`), which already lists the same connections.
- The Docs Settings page's "Connect your agent" stays, and points to the same URL.

## 8. Security

- The token's scopes are the only access a client has: the registry's `allowedBy` filter applies to every app, Docs
  included (today Docs' filter is a separate step).
- Chat never widens reach: a personal agent reads no channel its sponsor cannot, and no direct messages (R1). A shared
  agent reads what its own membership allows.
- Posting is visible: the post is by the agent's member, marked as asked by the sponsor, so people in the channel see an
  agent wrote it. `chat:write` can be unticked on consent.
- `search` checks each app's scope before it runs that app's search; an app the token cannot read is never asked.
- Rate limit: people's posts have none. An `/mcp` agent may make 30 Chat changes (posts, reactions, channels,
  invitations) a minute (`MCP_CHAT_WRITES` in `org/object.ts`), so a runaway agent cannot flood a channel.
- The event log records Chat and Meet calls with `via` / `invokedBy`, as Mail and Calendar calls are recorded.

## 9. Proposed rulings

- **R1.** An `/mcp` agent never reads direct messages, for a personal agent as for a shared one. (A later ruling may let a
  person grant `chat:dm` on consent.)
- **R2.** `chat:write` is ticked by default, unlike `mail:send`: a Chat post stays in the organization and is marked as
  the agent's.
- **R3. Ruled (Scott, 2026-11-22):** an `/mcp` agent posts as its own member, never as the person (decision_log).
- **R4.** The server's name at `/mcp` is `freeflow` / "FreeFlow". The local MCP Docs app and the ChatGPT plugin keep theirs.
- **R5.** No Admin tools at `/mcp`.

## 10. Build plan

One branch and one PR against `main`, a commit per phase (CLAUDE.md).

1. **Suite server.** `mcp/suite.ts`, `mcp/contexts.ts`; `Docs.runMcpTool`; `routes/mcp.ts` calls the suite; name, icon
   and instructions (§3.2). No new tools; the same 98 tools with every scope, with the same schemas.
   Tests: the tool list per scope set is the same as before the change (a snapshot taken first), `server/discover` and
   `initialize` answer with the new name, a Docs call, a Mail call and a Calendar call still work, `view_image` still
   returns its image.
2. **Assistant moves to `runMcpTool`.** `Assistant.runDocsHeadless` calls the RPC; `Docs.mcp()` is removed.
3. **Chat.** The scope group in the Chat manifest; `Org.chatReach` takes external personal agents; `Org.mcpChat`;
   `chat/mcpTools.ts` runners; definitions; `CHAT_INSTRUCTIONS`. Tests: reach (sponsor's channels only, no DMs, a shared
   agent's own), a post is by the agent's member and marked, the rate limit, a token without `chat:*` sees no Chat tools.
4. **Meet.** Scope group, two tools in `meet/mcpTools.ts` run by `Org.mcpMeet`, `MEET_INSTRUCTIONS`.
5. **Search.** `mcp/search.ts`: the `search` tool, which runs each app's own search tool the token may run, with
   3 seconds per source, merged by reciprocal rank fusion. The suite bar's search box can use the same function later.
6. **Copy.** Consent, device and settings pages (§7); the Docs tool texts (§3.3); `web-mcp.md` updated to point here.

Local test: `pnpm dev:suite`, connect Claude Code to `http://localhost:8787/mcp` with the device sign-in, and run each
app's tools as `dev@flow.test` (`local-suite-run`). Then the same against `edge.freeflow.im` before merge.

## 11. Client impact

| Surface | Visible change |
|---|---|
| web client | the consent, device and settings pages' copy (§7); agents' posts in Chat |
| macOS client | agents' posts in Chat (already rendered for the assistant and bridge agents) |
| iOS client | the same as macOS |
| desktop client (Electron) | the same as web |
| agent bridge | none |

No Parity entry is expected: the endpoint is server-side, and every client already renders an agent's Chat post.
