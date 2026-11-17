# Chat visitors — let someone into one channel by a link (draft 2026-11-16)

Status: **draft, rulings in** (operator, 2026-11-16). Technical plan (§4–§7) not yet reviewed.

A **visitor** is a person with no account. A member makes a **visitor link** for a public channel and sends it. The
person opens it, types their name, and is in that one channel: they can read and post, but they see **only messages
from after they joined**. Nothing else in the organization is open to them.

Visitors are also how Meet guests take part in a meeting's chat: each meeting gets its own channel, and a guest who
joins the meeting becomes a visitor of that channel (docs/specs/meetings.md, the meeting chat phase). Because a visitor
sees nothing from before they joined, one channel per meeting room is safe even when the room is used for many
meetings.

## 0. Rulings (operator, 2026-11-16)

| # | Ruling |
|---|---|
| V1 | **A visitor sees only what was posted after they joined** ("sees from" time). Checked on the server, everywhere. |
| V2 | **No search** for visitors. |
| V3 | **Threads**: a visitor sees no part of a thread whose first message is older than their "sees from" time, not even new replies. |
| V4 | **Edits, reactions and deletes on older messages never reach a visitor.** |
| V5 | **Visitors cannot message agents.** A visitor's message never asks an agent, and the mention picker offers no agents. |
| V6 | **Public channels only.** No visitor links for private channels, DMs or group DMs. (Meeting channels are their own kind and allow visitors.) |
| V7 | **A visitor link works for 24 hours** after it is made. |
| V8 | **A visitor's access ends 30 days after their last visit**, or sooner when a member removes them. |
| V9 | **Visitors can upload files**, with the normal size limits. |
| V10 | **Turnstile on the name screen, and rate limits** on joining and posting. |
| V11 | **Web only for now.** The native apps show visitors' messages but cannot make visitor links. |
| V12 | **"Visitor", not "guest"**: a guest is already an account kind (a member with no mailbox, docs/specs/platform.md §2). A visitor has no account and is never a member. |

## 1. What people see

### 1.1 Making a visitor link (members)

- In a public channel's header menu: **Invite a visitor**. It makes a link and shows it with **Copy** and the time it
  stops working ("Works until tomorrow 3:40 PM").
- The same dialog lists the channel's **open links** (who made each, when it ends, how many people came in by it) with
  **Turn off**. Turning a link off also removes every visitor who came in by it.
- Any member of the channel can make a link. An owner or admin can turn visitors off for the whole organization
  (Admin → Settings, "Visitors in channels", on by default). With it off, the menu item is gone, open links stop working
  and current visitors lose access.
- The item is not there in private channels, DMs and group DMs (V6), or for guest accounts.

### 1.2 Joining (the visitor)

- The link is `/chat/visit/<token>`. It opens a small page: the organization's name and icon, the channel's name and
  topic, a **Your name** field (1 to 40 characters), the Turnstile check and **Join**.
- After Join they are in the channel. A system line tells the channel "Ann joined as a visitor" (as join messages do
  today).
- A cookie keeps them signed in to that one channel in that browser. Opening the link again, or the channel page, on the
  same browser brings them back as the same visitor with the same "sees from" time, even after the link itself has
  stopped working. A new browser, or a cleared cookie, after the link has stopped working cannot get back in.
- An expired or turned-off link shows "This link no longer works. Ask the person who sent it for a new one."

### 1.3 The visitor's page

A plain channel view, with no sidebar and no suite bar:

- The channel name and topic, and a line under the name: "You are a visitor. You see messages from when you joined."
- The message list from the "sees from" time on, with threads, reactions, files and link previews.
- The composer: text, emoji, files (V9), and @mentions of the channel's people (not agents, V5).
- They can edit and delete their own messages, react, reply in threads that started after they joined.
- **Leave** in the header ends their visit (the cookie is cleared and their access removed).
- No search (V2), no pins list, no member directory, no profile pages, no DMs, no notifications or email.

### 1.4 What members see

- A visitor's name carries a **Visitor** label everywhere it shows (messages, mentions, the channel's people list).
- The channel's people list has a **Visitors** section, with **Remove** for any member.
- Visitors do not count as members anywhere else: not in the organization's people, Admin's accounts or seats.

## 2. The "sees from" rule

Every read a visitor makes is cut to their channel and their "sees from" time, on the server:

| Read | Rule for a visitor |
|---|---|
| Message list | only top-level messages created at or after "sees from" |
| Threads | only threads whose first message is at or after "sees from" (V3) |
| One message, a link to a message | 404 unless it passes the two rules above |
| Live events | only events about messages that pass the rules (V4): a new message, a reply, and edits, deletes and reactions on those messages; never events about older ones, other channels or the organization |
| Reconnect backlog | the same filter as live events |
| Files | a file can be opened only through a message the visitor can see; the channel's file list is cut the same way |
| Pins, search, the directory | not open to visitors (V2) |
| Channel name, topic, the people in it | open: names and avatars of the channel's members and visitors, for display and mentions |

What members write after a visitor joined is visible to that visitor, including a quote of something older, or an
agent's answer to a member. That is the member's choice, as with forwarding.

## 3. Agents

- A visitor's message never asks an agent: hosted, shared or bridge (V5). This holds even in a thread an agent is in.
- The visitor's mention picker leaves agents out, and the server ignores a mention of an agent in a visitor's message.
- Agents still see visitors' messages as part of the channel, as they see any channel message.

## 4. Data model (org object)

```
users                     + a visitor is a users row: is_visitor = 1, a made-up email visitor-<id>@visitors.flow.local,
                            password_hash '!visitor' (as agents are made today). No workspace_members row, no directory
                            user: so every member route already refuses a visitor.
visitor_links             id, channel_id, token_hash, created_by, created_at, expires_at (created_at + 24 h),
                            revoked_at
channel_visitors          channel_id, user_id, link_id, sees_from (ms), last_seen_at, removed_at
visitor_sessions          token_hash, user_id, channel_id, created_at   (the cookie's token; deleted on removal)
workspaces.policies       + visitors: 'on' | 'off' (default 'on')
```

- The directory indexes each link's token hash to its organization (as invitations and join links are), so
  `/v1/visit/<token>` finds its organization object without a session.
- A visitor whose access ended keeps their `users` row (so old messages keep their name) but loses their session and
  their `channel_visitors` row is marked removed. A daily sweep removes visitors 30 days after `last_seen_at` (V8).

## 5. API

Public (no session), rate limited per IP and per link:

| Route | |
|---|---|
| `GET /v1/visit/:token` | preview: organization name and icon, channel name and topic, `expiresAt`; 404 when unknown, ended, turned off, or visitors are off |
| `POST /v1/visit/:token` `{ name, turnstile }` | checks Turnstile, makes the visitor and their `channel_visitors` row (`sees_from` = now), sets the `vsid` cookie (HttpOnly, path `/v1/visitor`), posts the join line |

With the visitor cookie (`vsid`), a separate set of routes. Each one checks the visitor's session, their channel and the
"sees from" rule, then calls the same services members use, with the cut applied:

| Route | |
|---|---|
| `GET /v1/visitor/me` | the visitor, their channel (name, topic, people), `seesFrom` |
| `GET /v1/visitor/messages?before=` | the message list (§2) |
| `GET /v1/visitor/messages/:id/thread?after=` | a thread (§2, V3) |
| `POST /v1/visitor/messages`, `PATCH`/`DELETE …/:id` | post, edit and delete their own messages and replies |
| `PUT`/`DELETE /v1/visitor/messages/:id/reactions/:emoji` | reactions on messages they can see |
| `POST /v1/visitor/files` | upload (normal limits), and opening a file through a visible message |
| `POST /v1/visitor/leave` | ends the visit |
| `GET /v1/visitor/ws` | the live socket (first frame `{ op: 'visitor', token }`), filtered by §2 |

Members:

| Route | |
|---|---|
| `POST /v1/channels/:id/visitor-links` | make a link (member of a public channel, visitors on); returns the URL once |
| `GET /v1/channels/:id/visitor-links` | open links |
| `DELETE /v1/visitor-links/:id` | turn off a link and remove its visitors |
| `GET /v1/channels/:id/visitors`, `DELETE /v1/channels/:id/visitors/:userId` | list and remove visitors |

Why a separate route set rather than letting visitors into the member routes: a visitor has no `workspace_members` row,
so every existing route keeps refusing them with no change. The cut lives in one place (the visitor routes and the
socket filter), and a member route added later is closed to visitors without anyone remembering to close it.

## 6. Live events

- The org object's `broadcast` gets one more kind of socket, a visitor's. A visitor socket receives only subjects for
  its own channel, and only events that pass §2 (it looks up the message's, or the thread root's, creation time).
- Every event is also sent with the user DTO's new `visitor: true` field where a visitor is the author, so clients can
  show the label.
- Removing a visitor, turning off their link, or turning visitors off closes their socket and deletes their session.

## 7. Clients

- **Web (Chat)**: the visitor page at `/chat/visit/<token>` and the channel view for a visitor (§1.2, §1.3), reusing
  the message list, thread and composer components; Invite a visitor and the Visitors section (§1.1, §1.4).
- **Admin**: the "Visitors in channels" switch.
- **macOS, iOS, desktop**: show the Visitor label on a visitor's name (from `visitor: true`). No Invite a visitor yet
  (V11); a Parity line records it. Older native builds show a visitor's name with no label.
- **Agent bridge**: no change needed (it already answers only workspace members), but its `addressedToMe` should
  check the new field too.

## 8. Build

One branch, one PR, phases as commits:

1. **Server**: tables, policy, link and visitor routes, the §2 cut, the socket filter, agents left out, the sweep,
   Turnstile check (a new `TURNSTILE_SECRET` Worker secret; the operator makes the Turnstile widget), tests for every
   row of §2.
2. **Web**: the visitor page, Invite a visitor, the Visitors section, the Visitor label; Admin switch.
3. **Native labels**: the Visitor label on macOS and iOS (small), Parity line for links.

Then Meet builds on it: a channel of kind `meeting` per room, kept out of channel lists, a "Meetings" list in the
sidebar, chat in the meeting's side panel, and Meet guests as visitors.

## 9. Open

- **Turnstile widget**: needs the operator to make one in the Cloudflare dashboard (site key in the client, secret as a
  Worker secret). Until then the join works without it in dev only.
- **Mentions of a visitor** by members: should a visitor see a sign that they were mentioned (no email, so only on the
  page)? Proposed: yes, a highlight on the message, nothing more.
