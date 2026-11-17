# Workspace onboarding

Status: built 2026-11-17 (branch `onboarding/workspace-setup`). Design: the "FreeFlow — Onboarding & Home" canvas
(claude.ai artifact F7jgrvtjecBzTvYs8Mnmyt, artboards 0–5). Home A/B on that canvas are not part of this build.

## 1. What a new person sees

1. **Welcome** (`/`, signed out only). One page that says what FreeFlow is: the five apps stacked in one workspace,
   people joining from the left, agents (hosted and connected over MCP) from the right. "Set up your workspace" goes to
   sign-up; "Sign in" to Chat's sign-in. A signed-in visitor, or any `/` address with a query (sign-in links, `?next=`,
   `?signup=`), goes to `/chat` as before.
2. **Setup** (`/home/setup`, Home's own page, no sidebar). Five steps, with a step bar at the top:
   1. **Workspace** — name and address. The free choice is `<slug>.freeflow.im`; the own-domain choice records the
      domain and opens Admin › Domains when setup ends. The screen states the 2026-11-15 ruling plainly: agents get
      addresses at the workspace domain; a person links their own mail, or gets an address once an own domain has mail.
   2. **Chief of Staff** — the person's assistant introduces itself in a scripted chat (no model call). The person picks
      a name (chips or typed) and one of the eight picture presets. Saving names the assistant (`nameAssistant`: its
      address and mailbox) and sets its picture.
   3. **Omni** — owners and admins only. Adds Omni, the workspace's shared agent (§2). "Not now" skips it.
   4. **Team** — owners and admins only. Invite a person by email; add a hosted agent (name, purpose, shared or
      private); or connect an outside agent over MCP (the same address and prompt as Admin › Connect an agent). The
      side list is the real member list.
   5. **Automations** — two ready-made automations for the person's assistant, on by default (§3), and a box to
      write a new one in plain language (§4).
   "Finish setup" marks setup done and opens Home.

A person who joins an existing workspace sees steps 2 and 5 only.

## 2. Omni

- One per workspace, made from setup (or later by an owner or admin). It is an ordinary hosted shared agent (agents.md
  §1) named Omni, sponsored by whoever added it, with instructions that make it the team's knowledge agent.
- **It joins every public channel**, existing ones when it is added and each new public channel as it is made. It sees
  what any shared agent sees (agents.md §1): what is shared with it. Files, calendars and shared inboxes are shared with
  it the normal way; no new access rule (operator ruling 2026-11-17).
- The Org object keeps its id (`team_agent_v1`). Removing Omni clears it; renaming is allowed.

## 3. Ready-made automations

Made for the person when they reach step 5, both `wake` subscriptions with their assistant as consumer:

| Name | When | Prompt |
|---|---|---|
| Daily Briefing | `weekdays@07:30`, the person's time zone | prep for the day from calendar, recent conversations and open tasks |
| Meeting Prep | `calendar.event.added` on the person's own calendar | if the meeting has someone outside the workspace: who they are, recent threads, a short prep note |

The schedule grammar gains `weekdays@HH:MM` (Monday to Friday). The switch turns one off by removing its subscription
and on by making it again.

## 4. Plain-language automations

The person writes WHEN and THEN in their own words and picks who does it (their assistant, Omni, another agent, or no
agent). "Create automation" sends that to the person's assistant as a turn; the assistant makes the subscription with
its `create_subscription` tool (a schedule or an event filter) and answers with what it made, shown under the form. The
list of the person's automations refreshes after. With no model set for the workspace, the box says so and links to
Admin › Agents.

## 5. State

- `GET /v1/workspaces/:id/setup` → `{ pending, step }`; `PUT` with `{ step }` or `{ done: true }`. Kept in the Org
  object per person (`setup:<userId>`).
- A person is marked pending when the Org object makes their assistant (a new native member: the creator of a new
  workspace, or a joiner). People who were members before this shipped are never marked, so they never see setup.
- Home sends a pending person to `/home/setup`, and a person with no workspace to step 1.

## 6. Not built here

- The browser-extension question in step 2 is hidden until the extension has a public install link (the store
  listing was rejected 2026-11-14).
- Tool choices for a new agent (the design's Tools row): per-agent tool scopes are spec only (agents.md §1.3).
- Home A / Home B.
