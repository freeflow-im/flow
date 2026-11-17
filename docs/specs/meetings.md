# FreeFlow Meet — video meetings and huddles on Cloudflare RealtimeKit (2026-11-13, live from 2026-11-16)

Status: **phases 1, 2, 3 and 3b built and live** (2026-11-17); phase 4 next. Keep the table below current: update it in
the PR that changes it.

## Status and TODO (updated 2026-11-17)

**Live**

| What | PR |
|---|---|
| Meetings on the web: start now, copy link, Live now, the room (phase 1) | #838 |
| Huddles from Chat on RTK; LiveKit gone from server, web and bridge (phase 2) | #838, #840, #841 |
| Guest links, check screen, lock, Calendar "Add FreeFlow Meet", booking page `meet`, Home Today Join (phase 3) | #843 |
| Meet home: Schedule in Calendar, Join with a code or link, Today; meeting takes the event's title | #845 |
| Chat visitors: one public channel by a 24-hour link (docs/specs/chat-visitors.md) | #852 |
| Meeting chat: a channel per room, Meet's Chat tab, Chat › Meetings, guests as visitors (phase 3b) | #853 |
| Side panel width can be dragged | #855 |
| The tab closes itself 30 s after leaving | #857 |

**TODO**

1. Operator: release macOS and iOS (§7 step 2), then remove the `LIVEKIT_*` Worker secrets and close LiveKit Cloud
   (§7 step 3).
2. Phase 4, after the meeting (recording, transcript, summary, meeting page). Waiting on four answers: who can turn
   recording on (proposed: the host, per meeting); transcript a separate button (proposed: yes); same buttons in
   huddles (proposed: yes); how long recordings are kept (proposed: until deleted). Outputs go to the meeting's chat.
3. Phase 5, agents as note takers. Phase 6, native (iOS on RTK, a Meet window on macOS).
4. Smaller items:
   - Turnstile on Meet guest join (Chat visitor join has it).
   - "Make a new link" for a meeting; more than one host per meeting.
   - The "Meeting started" line uses the time zone of whoever starts the session.
   - Chat inside Home draws no sidebar, so no Meetings item there.
   - Visitors and guests see initials, not avatar pictures (`/v1/avatars` has no visitor route).
5. Parity gaps (CHANGELOG.md Parity): macOS and iOS show no Visitor label, no Meetings list and no in-meeting chat.
6. Watch: one deploy (#855) failed with Cloudflare 10021 "Script startup exceeded CPU time limit"; a re-run passed.

Meet is a new suite app for video meetings, on Cloudflare RealtimeKit (RTK). It **replaces LiveKit**: Chat's huddles
become Meet meetings that start from a channel or DM. So there is one call system in FreeFlow: a meeting can be
started from Chat, put on a calendar event, booked on the booking page, or sent as a link to anyone, and it can be
recorded, transcribed and summarised.

Docs read: RealtimeKit overview, concepts (meeting, participant, preset), quickstart, SDK selection, Core SDK,
webhooks, recording, Meeting AI, Agent Participant and its capability matrix, audio calls, pricing (2026-11-13).

## 0. Rulings (operator, 2026-11-13)

| # | Ruling |
|---|---|
| R1 | **Move off LiveKit to RTK.** Huddles become Meet meetings. Agents get no audio in meetings (RTK agents cannot send or receive audio yet: "Agents that speak are not supported yet"); see R6. |
| R2 | **Guests go straight in.** No waiting room by default. |
| R3 | **Meet is its own suite app** (`/meet`). |
| R4 | **"Start a huddle" in a Chat channel instantly starts a meeting in Meet with the people of that room.** |
| R5 | **Huddles only in rooms of 6 or fewer people** (channel, DM or group DM). Bigger rooms start a meeting from Meet. |
| R6 | **Delete agent voice calls in DM huddles** (the bridge's LiveKit voice session). It never worked well; not a "later" item. |
| R7 | **Recording and transcripts off by default**, one click to turn on, a badge for everyone while on (was P1). |

Still open (proposed):

| # | Question | Proposal |
|---|---|---|
| P2 | Web UI | Our own layout and controls on the RTK Core SDK, rather than the stock UI Kit. **Operator wants to see our designs first** (mockups, 2026-11-13). |
| P3 | macOS | RTK has **no macOS SDK**. macOS opens the web meeting page in its own window (`WKWebView`). iOS uses the native RTK iOS SDK. |
| P4 | Who is rung | With R5 (6 or fewer people), **everyone in the room is rung**, in channels as in DMs. Count human members only; agents do not count toward the 6. |

## 1. What a person can do

### 1.1 Start a huddle from Chat (R4)

- In any channel, DM or group DM, the header has **Huddle** (same place as today's huddle button).
- One click: a meeting starts and **Meet opens with you in it** — no check screen, mic on, camera off (huddles today
  work like that, and "instant" means no extra step). Meet shows a short "Mic on · camera off" hint with the device
  name, so a wrong device is easy to see.
- Each conversation has **one huddle room**. If a huddle is already running there, the button says **Join** and shows
  who is in (avatars + count), and clicking it joins the running meeting.
- **Only in small rooms (R5)**: the Huddle button shows only when the room has **6 or fewer people** (human members;
  agents do not count). In a bigger channel the button is not there; the header's menu offers "Start a meeting",
  which makes a Meet meeting and posts its link in the channel, with no ring.
- **Who is in the meeting**: every member of the room is invited and **rung** (the incoming call card, as today),
  in a channel as in a DM. The room shows a live **huddle card** in the message list ("Huddle · Ann, Ben · Join") and
  the sidebar row shows a live dot. Agents in the room are added as note takers (§1.6).
- If a room grows past 6 while a huddle is running, the huddle goes on; new huddles cannot start there.
- When the huddle ends, the card turns into "Huddle ended · 18 min" with a link to the meeting page (and the summary
  when transcribing was on).
- A huddle **is** a Meet meeting: everything in §1.3–§1.5 works in it (share, chat, record, transcript, guests by link).

### 1.2 Start or schedule elsewhere

- **Meet app**: "New meeting" → Start now · Schedule (opens Calendar's new event with Meet on) · Copy a link for later.
- **Calendar**: the event dialog gets "Add FreeFlow Meet" (this is what `conference: 'auto'` now does). The event gets
  a Meet link; the invitation mail carries it; the event popover shows **Join**.
- **Booking page**: the guest scheduler's location gets "FreeFlow Meet". Each booking gets its own meeting link, sent in
  the confirmation.
- **Link**: every meeting has one short link, `app.freeflow.im/meet/abc-defg-hij`. A repeating event keeps the same
  link. A huddle room also has a link (copy it from the meeting), so a person outside the org can be pulled into a
  huddle.

### 1.3 Join

- From a Join button (Chat card or header, Calendar popover, Home "Today" card, a link in mail) or by pasting a link or
  code in Meet.
- **Check screen** (for links and calendar meetings, not for huddles started or joined from Chat): your camera preview,
  camera / mic / speaker pickers, mic level, background blur, turn camera or mic off before entering. Shows who is
  already there ("Ann and 2 others are here").
- **Guests** (no account): the same check screen plus "Your name", then **straight in** (R2). They are labelled
  "Guest" in the People list.
- A host can **lock** a meeting from the More menu: no new guests can join while it is locked ("This meeting is
  locked" on the guest's screen). Members can still join.

### 1.4 In the meeting

- **Grid** or **speaker view**. A shared screen is shown large, with people in a strip.
- Mute / unmute (hold space to talk while muted), camera on/off, share a screen or a window, raise a hand,
  reactions (👍 👏 😂 ❤️ 🎉).
- **Side panel**, three tabs:
  - **Chat**: messages during the meeting. For a huddle, these are the conversation's own messages — writing here
    posts into the channel thread under the huddle card, so nothing is split between two chats.
  - **People**: who is in; invited and not here (with **Ring**); guests labelled. Hosts can mute, remove, make host.
  - **Notes**: the live transcript when transcribing is on.
- **More** (hosts): record, transcribe, lock, copy link, end for everyone.
- **Leave** (just you) or **End for everyone** (hosts; asks first). A huddle with no one left ends by itself.
- **Keep using the suite**: the meeting keeps running when you go to Chat, Mail or Docs. A **mini window** shows the
  speaker with mute, camera and leave; clicking it returns to Meet. This takes the place of today's `HuddleMiniBar`.
- One call at a time: joining another meeting asks "Leave Design review?".

### 1.5 After the meeting

- A **meeting page** in Meet's "Past" list: date, length, who came; and, when they were on, **summary**,
  **transcript** (search, speaker names, times), **recording**, and the chat.
- The summary goes back where the meeting came from: the Chat huddle card, the calendar event (a link in its
  description).
- Suite search (⌘K) and the assistant can find transcripts and summaries.
- Who can open the meeting page: people who were invited or who attended (members). Guests cannot.

### 1.6 Agents

- In a DM or group DM huddle, agents who are members join as **note takers**; in any meeting a host can add one
  ("Add an agent" in People). The agent shows as "Agent" in People, reads the live transcript and the chat, answers
  @mentions in the chat, and writes its notes to the meeting page at the end.
- **Deleted (R6)**: talking to an agent by voice in a DM huddle (the bridge's LiveKit voice session). The iOS
  one-to-one agent call (`AgentCallCoordinator`) is not affected: it uses on-device speech, not LiveKit.

## 2. Screens

### 2.1 Meet home (`/meet`)

```
┌ suite bar ────────────────────────────────────────────────────────────────────┐
│  Meet                                                                          │
│  ┌──────────────────────┐  ┌──────────────────────────────────────────────┐   │
│  │ [ New meeting ▾ ]     │  │ Live now                                     │   │
│  │   Start now           │  │ # design   huddle   ● Ann, Ben     [ Join ]  │   │
│  │   Schedule            │  │                                              │   │
│  │   Copy a link         │  │ Today                                        │   │
│  │                       │  │ 10:00  Design review               [ Join ]  │   │
│  │ [ Enter a code/link ] │  │ 14:30  Ann Lee (booking)           [ Join ]  │   │
│  └──────────────────────┘  │                                              │   │
│                            │ Past                                          │   │
│                            │ Tue  Weekly planning  42 min  Summary · Rec  │   │
│                            │ Tue  # design huddle  18 min                 │   │
│                            └──────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────────────────┘
```

"Live now" = huddles running in conversations the person is in. "Today" comes from the person's calendar (Meet links,
and also the Zoom/Meet/Teams links Calendar already detects, so it is one list of all their calls).

### 2.2 Chat: huddle button and card

```
# design                                     (A)(B) +2  [ 🎧 Join huddle ]
 ...
 ┌────────────────────────────────────────────┐
 │ 🎧 Huddle started by Ann · 4 min            │
 │ (A)(B)(C)(D)  Ann, Ben, Cara, Dan  [ Join ] │
 └────────────────────────────────────────────┘
```

### 2.3 Check screen (links and calendar meetings)

```
┌──────────────────────────────────────────────────────────────┐
│  Design review                                                │
│  ┌──────────────────────────────┐   Ann and 2 others are here │
│  │        your camera           │   (A)(B)(C)                 │
│  └──────────────────────────────┘   Your name  [ Ann Guest ]   │ ← guests only
│   [🎤] [📷] [✨ blur]                [ Join now ]              │
│   Camera ▾  Mic ▾ ▮▮▮▯▯  Speaker ▾ (test)                     │
│   ● This meeting is being recorded                            │ ← when on
└──────────────────────────────────────────────────────────────┘
```

### 2.4 In the meeting

```
┌ # design huddle · 12:04 · ● REC ──────────────────────────── [Grid|Speaker] ┐
│ ┌───────────┐ ┌───────────┐ ┌───────────┐ │ Chat  People(5)  Notes          │
│ │  Ann      │ │  Ben 🔇   │ │  Cara ✋  │ │ In the meeting                  │
│ └───────────┘ └───────────┘ └───────────┘ │  Ann (host) · Ben · Cara · You  │
│ ┌───────────┐ ┌───────────┐               │  Dan (Guest)                    │
│ │  You      │ │  Dan      │               │  Scribe (Agent)                 │
│ └───────────┘ └───────────┘               │ Invited, not here               │
│                                           │  Eve  [Ring]   Fay  [Ring]      │
├───────────────────────────────────────────┴─────────────────────────────────┤
│  [🎤] [📷] [🖥 Share] [✋] [😀]        [💬] [👥] [📝] [⋯ More]   [ Leave ▾ ] │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 2.5 Mini window

A floating card over any suite app: the speaker's video (or avatar), the meeting name, `[🎤] [📷] [Leave]`; click to
return to Meet. Browser picture-in-picture where it exists, an in-page card otherwise.

### 2.6 Meeting page (after)

Title, date, length, people. Tabs: **Summary** · **Transcript** · **Recording** · **Chat**. Buttons: "Save as doc",
"Share to a channel".

### 2.7 iOS

Huddle button and incoming call card as today. In the meeting: speaker view by default, swipe for grid, a bottom
control bar, side panel tabs as a sheet. Leaving the app keeps audio and turns the camera off (as huddles do). iOS
views screen shares but does not share its own screen in v1 (as huddles).

## 3. Rules a person will notice

- One call at a time per person.
- One huddle room per conversation; it is reused, so its link does not change.
- Hosts: the person who made the meeting, the calendar organizer, or for a huddle anyone who is a member of the
  conversation. A host can make others hosts.
- Guests join straight in unless the meeting is locked.
- A link works until a host makes a new one, or a year after the meeting was last used.
- Everyone sees a badge when recording or transcribing is on; a guest is told on the check screen.

## 4. Technical plan — overview

```
 web / desktop / macOS (WKWebView)        iOS (RealtimeKit iOS SDK)
          │  RTK Core SDK (WebRTC)                 │
          └────────────────┬───────────────────────┘
                           ▼
          Cloudflare RealtimeKit (media, recording, transcription, summary)
               ▲ REST: meetings, participants → token     │ signed webhooks
               │                                          ▼
   Worker (packages/edge) ── Org DO: meetings, roster, rings, events
                          ── Directory DO: link code → org
                          ── MeetingAgent DO: agent participant WebSocket
                          ── R2: recordings, transcripts, summaries
```

- **One RTK app per environment** (staging, production). Worker secrets: `RTK_ACCOUNT_ID`, `RTK_APP_ID`,
  `RTK_API_TOKEN` (Realtime Admin). `/v1/config` reports `meet: true` when they are set.
- **Presets**, made by an idempotent script in the repo (`packages/edge/scripts/rtk-presets.mjs`, Presets API):

  | Preset | Who | Notes |
  |---|---|---|
  | `ff-host` | meeting creator, calendar organizer, huddle members | host controls, record, transcription |
  | `ff-member` | other org members | chat, share, transcription view |
  | `ff-guest` | people without an account | chat, share; no waiting room (R2) |
  | `ff-agent` | note takers | agent participant: transcripts, chat, presence |

## 5. Server (Worker)

### 5.1 Data (Org DO SQLite, new migration)

- `meetings`: `id`, `workspace_id`, `rtk_meeting_id`, `code`, `title`, `created_by`, `kind`
  (`huddle` | `instant` | `calendar` | `booking`), `channel_id` (huddles: unique per channel), `source_ref` (event UID
  / booking id), `locked`, `record_default`, `transcribe_default`, `last_used_at`, `created_at`.
- `meeting_hosts` (`meeting_id`, `user_id`); `meeting_invitees` (`meeting_id`, `user_id`) — for a huddle this is not
  stored: it is the conversation's members, read live.
- `meeting_participants`: `meeting_id`, `user_id` or `guest_id`, `rtk_participant_id`, `preset` — one RTK participant
  per person per meeting, tokens refreshed rather than a new participant each join.
- `meeting_sessions`: `id`, `meeting_id`, `rtk_session_id`, `started_at`, `ended_at`, `attendees`, and R2 keys for
  recording, transcript, summary, chat.
- `_meeting_roster`: live peers (replaces `_huddle_participants`).
- Rings: **reuse `huddle_invites` / `huddle_invite_targets`** (migration 0042) with a `meeting_id` column; the ring
  states, system messages and missed-call lines stay as they are.
- Directory: `meeting_codes` (`code` → org id, meeting id), so public links and webhooks find the org without a
  session.

### 5.2 Routes

| Route | Who | Does |
|---|---|---|
| `POST /v1/channels/:id/huddle` | member of the conversation | 409 `room_too_large` when the room has more than 6 human members and no huddle is running; else get or create the conversation's meeting, add or reuse the caller's RTK participant (`ff-host`), return `{ meeting, authToken }`; start the ring for all members. Idempotent; also the reconnect path. Replaces `/huddle/join`. |
| `POST /v1/huddle/invites/:id/accept\|decline\|cancel` | as today | accept = the call above |
| `POST /v1/meetings/:id/ring` | host | ring chosen invitees (the People panel's Ring) |
| `POST /v1/meetings` | member | create an instant / calendar / booking meeting |
| `GET /v1/meetings`, `GET /v1/meetings/:id` | member | live, upcoming (from Calendar), past; detail with summary / transcript / recording links |
| `POST /v1/meetings/:code/join` | member | token for a meeting by link |
| `GET /meet/api/:code` | public | title, host name, who is in (first names only), recording notice, locked |
| `POST /meet/api/:code/join` | guest | name, Turnstile, rate limit per IP and per code → `ff-guest` token. 403 when locked. |
| `PATCH /v1/meetings/:id`, `POST /v1/meetings/:id/hosts` | host | lock, defaults, new link, hosts |
| `POST /v1/meetings/:id/agents` | host | add a note taker (§5.4) |
| `POST /v1/rtk/webhook` | RTK | verify `rtk-signature` (RSA-SHA256 over the raw body; key from `api.realtime.cloudflare.com/.well-known/webhooks.json`, cached), dedupe on `rtk-uuid`, find the org by RTK meeting id → Org DO |

Tokens: `custom_participant_id` is our user id or a random guest id, never an email (RTK's advice). `expires_on` =
now + 12 h; the client asks for a new one on reconnect. Mute, remove, record, end-for-all are done in the client SDK
by hosts; RTK enforces the preset, the webhooks tell us the result.

### 5.3 Webhooks → state

- `meeting.started` / `meeting.ended` → session row; `meeting.updated` on the event bus (Chat card and header, Meet
  "Live now", Home). Replaces `huddle.updated`.
- `meeting.participantJoined` / `Left` → roster, same event.
- `recording.statusUpdate` `UPLOADED` → recording in our R2 (configure RTK storage to our bucket; otherwise copy —
  RTK deletes after 7 days).
- `meeting.transcript`, `meeting.summary` → download (short-lived URL) to R2, index in search, post to the huddle card /
  calendar event.
- `meeting.chatSynced` → only for non-huddle meetings (huddle chat already is Chat messages).
- RTK is the source of truth for who is in (as ADR 0002 says of LiveKit); our roster is a cache, repaired from RTK's
  active session API when a live meeting is read.

### 5.4 Note takers

`POST /v1/meetings/:id/agents` (and DM huddles, automatically) adds an `ff-agent` participant and starts a
**MeetingAgent** DO per session and agent. It opens the Agent Participant WebSocket, subscribes to transcripts, chat
and presence, and forwards them to the agent's runtime: the Assistant DO for hosted agents, the bridge's event stream
for bridge agents. Replies go back as meeting chat. The DO leaves when the last person leaves (a connected agent keeps
the session alive and is billed), with an alarm as a backstop.

### 5.5 Huddle details

- In-meeting chat for a huddle is wired to Chat: the client sends to the channel thread under the huddle card through
  the normal message API, not RTK chat. RTK chat is turned off in `ff-*` presets for huddle meetings — or kept off
  everywhere and Meet always uses a hidden thread for non-huddle meetings too (decide in phase 1).
- Ring timer: today a 30 s in-isolate `setTimeout`; move it to a DO alarm while we are here.

### 5.6 Calendar and scheduler

- `conference: 'auto'` creates a `calendar` meeting for the event UID and writes `conference: { url, label: 'FreeFlow
  Meet' }` and the link into the description, so other calendars show it.
- Scheduler location gains `{ kind: 'meet' }`; each booking gets its own meeting.

## 6. Clients

| Client | Change |
|---|---|
| **web** | New `packages/meet` (suite app like `calendar`, `home`): home, check screen, room, meeting page, public guest page. `@cloudflare/realtimekit-react`. A `MeetingProvider` created by the suite shell (replaces `HuddleProvider` in `packages/web/src/huddle.tsx`) so a call survives app switches; the mini window lives there. Chat's huddle button, card and `IncomingHuddle` ring card call the new routes and open Meet. Remove `livekit-client`. |
| **desktop** | The web client, plus the `setDisplayMediaRequestHandler` picker the Electron spec already calls for (missing today). |
| **macOS** | Replace `Room` in `AppState.swift`, `HuddleBar`, `HuddleGridView` with a **Meet window** that hosts `/meet/...` in `WKWebView` (signed in, mic and camera allowed). The huddle button, the incoming call card and the "in a call" bar stay native and drive the window. Loses the native ScreenCaptureKit share picker (WebKit's own picker instead). Remove LiveKit from `Package.swift`. |
| **iOS** | `RealtimeKit` + `RealtimeKitUI` Swift packages replace LiveKit in the shared `AppState`. Native room UI (UI Kit themed first). `AgentCallCoordinator` unchanged. |
| **agent bridge** | Delete `huddle-voice.ts`, `huddle-context.ts` and `CallTurnQueue`, the `@livekit/*` deps and the inference-token route (R6). New events `meeting.started` / `meeting.transcript` / `meeting.chat` / `meeting.ended`, tool `meet_send_chat`, tools `list_meetings` / `read_meeting`. Version bump in the same PR. |

## 7. Cutting over from LiveKit

Native apps ship later than the web, and old app versions only know LiveKit. Plan:

1. Ship server + web + desktop + bridge on RTK, and the native "open Meet in the browser" change (operator,
   2026-11-16). `/v1/config` reports `huddles: false`, but **the native apps do not read it** (their huddles
   capability is per backend, not per server), so an old macOS / iOS build still shows its Huddle button and fails
   with "Couldn't join the huddle" until it is updated; its ring card's Accept fails the same way. They can still
   join any meeting by opening its link in a browser.
2. Release macOS and iOS: the Huddle button and the ring card open the room in the browser. Their LiveKit call
   code (HuddleBar, HuddleGridView, the `Room` in AppState) is dead from then on and goes with phase 6.
3. Remove the LiveKit routes, webhook, secrets and the `livekit-server-sdk` dependency; close the LiveKit Cloud
   account. Supersede ADR 0001 / 0002 with an ADR for RTK, and record R1–R4 in `decision_log.md`.

Between steps 1 and 2, macOS and iOS users have no in-app calls. Parity ledger lines for the gap; keep it short by
building the native work in the same push.

## 8. Cost

RTK pricing page (2026-11-13): audio/video participant **$0.002 / min**, audio-only $0.0005 / min, recording export
$0.010 / min, transcription at Workers AI prices; another version of the page says RTK is free during beta. A
5-person, 1-hour meeting is 300 participant-minutes = $0.60 (+$0.60 if recorded). Agents are billed as participants
while connected. Huddles today are audio-mostly: a camera-off participant still counts as audio/video, because the
type comes from the preset. A `ff-voice` preset for camera-off huddles would cost a quarter; not worth it for v1.

Limits to check in phase 1: maximum participants per Video meeting, simulcast defaults, token lifetime (≤ 100 days),
RTK file retention (7 days).

## 9. Phases (one branch, one PR, a commit per phase)

1. **MVP: a meeting room on the web** (ruled 2026-11-15: start simple, leave Chat and huddles out). LiveKit huddles are
   not touched in this phase.
   - Worker: one RTK app; secrets `RTK_ACCOUNT_ID`, `RTK_APP_ID`, `RTK_API_TOKEN`; `meet: true` in `/v1/config`.
     Two presets, `ff-host` and `ff-member`, made by the presets script.
   - Org DO: `meetings` (id, workspace_id, rtk_meeting_id, code, title, created_by, created_at) and
     `meeting_participants` (one RTK participant per person per meeting); `_meeting_roster` for who is in.
     Directory `meeting_codes`.
   - Routes: `POST /v1/meetings` (create), `POST /v1/meetings/:code/join` (members only → `authToken`),
     `GET /v1/meetings/live`, `POST /v1/rtk/webhook` (`meeting.started`, `meeting.ended`, `participantJoined`,
     `participantLeft` → roster and `meeting.updated` event).
   - `packages/meet`, web and desktop: Meet home with **Start a meeting now**, **Copy link** and **Live now**; the room
     (grid, a shared screen shown large, mute, camera, share, leave, a simple People list) using the mockups' layout
     with RTK's video tile. The room opens in its own browser tab, so there is no mini window yet.
   - **As built (2026-11-16):** the link is a short code (`/meet/kqd-wmzt-fra`: 3-4-3 letters without i, l or o), kept
     in `meetings.code` and indexed in the directory like an id, so a link finds its organization; RTK's default presets `group_call_host` / `group_call_participant` instead of our
     own; and Live now asks RTK's active-session API for rooms joined in the last 12 hours instead of webhooks (works on
     a laptop too). Webhooks and own presets come with phase 2 or 3.
   - Not in it: Chat and huddles, guests, check screen, Calendar and scheduler, recording, transcripts, agents,
     in-meeting chat, raise hand, reactions, speaker view, blur, lock, mini window, native apps.
2. **Chat and huddles** — Huddle button for rooms of 6 or fewer, ring, huddle card, `MeetingProvider` and mini window
   in the suite shell; remove LiveKit from web and bridge (§7 step 1).
3. **Links and guests** — public `/meet/:code`, check screen, guest join, lock; Calendar "Add FreeFlow Meet" + Join;
   scheduler `kind: 'meet'`; Home Today Join.
   - **As built, guests (2026-11-16):** the public routes are `GET`/`POST /v1/meetings/:code/guest` (codes only, never
     ids; per-address and per-meeting rate limits; no Turnstile yet), and the page `/meet/<code>` needs no sign-in (Meet's
     home still does). A member who opens a link joins as themselves, anyone else as a guest. Guests use our own preset
     `flow_guest` (`packages/edge/scripts/rtk-presets.mjs`, run once per RTK app): RTK's `group_call_guest` sends guests
     to a waiting room. Each guest join is a new RTK participant with a `guest-` id; nothing is stored for a guest.
     Huddles refuse guests. Lock is a `meetings.locked` column, set by the creator (or a host).
   - **As built, Calendar and booking page (2026-11-16):** no `kind`/`source_ref` columns. "Add FreeFlow Meet" in the
     event editor makes an ordinary meeting from the browser (`POST /v1/workspaces/:id/meetings`) and writes one line,
     `Join with FreeFlow Meet: <link>`, into the description, which every calendar shows and Calendar's card reads back
     as Join (`packages/calendar/src/lib/meet.ts`). The booking page's location `{ kind: 'meet' }` asks the Org object
     (`createMeetingForAccount`) for a meeting per booking, kept in `scheduler_bookings.meet_url`. Home's Today card
     shows Join for any event with a call link.
   - **As built, scheduling from Meet (2026-11-16):** Meet's home has **Schedule in Calendar** (`/calendar/?new=&meet=1`:
     Calendar's new-event editor, which adds the Meet link as it opens), **Join with a code or link**, and **Today** (the
     calls left today, from `/v1/calendar/events`; the Join rule moved to `@flow/shared` `callLinks.ts`, shared with
     Home). Saving an event with a Meet link gives the meeting the event's title (`PATCH /v1/meetings/:code {title}`,
     host only), since the meeting is made before the event has one. No "Past" list yet: that is phase 4.
3b. **Meeting chat** (operator 2026-11-16, before recording). Chat in a meeting is a Chat channel, so search, files,
   threads, reactions and agents work as in any channel, and the recording, transcript and summary (phase 4) have a
   place to go. Builds on Chat visitors (docs/specs/chat-visitors.md).
   - **Huddles** keep using their own conversation: the meeting's chat panel shows that channel or DM (the thread under
     the huddle card, §1.4). No new channel.
   - **Every other meeting room has one channel** of a new kind, `meeting`, made the first time someone joins. One per
     room, not per session: a room used every week keeps one channel, with a date line ("Mon 16 Nov") for each
     session. `meetings.chat_channel_id` points to it. The channel has no name (as DMs); clients show the meeting's
     title (`ChannelDTO.meeting: { code, title }`).
   - **Who is in it**: the meeting's creator, and each member the first time they join the meeting. Invited people who
     never join do not get it. It is private to them (the private-channel rules already keep it out of search and
     other people's sockets).
   - **Guests are visitors** of the meeting's channel (Chat visitors, V6 allows the `meeting` kind): each guest join makes
     a visitor with "sees from" = the moment they joined, so a guest never sees earlier sessions' chat. A guest's visit
     ends when the meeting session ends (not 30 days). Guests post through the visitor routes; the Meet page holds the
     visitor cookie. No Turnstile for this path yet (the guest join's own rate limits apply; Turnstile on guest join is
     a later item).
   - **Not in the channel list**: `GET …/channels` leaves `meeting` channels out (on the server, so the native apps do
     not show them either). Messages in a meeting channel do not count toward unread, except @mentions.
   - **Chat's sidebar gets "Meetings"** (under Activity): the meeting channels you are in, newest session first, with
     title, date and people; a live meeting at the top with Join. Opening one shows the channel as usual, with a header
     link back to the meeting (Join while live).
   - **Meet's room gets a Chat tab** in the side panel: the channel's messages and a composer (Chat's message list and
     composer, as the visitor page reuses them), for members and guests alike. A dot on the tab for new messages.
   - Native apps: no Meetings list yet (Parity line); a meeting channel's messages and mentions still arrive, and
     opening one from a mention shows the channel.
4. **After the meeting** — recording to R2, transcript, summary, meeting page, search, summary back to Chat and
   Calendar, Save as doc.
5. **Agents** — MeetingAgent DO, note takers, bridge events and tools.
6. **Native** — iOS RTK; macOS Meet window; then step 3 of §7 (remove LiveKit for good).

Later: breakout rooms (connected meetings); webinars (stage); livestream;
whiteboard plugin; CallKit; iOS screen share.
