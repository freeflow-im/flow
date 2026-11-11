# FreeFlow agents: personal and shared

Status: design spec · split out of `platform.md` on 2026-11-10 and revised the same day (two axes: kind and runtime;
hosted agents with a definition; sync and async turns; operator ruling in `decision_log.md`), where it was §2.3, §3.3 (agent accounts), §5.5 and
the agent steps of §11. The rulings are in `decision_log.md` (2026-11-10, "Agents: one organization each") and
`platform.md` §10 ruling 4. This document is the newer text; `platform.md` keeps a summary in each place and points
here. Nothing in the repository changes by this document; §8 says what the code does today, and §11 is the build plan.

Everything here rests on the platform layers in `platform.md`: principals and credentials (§2), organizations and
accounts (§3), grants (§4), the event bus and the tool registry (§5), manifests (§6). Section numbers written `P§n`
refer to that file.

## 0. The picture

An agent cannot judge, as a person can, what is fine to tell whom. An HR person knows the CEO may ask about salaries
and others may not; an agent holding the HR person's access would answer anyone who asks. So the platform never asks
an agent to make that judgement. Every agent is one of two kinds, and the kind decides its access by a rule the
platform enforces, not by the model's behaviour.

- A **personal agent** acts as one person, with that person's access, and only that person can use it. The in-app
  assistant is one; so is Claude Desktop on `/mcp`.
- A **shared agent** is a member of the organization in its own right, sees only what is shared with it, and anyone
  in the organization can use it. Builder and Omni are shared agents.

An agent has two independent properties, and every combination exists:

| | Hosted (the platform runs its loop) | External (its own machine runs its loop) |
| --- | --- | --- |
| Personal | the in-app assistant, made for every person by default | Claude Desktop on `/mcp`; a person's own Claude Code on the bridge |
| Shared | Omni, run by the platform for the organization | Builder on the bridge |

**Kind** (personal or shared) decides access. **Runtime** (hosted or external) decides where the loop runs and so what
the agent can do: a hosted agent can run a turn at once in the panel, with the open page and its browser tools, and
can also be woken later by a trigger; an external agent is called by its own client, and takes wake-ups only if it
subscribes (§6). There is no single "Assistant": the assistant a person sees is their hosted personal agent.

## 1. The two kinds

| | Personal agent | Shared agent |
| --- | --- | --- |
| Access | its sponsor's in the same organization, limited by scopes | only its own grants; **never inherits from its sponsor** |
| Who may start a turn | the sponsor only | every member of its organization |
| Its account | `personal_agent`: no address, mailbox, calendars or channels; it acts **as** the sponsor, marked `via` | `native`: its own address, mailbox, calendars (P§3.3) |
| Channels, mentions, DMs from others | no | yes, like any member |
| Things shared with it | not possible; it already sees what the sponsor sees | by grants, like any member |
| The sponsor's part | owner and source of access | answers for it; gives it no access |
| What an admin may do | see it, suspend it, remove it; never use it (§2) | everything they may do with a member |
| Examples | the in-app assistant (§6); Claude Desktop on `/mcp` | Builder; an HR bot; Omni, the team's helper |

**Every agent is a principal in one organization.** An agent has a principal row like any other and exactly one
account, in the organization it was made in (`organization_id` on the principal). A person with accounts in Acme and
Initech has two personal agents, one in each, with separate memory: nothing an agent learns in one organization
reaches another, and when a person leaves an organization their agent there goes with the account. To work in two
organizations, a person connects two agents.

**The rule: an agent holds a delegation or holds grants, never both.** A personal agent holds only a delegation; a
shared agent holds only grants. `mode` is a column on the principal, so a constraint enforces it. The two live in
different tables, so the directory's write path checks the rule as well.

**A personal agent is a delegation with a runtime.** The delegation is the MCP OAuth grant already in the directory
(`oauth_tokens` and its neighbours), carrying the sponsor's `account_id` in the agent's organization, the scopes and
the agent's principal id. The agent's own account exists so the organization can see, suspend and remove it, and so
its runtime, subscriptions and events have an owner; it holds no grants and nothing can be shared with it. Its caller
context is the sponsor's account with `via: <agent id>` (§3); grants are checked against the sponsor. It may act in
shared places for the sponsor ("post this summary to #sales" posts as Ann, via her agent), since nobody else can
start its turns; any write someone other than the sponsor can see (posting, sending, sharing, deleting, editing a
shared object, answering an invitation) shows the sponsor a confirm card first. Its conversation and memory are
private to the sponsor, as a mailbox is: an admin sees the agent but cannot start its turns, read its conversation or
memory, or change its scopes.

**A shared agent is a member of the whole organization.** It sees only what is shared with its account. Every member
of its organization may start its turns, in the panel, by mention, by DM or by a subscription. Each turn carries
`invokedBy: <account>` so it knows who asked, and its writes are its own ("Omni, asked by Scott"). **A shared agent
keeps no secrets from the organization:** anything shared with it or told to it may reach any member. The platform
cannot enforce how an agent outside it keeps memory, so the rule is stated to people instead: the Share dialog (§4),
a DM with a shared agent ("Not private: anyone in Acme can ask Omni") and the panel say so.

**Group agents, later.** A `group` agent is a shared agent whose users are an explicit set of accounts in its
organization instead of all of them. The set is the agent's **"who may use it" list**; its sponsor and the
organization's admins edit it, and adding someone is a sharing act: they can then ask about everything already shared
with the agent, so the change shows what the agent can see and tells the people who shared it. Until group agents
exist, an agent whose knowledge only some members should reach is not built as a shared agent.

**Connecting an agent.** The OAuth consent page and the bridge's self-registration ask one question beside the
organization:

> Connect this agent as: **my personal agent** (it acts as you and sees what you see; only you can use it) · **a
> shared agent** (a member with its own address; it sees only what is shared with it; everyone in Acme can use it)
> · or reconnect an existing agent: *Scott's assistant · Omni*

Both answers make an **external** agent: the client asking the question runs the loop. A **hosted** agent is made
in the app instead (the person's assistant by default; a shared one from the Admin app's Agents section, §6), and
needs no credential, since the platform runs it. Personal creates an agent principal with `mode: personal` in the
chosen organization, its `personal_agent` account, and a delegation with the scopes the person picks. Shared creates an agent principal with `mode: shared`, a `native`
account with the address the person picks, and an agent token. The organization's policies on sponsoring agents
apply (P§3.1). Reconnecting names an existing agent in the chosen organization, so a new machine does not make a
duplicate. The kind and the organization never change; to switch, make a new agent, so an agent never quietly gains
or loses access. One client may hold several, a token for each.

## 2. Principals and accounts

**The principal** (P§2.1) carries what identifies an agent: `kind: agent`, a required `sponsor_id` (a person
principal), a required `organization_id`, and `mode` (`personal` or `shared`, later `group`), set at creation and
never changed. Its `login_email` is a synthetic unique value; agents never sign in by email. An agent signs in only by
token (`agent_tokens`, P§2.2) or acts through a delegation. An agent cannot sponsor an agent, own an organization, or
hold the admin role.

**The account** (P§3.3) follows four rules.

1. An agent has exactly one account, in its own organization, where its sponsor must hold one.
2. When the sponsor's account is suspended or removed, the agent's account follows.
3. A shared agent's account is otherwise a full account: `builder@acme.com`, a mailbox, calendars. Inviting it to a
   meeting is an ordinary attendee line; mailing it is ordinary mail. Every surface that shows the agent shows the 🤖
   mark and "sponsored by" (P§3.2); the address itself is plain. A shared agent is always `native`: it is brought in
   to work and needs its address and mailbox for it.
4. A personal agent's account has kind `personal_agent`: no address, no mailbox, no calendars, no channels, no
   grants. Its kind never changes.

**Admins see every principal.** The member list shows people, guests, shared agents and personal agents, each with
its kind and sponsor ("Tom's assistant · personal agent of Tom"). An admin may suspend or remove any agent, as they
may a person. A personal agent is private as a mailbox is: the admin view shows that it exists, its scopes, where it
runs and when it last ran, and nothing else; no admin tool starts its turns or reads its conversation or memory.

## 3. The caller context

Two fields in the caller context (P§3.6) record agents. `via: <agent id>` means a personal agent is acting as this
account; grants are checked against the account as usual. `invokedBy: <account id>` means a shared agent, whose own
account this is, is running a turn someone asked for. Both go into the event envelope (P§5.2), so history reads
"Ann (via assistant)" or "Omni, asked by Scott".

## 4. Sharing with agents

A grant's principal `account:<id>` names one member, person or shared agent; never a personal agent's account,
which holds no grants (P§4.3).

Sharing with a shared agent shares with the whole organization, so the Share dialog says so: "Everyone in Acme (66
people) will be able to ask Omni about this." The person makes the judgement once, when they grant; the agent never
has to. With group agents (§1) the dialog names the agent's list instead, and later offers **Add an assistant**: a
new group agent with the person as sponsor, a grant on this object only, and "people with access to this object" as
its list.

An object may carry a **thread**: one conversation attached to it that everyone with access sees. It is where
several people talk to the same shared agent about the object (§6).

## 5. Tools

The registry (P§5.4) serves one list, filtered by the agent's kind, not by how it connected: a personal agent gets
what the delegation's scopes allow; a shared agent gets what its account can see. `/mcp`, the bridge's MCP and the
hosted runtime (§6) all read the same list.

A tool runs in one of two places. **Server tools** run in the app's object. **Browser tools** run in the open editor
against what is on screen (insert into this document, open this message) so the change is undoable. Browser tools
carry an agent's edits; they give no access. They are offered only in a sync turn started from a page a person has
open (§6), and each call is checked against the agent's own access: the sponsor's for a personal agent, its own
grants for a shared one.

**Where a tool runs is a property of the turn, not of the tool.** The Docs editing tools (`insert_content`,
`write_range`, `add_slides` and the rest of `CLIENT_TOOLS` in `packages/docs/shared/agent/protocol.ts`) are one
definition with three runners today: the live editor in the tab when the assistant calls them, a **headless**
controller on the server when the MCP server calls them (`plugin/server/files.ts` runs the same client code and saves
a revision), and the desktop app's window when the file is open there. A sync turn from an open page gets the live
editor; every other turn (async, external, or on a page the person does not have open) gets the headless runner. So
an agent woken by a trigger can edit a shared document with the same tools, through its own grants, and the registry
marks each tool by the runners it has rather than by door. Today the MCP server lacks headless runners for some sheet
tools (charts, tabs, freeze, column widths); phase C gives every editing tool one.

## 6. Agents at work: runtimes, the panel, browser tools

**Two runtimes, one agent model.** Where an agent's loop runs is separate from its kind (§0).

- **Hosted.** The platform runs the loop in an `AgentRuntime` object, one per agent. It holds the model's working
  state (paused turns, tool results), takes `wake` jobs from `agent_jobs`, and calls the model with the platform's key
  (limited per organization) or a key the sponsor supplies. Subscriptions, jobs, leases, `causedBy` and the depth cap
  (P§5.2) are the same whoever runs the loop. A hosted agent is a personal one (the assistant) or a shared one (Omni,
  run for the organization).
- **External.** The agent's own client runs the loop and calls the platform: Claude Desktop on `/mcp`, Claude Code or
  Builder on the bridge. An external agent is woken only if it **subscribes** to events (the bridge does; a bare
  `/mcp` client does not); subscribing is a property of the agent, not a third runtime. The desktop app's "use my own
  Claude Code" is an external personal agent on the bridge.

**A hosted agent has a definition.** Today the assistant has one fixed prompt, one tool set and one conversation per
account. A hosted agent instead carries: a name and avatar; instructions (its system prompt); the model and the key
that pays for it; the tools it may use, a subset of what the registry offers its kind; what it subscribes to; and its
memory. A person edits their own assistant's definition in their settings (the model-key settings move there); an
organization's admins and the sponsor edit a hosted shared agent's in the Admin app's Agents section
(`workspace-admin.md` §3.4), which is also where one is made. Kind and organization are not in the definition: they
never change (§1).

**Two kinds of turn.** A hosted agent runs turns in two ways, and the way is a property of the turn, not of the agent.

| | Sync turn | Async turn |
| --- | --- | --- |
| Started by | a person in the panel, on an open page | a trigger: a subscription (a mention, a DM, `docs.changed`), a schedule, or a `wake` job another agent queued |
| Delivery | the panel calls the runtime directly and streams the answer | a `wake` job from `agent_jobs`, as the bridge takes them |
| Page context and browser tools | yes (below) | no tab, so no; the same editing tools run headless (§5) |
| Writes | through the editor, undoable; or server tools, marked as such | server tools only |
| Where the answer goes | the panel | the conversation the trigger belongs to (a channel, a thread, the person's assistant conversation) |

**The in-app assistant is the person's hosted personal agent.** Every person gets one in each organization, when
their account there becomes `active`, named "<name>'s assistant", with the person as sponsor and a default
definition. Its conversation with the person is one private conversation, shown in the panel of every app and in
that organization's Chat. Within an organization it is the same agent, with the same memory, whether the person
reaches it from the panel, from Chat or through a subscription; switching organizations in the bar switches to that
organization's assistant.

**The panel can talk to any agent the person may use.** It picks the person's assistant by default; the person may
pick a shared agent of the same organization instead (Omni). The panel shows a shared agent's audience under its name
("Omni · everyone in Acme").

**A sync turn started from an open page** differs from an async turn in three ways:

1. **It streams.** The panel calls the runtime directly and streams the answer; a `wake` job is too slow for this.
2. **It gets page context**, as the app's manifest describes it (P§6.1 `assistant`): a reference to the open object
   and the selection. For a shared agent, only objects it has a grant on are sent: the open document, not the file
   list in the sidebar or other tabs. On a page it cannot see, the panel says "Omni can't see this page" and offers
   **Share with Omni**, or the person's own assistant.
3. **It gets browser tools.** When the model calls one, the turn pauses, the call goes to the tab that started the
   turn, the tab runs it in the editor and posts the result, and the turn resumes (the assistant works this way
   today). Each call is checked as §5 says: a reading tool needs `viewer` on its object, a changing tool `editor`;
   a tool that opens another object needs a grant on that one. If the tab closes, the calls fail with "page closed"
   and the turn continues with server tools or stops. Browser-tool changes can be undone in the editor; server-tool
   changes cannot, and the panel marks which is which.

Example: Scott and Ann are in an organization. Scott makes Omni, a shared agent, and shares a document he and Ann
are writing with Omni as `editor`. Scott opens the document, picks Omni in the panel and asks for an edit. Omni has
`editor` on the document, so the turn gets the page context and the Docs browser tools; the edit goes through Scott's
editor, he sees it at once and may undo it, and history shows "Omni, asked by Scott". Omni uses none of Scott's
access.

**Several people, one agent, one object.** For Ann and Scott to work with Omni together, the document's thread
(§4) holds one conversation with Omni that both see; a mention of Omni in a comment wakes it through a subscription
on `docs.changed` for the file. Omni can edit as itself through server tools; edits as **suggestions** that a person
accepts are the safer form. Both need Docs to gain live co-editing and suggestions (P§9): today Docs saves whole
files, so two editors at once overwrite each other.

**External agents** get no browser tools in the first version, of either kind. An external personal agent holds the
sponsor's data where it runs, the sponsor's choice, as with Claude Desktop today; an external shared agent holds only
what was shared with it.

## 7. The bridge as a client

The agent bridge is an app of the platform (P§6.3): it holds a shared agent's token or a personal agent's delegation,
learns the agent's account and organization (and, for a personal agent, its sponsor's account there), subscribes to
events by namespace and uses the registry's tools. A bridge that works in two organizations runs two agents. Its
self-registration asks the same "personal or shared" question as the consent page (§1).

## 8. What the code does today

The platform phases 0 to 6 (`platform.md` §11) merged on 2026-11-08 (PRs #718 to #724). This spec's model was
written after them, on 2026-11-08 to 2026-11-10, so the agent steps of those phases describe the intent, not the
code. As of 2026-11-10:

- **Agents exist** as principals with `is_agent`, a sponsor and an account per organization (phase 1), and every
  bridge agent is in effect a shared agent: it holds a token, its own account and address, and is a member others
  can mention and DM. An agent in two organizations is refused on the edge (decision_log 2026-11-10). Phase A (PR
  #771) retires all of them on deploy and they are connected again; see §11.
- **There is no `mode`**, no `personal_agent` account kind, and no `via` or `invokedBy` in the caller context or the
  event envelope. The directory does not yet enforce "delegation or grants, never both".
- **`/mcp` grants are not agents.** Claude Desktop on `/mcp` acts as the person through the OAuth grant, as a personal
  agent would, but no agent principal or account records it and the admin member list does not show it.
- **The assistant is an object per account** (phase 6, `packages/edge/src/assistant`), reading the tool registry and
  holding the chats moved out of the Docs objects. It is not an `AgentRuntime`: it takes no `wake` jobs, is not a
  principal of its own, and the panel cannot pick a shared agent. Its browser tools run as the person, which is the
  right behaviour for a personal agent and is noted as such in `browserTools.ts`. It has one fixed prompt and tool
  set; there is no agent definition and no hosted shared agent.
- **The Docs editing tools** already run in two ways: live in the tab for the assistant, headless for the MCP server
  (§5). Some sheet tools have no headless runner.
- **The tool registry** serves the three doors (`GET /v1/tools?door=…`) but filters by door, not by agent kind. The
  consent page builds its scope groups from the manifests but does not ask "personal or shared" or offer "reconnect
  an existing agent".
- **The Admin app's Agents section** (`workspace-admin.md` §3.4) lists the organization's shared agents with their
  sponsors. Personal agents do not appear because none exist as principals yet.
- **The Share dialog** does not yet warn "Everyone in Acme will be able to ask Omni about this".

## 9. Open questions

- **Shared agents' mailboxes.** A shared agent is always native (§2), so every shared agent gets a mailbox, and each
  one costs money at the provider and uses the domain's daily send limit. Whether that holds when an organization
  has many small group agents (one per document, from "Add an assistant"), or such agents may be guests.
- **Guests and shared agents.** Guests are members, so a shared agent answers them too. Whether an organization with
  many guests needs a policy to keep shared agents to native members, before group agents exist.
- **Hosted shared agents' model costs.** Which key a hosted shared agent uses, and who pays when many people use it.
- **Browser tools for external agents.** A relay to the open tab, so an external personal agent can use them too.
- **Live co-editing in Docs** (P§9). Several people and a shared agent editing one document at once needs live
  co-editing with presence, and suggestions with accept and reject. Until then an agent proposes a change in the
  document's thread and whoever accepts it applies it.
- **Settled: agents in several organizations.** An agent belongs to one organization (§1), so
  `inviteAgentToWorkspace` into a second organization is refused rather than fixed; the bridge runs one agent per
  organization. The sponsor check still moves to the directory (`accountFor`) in phase A.

## 10. Rulings

`platform.md` §10 ruling 4 and `decision_log.md` 2026-11-10 ("Agents: one organization each; personal agents are
principals admins see; shared agents for the whole organization") are the rulings this spec rests on. In short: an
agent is a principal with a required person sponsor, a kind set at creation, and exactly one account in one
organization; personal agents act through a delegation and only the sponsor may use them; shared agents hold only
their own grants, are full accounts, and every member may use them; group agents come later; admins see every
principal but cannot use a personal agent or read its conversation or memory.

A second ruling the same day (`decision_log.md` 2026-11-10, "Agents: hosted or external; the assistant is a hosted
agent"): kind and runtime are two independent axes; the runtimes are hosted and external, and subscribing is a
property of the agent; there is no single Assistant, the assistant is the person's hosted personal agent, and a
hosted shared agent runs the same way; a hosted agent has a definition; sync and async are properties of the turn,
and browser tools exist only in a sync turn from an open page.

## 11. Implementation phases

Three phases, one branch and one PR each (the batching rule in `CLAUDE.md`), each leaving something a person or an
agent can use. They replace steps 1.5, 6.2 and 6.3 of `platform.md` §11, which were written before the kinds existed
and were not built as written (§8). Phase A comes first; B and C both need it and are independent of each other.

```
A agents by account ─┬─ B connecting an external agent (consent, registry by kind)
                     └─ C hosted agents (runtime, definition, the assistant, the panel)   ─ D later
```

### Phase A: agents by account

1. **The directory.** `mode` and `organization_id` on agent principals; the `personal_agent` account kind; the rule
   that an agent holds a delegation or grants, never both, checked in the directory's write path; suspension and
   removal following the sponsor's account.
2. **Migration.** Every agent made before kinds is retired (operator ruling, decision_log 2026-11-11): its accounts
   removed, its tokens revoked, its principal deleted, and each Org object drops it from its roster at its next start.
   Nothing is split or placed: each agent is connected again with an invite code, which makes a new principal of a
   known kind. Existing `/mcp` grants become personal agents, one per sponsor, client and organization, each with its
   `personal_agent` account. Old DMs with a retired agent stay as history.
3. **The caller context.** `via` and `invokedBy` resolved by the Worker and carried in the event envelope; the
   bridge reads its account, organization and (for a personal agent) its sponsor's account at start.
4. **Admin.** The member list and the Admin app's Agents section show personal agents with their sponsor and
   nothing to open; suspend and remove work for both kinds.

What people see: Claude Desktop appears as "Scott's Claude Desktop · personal agent of Scott" in the member list;
history reads "Ann (via assistant)" and "Omni, asked by Scott". Exit: no agent row is without a `mode`; the e2e
creates one agent of each kind and the constraint refuses a shared agent with a delegation and a personal agent with
a grant.

### Phase B: connecting an external agent

1. **The consent page** asks "personal or shared", or "reconnect an existing agent", beside the organization; the
   bridge's self-registration asks the same question. The organization's sponsoring policies apply.
2. **The registry filtered by kind.** One list, filtered by the agent's kind and its access, served to all three
   doors; the consent page's scope groups come from it.
3. **The Share dialog** warns "Everyone in Acme (66 people) will be able to ask Omni about this" when the principal
   is a shared agent; a DM with a shared agent and the panel show "Not private: anyone in Acme can ask Omni".

What people see: the kind chosen at connect time, the warning at share time. Exit: connecting the same bridge twice
with "reconnect" makes no duplicate; a shared agent's tool list contains nothing its account cannot see.

### Phase C: hosted agents

1. **`AgentRuntime`**, one object per hosted agent of either kind: the loop, paused turns, `wake` jobs from
   `agent_jobs`, the platform's key limited per organization or a key from the definition.
2. **The definition**: name, instructions, model and key, allowed tools, subscriptions, memory; edited in the person's
   settings for their assistant and in the Admin app's Agents section for a hosted shared agent, which is also where
   one is made (an agent principal with `mode: shared`, a `native` account, no token).
3. **The hosted personal agent.** Every person's assistant becomes an agent principal with `mode: personal` and a
   `personal_agent` account, made with a default definition when the account turns `active`; the assistant object's
   conversation becomes that agent's; the model-key settings move into its definition; the confirm card for writes
   others can see.
4. **Headless runners** for every Docs editing tool, so an async turn edits with the same tools a sync turn does,
   through the agent's own grants; the registry marks each tool by its runners.
5. **The panel** talks to any agent the person may use, their assistant by default or a shared agent of the same
   organization, showing a shared agent's audience; page context and browser tools by manifest in sync turns, each
   browser-tool call checked against the agent's own access; "Omni can't see this page" with **Share with Omni**.
6. **Object threads**: one conversation on an object that everyone with access sees; a mention of a shared agent in
   it wakes the agent in an async turn through a subscription.

What people see: the same assistant from the panel, from Chat and through a subscription; an admin makes Omni in the
Admin app with instructions and tools, and Omni answers in the panel, edits a shared document through the person's
editor, undoable, and later answers a mention in the document's thread on its own. Exit: the §6 example runs end to
end in a sync turn; the same edit made by a mention runs as an async turn through the headless runner and lands as a
new revision; Omni's turn fails with "can't see this page" on a document not shared with it.

### Phase D: later, in no order

Group agents with their "who may use it" list and "Add an assistant" in the Share dialog; browser tools for external
agents through a relay to the open tab; live co-editing and suggestions in Docs; a model key per organization; the
native clients showing agent kinds (each a Parity line until then).
