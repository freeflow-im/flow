# Docs' MCP endpoint on the suite's host: app.freeflow.im/mcp

Agents (Claude Code, Codex, Cursor, claude.ai's connectors) connect to `https://app.freeflow.im/mcp` and work on the same
Docs files people see in FreeFlow Docs at `/workspace`. Built 2026-11-03 on the Worker (`packages/edge`). The ChatGPT
plugin's `/mcp` on `docs.freeflow.im` and `mcpdocs.freeflow.im` is a different server and stays on AWS
(decision_log 2026-11-03).

The tools each door lists come from the suite's tool registry (platform.md §5.4, phase 6.2): the definitions are
`@flow/shared/tools` (`TOOL_DEFINITIONS`, written from the implementations by `packages/edge/src/registry/registry.test.ts`),
and `toolsFor` in `packages/edge/src/registry` gives `/mcp` the server tools whose scopes the token has, the assistant every
server tool plus the open app's browser tools, and the bridge its definitions over `GET /v1/tools?door=bridge`.

## OAuth, with the organization chosen on consent

Authorization happens before an organization is known, so its state lives in the **directory object**, not in a Docs
object: `src/directory/mcpOAuth.ts` (`McpOAuth`), the plugin's `OAuthServer` (`src/docs/plugin/server/oauth.ts`) moved to
the directory's SQLite (migration 5 of `src/directory/schema.ts`: `oauth_clients`, `oauth_pending`, `oauth_codes`,
`oauth_tokens`, `oauth_connections`, `oauth_device`). The Worker calls it through `Directory.oauth(method, args)`, which
returns OAuth errors as data (`OAuthAnswer`).

- **Same endpoints and rules as the plugin.** `/.well-known/oauth-authorization-server`,
  `/.well-known/oauth-protected-resource[/mcp[/v2]]` (also under `/mcp/.well-known/...`), `/oauth/register` (dynamic
  registration; an `https` client id is a client metadata document), `/oauth/authorize`, `/oauth/consent`,
  `/oauth/decision`, `/oauth/token` (code with PKCE S256, refresh rotation with reuse detection, the device grant),
  `/oauth/revoke`, `/oauth/device_authorization` and `/oauth/device`. Scopes `files:read`, `files:write`, `mail:read`,
  `mail:write`, `mail:send`, `calendar:read` and `calendar:write` (in `scopes_supported` of both metadata documents; see Scopes below). Only hashes
  of codes and tokens are stored; access tokens last an hour (a device sign-in's a week), refresh tokens 30 days.
- **The issuer and resource are the request's origin**: `https://app.freeflow.im` and `https://app.freeflow.im/mcp` (on the
  rehearsal host, `edge.freeflow.im`'s).
- **Sign-in is FreeFlow's session** (the `sid` cookie only; a bearer token cannot approve an agent). Without one,
  `/oauth/authorize`, `/oauth/consent` and `/oauth/device` send the browser to `/?next=<the consent page>`, as `/workspace`
  does. There are no sign-in, sign-up or Google pages on this host.
- **Consent chooses what the agent may use**, as checkboxes (`SCOPE_GROUPS`, `offeredGroups`, `grantedScope` in
  `mcpOAuth.ts`), each offered only when the client asked for one of its scopes (no `scope` asked = all of them):
  **Docs files** (`files:read files:write`, on), **Mail: read, search, organise and draft** (`mail:read mail:write`, on) and
  **Send email as you** (`mail:send`, **off**, with a warning line). The token gets the ticked groups' scopes among those
  asked for, never more; nothing ticked is refused (403, the page again). The form carries `scopes_form=1` and
  `grant_docs`/`grant_mail`/`grant_send`; a decision posted without `scopes_form` gets the groups as the page starts them.
  A device sign-in's row takes the granted scope at the decision. Tokens issued before mail existed keep their scopes:
  no mail until the person connects the agent again.
- **Consent chooses the organization.** The page (`src/routes/mcpPages.ts`) lists the person's organizations from the
  directory's memberships, named by each organization's object, with the one they last connected an agent to preselected
  (else the first); one organization is still shown by name. It names the client and the scopes, and says the agent will
  read and edit that organization's Docs files: Organization files and the person's My files there.
- **The decision is protected** by the session cookie (SameSite=Lax: another site's form posts without it), the pending
  authorization's CSRF token in the form, the person signed in being the one the consent page was shown to, and an
  `Origin` header, when sent, being this host. The page cannot be framed. The chosen organization must be one of the
  person's (else 403, and the authorization stays pending).
- **The organization goes with the grant**: `org_id` on the code, its tokens and their refreshes, the connection and the
  device grant.

## /mcp

`src/routes/mcp.ts` authenticates the bearer token in the directory (`McpOAuth.authenticate`), which also re-checks that
the person is still a member of the token's organization and still has an account: if not, 401 with
`WWW-Authenticate: Bearer resource_metadata=".../.well-known/oauth-protected-resource/mcp", error="invalid_token"`, and
the refresh token stops working too. A request with no token gets the same challenge without the error.

The request then goes to that organization's Docs object (`Docs.mcp`), which runs the plugin's tools
(`src/docs/plugin/server/mcp.ts`) on its own stores (`src/docs/plugin/server/worker.ts`) as that person, with the
organization as the current one (`withDocsContext`):

- **Files**: the tools list and search the organization's Organization files and the person's My files there; a file by
  id is any of those (`FileService.who`, `roots`, `home` over `server/scope.ts`). New files and folders go in **My files**.
  Listed and created files say which (`root`) and carry their page, `https://app.freeflow.im/workspace/s/<id>` and the like.
- **Version**: `/mcp` serves the newest tools (version 2: folders, `search_files`, `read_file`, `upload_file`); `/mcp/v2`
  the same. The ChatGPT app is left out (`level: 'tools'`: no UI resource, no app-only tools).
- **Scopes**: a token without `files:write` gets only the Docs tools annotated read-only, and one with neither `files:read`
  nor `files:write` none of them; the Mail tools are listed by their own scopes (below). A tool the scopes do not allow is
  not listed, and calling it is "Tool not found". The server's instructions say only what the token can use
  (`suiteInstructions`: Docs' when it has files, Mail's when it has mail).
- **Transport**: Streamable HTTP POST with JSON responses, stateless; the 2026-07-28 protocol (`server/discover`,
  `resultType`) as in `stateless.ts`. GET answers 405 (no stream).
- **Uploads**: `upload_file` returns `https://app.freeflow.im/mcp/import/<org>?ticket=...`; the ticket is kept in the Docs
  object's SQLite (`_mcp_tickets`), works once, for five minutes.
- The person is mirrored into the object's `users` on each request, as `/api` does, so files they make keep their owner.

## Mail tools

Mail is a person's, not an organization's: the Mail tools act on the token's person's own **Mail** object
(`idFromName(userId)`, `src/imap/object.ts`), whatever organization was chosen. They are defined once in
`src/imap/mailTools.ts` (`MAIL_TOOLS`: a Zod shape, a description written for the model, the scopes each needs, MCP
annotations, and `run`) and registered on the same MCP server as the Docs tools, inside the organization's Docs object
(`registerMailTools` in `src/docs/plugin/server/worker.ts`), so `tools/list` is one list. The Docs object reaches the Mail
object through the Worker's `MAIL` binding (`Docs.mailOf`), over its HTTP API (`docs/specs/mail-api.md`).

| Tool | Scopes | What it does |
| --- | --- | --- |
| `list_mail_accounts` | mail:read | accounts: id, email, name, inbox tabs, status |
| `list_mail_folders` `{ account? }` | mail:read | folders: path, role (special use), unread, total |
| `search_mail` `{ query?, account?, folder?, tab?, unread_only?, limit? ≤ 50, before? }` | mail:read | summaries (id, from, to, subject, date, snippet, unread, starred, has_attachments, tab) and `next`; `query` is Gmail search syntax on Gmail (`X-GM-RAW`), words elsewhere; none = newest |
| `read_mail` `{ ids ≤ 20 }` | mail:read | headers, body as text (HTML made readable, links as `text (address)`, cut at 50,000 characters), attachments; does not mark read |
| `save_mail_attachment_to_docs` `{ id, index }` | mail:read + files:write | imports the attachment into My files of the token's organization (`FileService.importFile`, the importer Save to Docs uses); returns the file's id, kind and link for the Docs tools |
| `mark_mail` `{ ids, read?, starred? }` | mail:write | flags |
| `move_mail` `{ ids, to_folder }` | mail:write | move within the account |
| `archive_mail` `{ ids }` | mail:write | to the Archive folder, else All Mail |
| `move_mail_to_tab` `{ ids, tab }` | mail:write | Move to tab: applies to the senders |
| `trash_mail` `{ ids }` | mail:write | to Trash, never expunged (`trashOnly`); no permanent delete tool |
| `create_mail_draft` `{ account?, to?, cc?, bcc?, subject?, body, reply_to_id?, reply_all?, forward_id? }` | mail:write | a draft in Drafts (`\Draft`); body Markdown → HTML and text; replies thread and quote, forwards carry attachments (`mailText.ts` `prefill`, the server's copy of Mail's `lib/compose.ts`); returns `draft_id` and a link to it in Mail |
| `send_mail` (the draft's arguments, or `draft_id`) | mail:send | sends (Sent gets a copy); a draft is sent as it is and leaves Drafts |

- **Ids** are `<accountId>:<folder>:<uid>` (`messageId`, `parseMessageId`): opaque to agents, which the descriptions say.
  The account id has no colon and the UID is last, so folders with colons parse. An id naming an account the person's
  object does not have (another person's) is "Not found", like any unknown id.
- Errors the agent can act on come back as tool errors (`MailToolError`): no account connected (with the link to Mail), a
  login the server refused, a bad id, a tab where there are none.
- **The Docs assistant** (edge copy of `server/agent`) has `search_mail`, `read_mail`, `create_mail_draft` and
  `save_mail_attachment_to_docs` (`assistantMailSchemas`, `runAssistantMailTool`; never `send_mail`), with a line in its
  prompt: it drafts and gives the link, and the user sends from Mail. Saved attachments go in the chat's scope. These are
  on the Worker only; `packages/docs` (desktop, AWS) has no Mail. The Workspace client labels them (`describe.ts`).
- **The assistant in Mail.** FreeFlow Mail's Assistant button opens the same assistant in a panel (`packages/mail`:
  `components/AssistantPanel.tsx`, `hooks/assistant.ts`, `lib/assistant.ts`), in the Docs object of the organization the
  suite bar has selected (`?workspace=` on `/api/agent*`), in a chat of its own (`MAIL_CHAT`, `'mail'`). Each turn sends a
  `page: 'mail'` context (`MailContext` in `shared/agent/protocol.ts`): the account, folder, inbox tab and search, the open
  message (`id` in the tools' form, subject, from, date) and the checked messages' ids; `renderMailContext` (`prompt.ts`)
  quotes the email's text so it cannot close the block. The browser tool `open_mail_message` shows a message in Mail
  (Docs refuses it; Mail refuses Docs' browser tools). `tool_end` and the transcript carry the result of the tools in
  `SHOWN_RESULTS` (`create_mail_draft`, `save_mail_attachment_to_docs`), so the chat shows **Open draft** (Compose with the
  draft) and **Open in Docs**; a draft made refreshes Mail's lists. The panel reuses Docs' protocol, stream reader
  (`client/src/agent/stream.ts`), tool labels and `ChatMarkdown` from Docs' sources (`src/lib/docsAgent.ts`).
- **The bridge's `flow` MCP** (0.37.8, platform phase 5.4) has `list_mail` `{ folder?, limit?, unread_only? }` and these
  arguments' `search_mail` `{ query, folder?, limit? }`, `read_mail`, `send_mail` `{ to?, cc?, subject?, body, reply_to_id? }`,
  `move_mail` and `mark_mail`, calling `/v1/mail/*` as the agent with `?workspace=` on its hosted mailbox
  (`packages/agent-bridge/src/mail-tools.ts`; no hosted account → "no mailbox yet", not an error). `mail.received` from a
  member of the organization starts a turn in the DM with them (the sponsor's, for an agent's mail), naming the message id;
  outside mail is ignored unless `agent.json` has `mail.fromOutside: "wake"`.
- Tests: `src/imap/mailTools.test.ts` (ids, scope gating, the tools against a fake Mail object), `mailText.test.ts`
  (HTML to text, Markdown, reply and forward, a draft's MIME), `mailMcp.test.ts` (`tools/list` per scope set through
  `handleMcp`), `assistantMail.test.ts`, and `test/e2e-mail-mcp.mjs` against GreenMail (its header says how).

## Calendar tools (2026-11-05)

A calendar is a person's too: the Calendar tools act on the token's person's own **Calendar** object (`idFromName(userId)`,
`src/calendar/object.ts`), whatever organization was chosen, defined once in `src/calendar/calendarTools.ts` (`CALENDAR_TOOLS`,
as `MAIL_TOOLS` are) and registered beside the Docs and Mail tools (`registerCalendarTools` in `worker.ts`). The Docs object
reaches the Calendar object through the Worker's `CALENDAR` binding (`Docs.calendarOf`), over its HTTP API
(`docs/specs/calendar.md` §4). Consent has a **Calendar: see and change your events** checkbox (`calendar:read calendar:write`,
on as the page starts; a client asking for `calendar:read` alone is offered "Calendar: see your events"). Tokens made before
the scopes existed keep theirs: an agent reconnects to get the Calendar tools.

| Tool | Scopes | What it does |
| --- | --- | --- |
| `list_calendars` | calendar:read | calendars: id, name, account, `native` (the FreeFlow calendar) or not, role (owner, manager, editor, viewer), read_only, hidden, default, timezone; then the native calendars shared with the person (`shared: true`, `owner_account`); accounts needing attention |
| `list_shared_calendars` | calendar:read | only the shared ones (`GET /v1/calendar/shared`): id, name, role, owner_account |
| `list_events` `{ from, to, calendars?, q?, limit? ≤ 200 }` | calendar:read | occurrences in a window of ≤ 93 days, oldest first (shared calendars when named, one request per owner, merged): id, series_id, summary, start, end, all_day, timezone, calendar, location, video_call, repeats (in words), status, organizer, attendees with responses, my_response, link |
| `get_event` `{ id }` | calendar:read | one event or occurrence in full (description, recurrence lines and in words, reminders), and its series; a shared calendar's too |
| `find_free_time` `{ duration_minutes, from, to, attendees?, working_hours?, timezone? }` | calendar:read | free slots in ≤ 31 days where the person (the shown calendars, less free and declined events) and the attendees (`POST …/freebusy`: members of the organization from their own objects, busy only; others by the CalDAV outbox) are free, within working hours (09:00–17:00 Mon–Fri in `timezone` unless given; `null` for any time), longest first; `members` lists who was read from their object, `unknown` whose calendars cannot be seen |
| `create_event` `{ summary, start, end, all_day?, timezone?, location?, description?, attendees?, optional_attendees?, recurrence?, reminders_minutes?, calendar_id? }` | calendar:write | creates on the person's native calendar (the default when it is native, else their FreeFlow calendar) or `calendar_id` (a connected one, or a shared one as editor); attendees by address: members are scheduled by object call (`scheduled_to_members`), others emailed (`emailed`, or `not_emailed` with `invitations_note`); a connected server invites its own; returns the event (its calendar, `native`) and who was invited |
| `update_event` `{ id, scope?, …the same fields }` | calendar:write | changes only what is given; `scope` this / following / all for an occurrence; `calendar_id` moves the whole event; a guest's change is the server's `not_organizer`, a viewer's `forbidden`, said in words; who was told as for create |
| `delete_event` `{ id, scope? }` | calendar:write | deletes (destructive annotation); this / following / all for an occurrence; `cancelled_for_members`, `emailed` |
| `respond_to_event` `{ id, response, comment? }` | calendar:write | accepted / declined / tentative, for the series (its id) or an occurrence; `organizer_told` (`server` for a member organizer) |
| `share_calendar` `{ calendar_id, principal: { account? \| channel? \| org?: true }, role }` | calendar:write | grants viewer / editor / manager on a native calendar (`PUT …/grants`); `account` is an address, resolved through the directory to an account of the organization (anyone else refused); returns the grants |
| `unshare_calendar` `{ calendar_id, principal }` | calendar:write | takes the grant away (`DELETE …/grants/:principal`) |

- **Ids** are the API's `<calendarId>:<uid>[:<recurrenceId>]`, opaque (`checkEventId` checks the shape only). Since phase 4.3
  the tools' fetch takes the routes' path (`calendar/forward.ts` `calendarRequest`): a native id of another account goes to its
  owner's object as a reader (`handleShared`, role checked there), `/shared` to the share index. An id the person has no role on
  is "Not found".
- Errors as tool errors (`CalendarToolError`): no calendar connected (with the link to Calendar), a refused login, a bad id,
  a window too long, a conflict (read the event again and repeat).
- **The Docs assistant** (edge copy of `server/agent`) has all eleven (`assistantCalendarSchemas`, `runAssistantCalendarTool`),
  with prompt lines: it creates and changes events on the person's own calendars and says what it did, invites members by
  address, checks free time before proposing one, says a viewer cannot change a shared calendar, shares only when asked, and
  never deletes without being asked. Its `delete_event` is a browser tool (`CLIENT_TOOLS`): Calendar asks in
  its panel (Delete / Keep it) and Docs asks with `confirmationFor`, then each deletes through `/v1/calendar`; Mail refuses it
  as it refuses any tool it does not run. `packages/docs` (desktop, AWS) has no Calendar tools.
- **The assistant in Calendar.** The suite bar's Assistant opens the same panel as Mail's (`packages/calendar`:
  `components/AssistantPanel.tsx`, `hooks/assistant.ts`, `lib/assistant.ts`), in the organization the bar has selected, in a
  chat of its own (`CALENDAR_CHAT`, `'calendar'`). Each turn sends a `page: 'calendar'` context (`CalendarContext`): the view,
  the range shown, the browser's zone, the calendars shown and the open event (id, summary, when, calendar, `native`, the
  person's `role` on its calendar);
  `renderCalendarContext` quotes the event's text so it cannot close the block. Browser tools `open_calendar_event` and
  `show_calendar_range` run in Calendar (Docs refuses them). `create_event` and `update_event` are in `SHOWN_RESULTS`, so the
  chat shows **Open event**; a change by a Calendar tool refreshes the views.
- **The bridge's `flow` MCP** (0.37.7) has `find_free_time` and `create_event` beside 4.2's three, calling `/v1/calendar/*` as
  the agent (`packages/agent-bridge/src/calendar-tools.ts`), so an agent proposes and books a meeting from a DM.
- Tests: `src/calendar/calendarTools.test.ts` (ids, scope gating, the tools against a fake Calendar object, native and shared
  calendars, sharing, free slots), `scheduling.test.ts` (`find_free_time` over three accounts' objects),
  `calendarMcp.test.ts` (`tools/list` per scope set), `assistantCalendar.test.ts`, Calendar's `lib/assistant.test.ts`, and
  `test/e2e-calendar-mcp.mjs` against Radicale (its header says how).

## Managing connections

Docs' Settings, Connect your agent (`/api/settings/agents`), is answered by the Worker on the ported hosts from the
directory: every agent connected to the account (code flow and device sign-ins), with its organization's name, and
Disconnect revokes its tokens at once.

## Tests

`src/directory/mcpOAuth.test.ts` (the authorization server over node:sqlite), `src/index.test.ts` (which host serves
what), `test/e2e-mcp.mjs` against `wrangler dev` (its header says how), and the Mail tools' tests above.
