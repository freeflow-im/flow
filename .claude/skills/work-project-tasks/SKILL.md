---
name: work-project-tasks
description: >
  Pull the next unit of work off the Flow team's GitHub Project queue and take it
  all the way to a pull request. Use when asked to "work on the next task from the
  active queue", "work on the next batch", "take the next queued task", "what's
  next in the queue", or "pick up the next Project task". Covers finding the next
  queued batch, claiming it, reporting progress in a Flow channel, building it in
  an isolated worktree, verifying it with screenshots, opening a PR that closes
  every issue in the batch, and marking the Project items Done.
---

# Working tasks from the Project queue

Work is queued on the GitHub Project **"Flow work queue"**
(`freeflow-im` project **#1**), not in the issue list. The board at
`github.com/orgs/freeflow-im/projects/1` is the source of truth for
*what to do next*; issues are the source of truth for *what the task is*.

Invoking this skill means: **take the next batch off the queue and see it
finished.** One batch → one Flow channel → one worktree → one branch → one PR.

Two runs share that sentence. **You** (the run that was asked) find the batch,
claim it, open the channel and hand off; a **separate run of you, homed in the
task channel via `start_task`**, builds it. The conversation you were asked in
gets a one-line pointer and its agent back within a minute — not a multi-hour
"thinking…". If the handoff tool isn't available you do it all yourself
(§3, *If start_task is unavailable*), which is the fallback, not the design.

## The queue model

Every project item has a **Status** and an optional **Batch**.

| Status | Meaning |
|---|---|
| `Todo` | In the backlog. Not yours to take. |
| `Queued for Dev` | Staged by a human. **This is what you pick up.** |
| `In Progress` | Claimed — someone (probably you) is working it. |
| `Blocked` | Started, can't proceed. Needs a human. Not yours to retry. |
| `Done` | Landed. |

**Batch** is a number field. Items sharing a batch number are **one unit of
work**: one branch, one PR closing all of them. An item with no batch is a batch
of one. Never take half a batch, and never merge two batches into one PR.

Queue order is the project's own item order — the topmost `Queued for Dev` item
is next.

You need `gh` authenticated with the `project` scope:

```sh
gh auth status          # want: Token scopes include 'project'
```

---

## 1. Find the next batch

```sh
bash .claude/skills/work-project-tasks/next-batch.sh
```

It prints a JSON array of the batch members (`itemId`, `number`, `title`,
`repo`, `body`, `status`, `batch`) — **empty when nothing is queued**. Always
valid JSON, so you can pipe it straight into a parser.

**If the array is empty, stop.** Say so, and do not go looking for work in the
backlog — `Todo` items are deliberately not yours to start.

Read every member's `body` before planning. A batch is grouped because the
issues are related; the shape of the fix usually only makes sense across all of
them.

## 2. Claim the batch

Claiming is **two steps in this order**: take the lock, then set the status.

### 2a. Take the cross-machine lock

```sh
bash .claude/skills/work-project-tasks/task-lock.sh claim <lowest issue number>
```

**If this exits non-zero, another machine owns the batch. Stop — that is not an
error, and it is not yours to retry.** Say so and end the run.

Setting `In Progress` is a *signal*, not a claim. Projects V2 has no conditional
update, so two machines can both read a batch as `Queued for Dev`, both write
`In Progress`, and both start the same work. Creating a git ref is a real
compare-and-swap: GitHub gives 201 to exactly one caller and 422 to the rest.
That is the lock, and unlike anything on one machine's disk it works when runs
are dispatched from more than one Mac.

The lock is keyed on the **batch** — the lowest issue number — so claiming half
a batch is impossible.

### 2b. Set the status

```sh
bash .claude/skills/work-project-tasks/set-status.sh "In Progress" <itemId> [<itemId> ...]
```

Claim the **whole batch in one go**. `next-batch.sh` only lists members that are
still `Queued for Dev`, so claiming them one at a time leaves the rest looking
available — and the next agent along will take half your batch.

## 3. Open a Flow channel and hand the work off

Work in the open. Create one channel per batch: it is the batch's running
record and — once you hand off — the working run's *home conversation*, where a
human can watch and steer it before it's gone too far.

Use the `flow` MCP tools (see the `flow-agent-member` skill for the full set):

- `create_channel` — `name` `task-<lowest issue number>`, e.g. `task-81`. Put the
  batch in the `topic`: `#81, #110, #111 — message hover polish`. Leave it
  **public** (`isPrivate` false) and **top-level** (no `parentId`) — the channel
  represents the *task*, which outlives any one run and must be findable in
  Browse. (A verbose command-by-command log, if one is wanted, can go in a
  sub-channel *of the task channel* later — never the other way around.)
- `invite_to_channel` — add whoever asked you to run this, plus anyone already
  discussing the issues. Several `userIds` in one call; `list_users` gets the ids.
- `start_task` — the handoff itself, below.

### The handoff

Call `start_task` with the new channel's id and a **self-contained brief**. The
new run starts from nothing but your prompt — it has not seen this
conversation, the queue JSON, or anything you know unless you put it in:

```
You are working a batch from the Flow work queue, handed off by another run of
yourself. This channel is your conversation and the batch's running record —
anyone posting here is steering you; treat their word as the operator's.

Batch (ALREADY claimed In Progress — do not re-claim):
<the JSON array from next-batch.sh, verbatim>

Requested by: <display name> <@userId>. Source conversation channelId: <id>.

Read every issue in the batch, then POST A NUMBERED PLAN IN THIS CHANNEL
BEFORE YOU WRITE ANY CODE — 3-8 steps, each one finishable and checkable, in
the order you will do them. Not the issue restated: the steps. Then work the
plan and post one short message per step you finish, naming the step and what
it produced. If the plan changes, post the revision and the reason.

Follow .claude/skills/work-project-tasks/SKILL.md §4–§8: fresh worktree off
origin/main, build, test, verify in the running app with screenshots, one PR
closing every issue, then set the items Done — or Blocked per "If you can't
finish". Post here at the moments §3's reporting list names; upload
screenshots as you take them. If you are Blocked or need a decision, ALSO
send_message the question to the source conversation channelId above — the
requester is there, not here.
```

Then reply **one line** and end your turn — the bridge posts your final text
back where you were asked, so the reply *is* the announcement:

> Working #81, #110, #111 (batch 1) — handed off to a run in #task-81.

**Do not do the work yourself after a successful handoff**, and don't wait for
the run — it reports in the channel, and that pointer is the whole of what the
source conversation gets.

### Plan first (governs whichever run does the work)

**Before you write a line of code, post a plan in the channel.** Numbered steps,
in the order you intend to do them, each one a thing that can be *finished* and
checked off. Three to eight for a normal batch.

This is the most valuable message in the channel. It is the moment when someone
can say "no, not like that" for the price of one message, instead of after you
have built the wrong thing.

A plan is not the issue restated. Compare:

> ~~Going to fix the quote block spacing on both native clients.~~

> 1. Reproduce in the macOS app with a multi-segment message.
> 2. Make the text drive the height — accent bar as an `overlay`, not an `HStack` sibling.
> 3. Mirror the same change in the iOS view.
> 4. Screenshot before/after on both.
> 5. Changelog entry, VERSION bump, PR.

The second one can be argued with. The first cannot.

**Read every issue in the batch before planning**, and make the plan cover the
whole batch — the grouping exists because the issues share a shape.

**When the plan changes, say so.** A step that turns out to be wrong, or work you
did not foresee, is not a failure — silently abandoning the plan is. Post the
revision and the reason in one message, then carry on against the new plan.

### Reporting (governs whichever run does the work)

Post at the moments a human might want to intervene, not every command:

1. **On claim** — what you picked up and the issue numbers, followed by the plan
   above. Nothing else happens until this is posted.
2. **On finishing a plan step** — name the step, and what it produced: the
   behaviour you now see, the file you changed, the test that went green. One or
   two lines. This is the progress signal — someone reading the channel should be
   able to tell how far through the plan you are without asking.
3. **On a surprise** — the issue was wrong, the fix is bigger than described, two
   issues in the batch conflict, a step in the plan was mistaken. Say so when you
   find it, not in the summary, and post the revised plan with it.
4. **Screenshots** — as evidence accumulates.
5. **On PR** — the link.
6. **At the end** — `Done` with the PR, or `Blocked` with the reason.

**Tie progress to the plan, not to the clock or the command history.** One
message per step finished is the right rate: a long step is one message even if
it took an hour, and a burst of ten commands that completes one step is still one
message. Do not post "still working" — it carries nothing. Do not narrate every
file you read.

Keep it readable. A channel that narrates every file read is one nobody reads;
the test is whether someone skimming it later can tell what happened, how far it
got, and why.

Cross-link both ways: put the channel in the PR body, and the PR link in the
channel.

### Report in one place

**The channel is the report. The source conversation got its pointer at
handoff and hears nothing more until the end.** Writing the run up twice is
the failure mode here: the requester reads the same thing in two places, and
the channel stops being the record because everything important also lands in
a DM. For a handed-off run this mostly takes care of itself — the task channel
is its home conversation, so its replies (including the final one) land there.

Two things still go to the *source* conversation (`send_message` with the
source channelId from your brief), because a channel nobody has opened yet is
a bad place to put them:

- **A decision you need.** If you're `Blocked`, or you stopped to ask something,
  the question goes where the person actually is. A pointer to a question is not
  a question.
- **Anything outside the task they should know now** — you found the batch was
  mis-scoped, or a shared machine is in a state that will bite the next run.

Otherwise: link, don't repeat.

### If start_task is unavailable

No daemon behind this run, or the tool errors: **do the work yourself, in this
turn**, reporting into the channel per the list above. The requester's
conversation shows "thinking…" until you finish — the price of the fallback.
The bridge posts your final reply into the conversation you were invoked from
whatever you write, so keep it to one or two lines, not zero:

> #113 done — PR #119. Details in #task-113.

**If the `flow` tools aren't available at all** — no bridge, no MCP server —
carry on without them and say so in your final report. Losing the progress
channel is not a reason to abandon the task, and with no channel to point at,
that final reply *is* the report — write it in full.

## 4. Branch in a fresh worktree

Never build in the main checkout — it may be mid-edit, and other worktrees exist.

```sh
git -C "$(git rev-parse --show-toplevel)" fetch origin
git worktree add -b fix/issue-<n>-<slug> ../flow-wt-<slug> origin/main
cd ../flow-wt-<slug>
pnpm install
```

Branch off **`origin/main`**, never off whatever is checked out. Name the branch
after the lowest issue number in the batch.

## 5. Build it

Read `CLAUDE.md` first — it is the working-conventions contract and several of
its rules block a merge. The ones that bite most often:

- **`changelog/` gets one new entry file** (`YYYY-MM-DD-short-slug.md`, format
  in `changelog/README.md`) with platform tags (`[server]` `[web]` `[macos]`
  `[ios]` `[bridge]` `[qa]`). One or two lines per bullet. A change that lands
  on one client but not another **must** add a Parity line to `CHANGELOG.md`.
- **The entry file gets a `## Feature` section** with a friendly one-liner if
  the change is user-visible; skip the section for refactors, tests and infra.
  `FEATURES.md` is generated from these — never edit it directly.
- **Bump `apps/macos/VERSION` in any PR touching `apps/macos/**`**, including
  the shared Swift core iOS reuses.

Run the local stack when you need it:

```sh
docker compose -f packages/infra/docker-compose.yml up -d   # postgres on 5442
pnpm dev                                                    # 127.0.0.1:8787
```

> The dev server binds **127.0.0.1:8787**. If something else already holds that
> port, stop it or set `PORT` — don't assume the page you're looking at is Flow.

## 6. Test, then verify for real

```sh
pnpm test          # whole workspace
pnpm -r build      # typecheck everything that ships
```

Green tests are necessary, not sufficient. **Look at the change in the running
app** and capture screenshots for the PR.

**You are authorized to drive the UI.** `CLAUDE.md` and the QA manual
(`.claude/agents/quality-assurance.md`) require an idle desktop or explicit
operator authorization for browser and macOS automation, because it normally
takes over a human's screen. Agents running this skill are on a **dedicated
machine**, which is that authorization standing — don't stop to ask.

The one condition: if you can tell you're *not* on a dedicated host — someone is
using the desktop, or you were started on a person's laptop — the original gate
applies again. Ask, and open the PR without screenshots if no answer comes.

So, screenshots:

- **Web** — drive Chrome via the browser MCP tools (load them with ToolSearch
  first; `claude-in-chrome` needs site permission for `127.0.0.1`).
- **macOS** — build with `apps/macos/tools/make-app.sh`, then
  `screencapture -x -R"$X,$Y,$W,$H" /tmp/shot.png` and `Read` the file.

Prefer the accessibility tree for asserting *state* — it's cheaper and more
precise than pixels. Screenshots are evidence of *appearance*, which is what
the PR wants.

### Put the machine back

Everything you started for the verification, stop when you're done. The next
agent inherits this machine, and so does the human whose desktop it is: a dev
server left holding a port sends the following run off to test against the
wrong build. Stop your server, quit the app builds you launched, terminate the
simulator app, and undo any system setting you flipped to make a check possible
(appearance, for instance).

```sh
pkill -f "flow-wt-<slug>/packages/server"          # your dev server
pkill -f "flow-wt-<slug>/apps/macos/dist/Flow.app" # your macOS build
xcrun simctl terminate booted org.flowtoo.app      # your simulator app
```

Match on your **own worktree path**, never a bare `pkill -f Flow` — other agents
run their own copies and the human may have the real app open. Check what a PID
actually is (`lsof -p <pid> | awk '$4=="cwd"'`) before killing anything you
can't attribute. Whatever was already running when you arrived — postgres, a
simulator someone else booted, whatever holds 8787 — is not yours to stop.

If you took a port other than 8787 because 8787 was busy, mention in the channel
that it's going away, so nobody is left poking at a server you just killed.

## 7. Commit, push, open the PR

Commit, then open one PR for the whole batch, closing every issue in it:

```sh
git push -u origin fix/issue-<n>-<slug>
gh pr create --base main --title "..." --body "$(cat <<'EOF'
<what changed and why — the reasoning belongs here, not in CHANGELOG.md>

Closes #81
Closes #110
Closes #111

Progress log: #task-81 in Flow.

## Verification
<screenshots, and what you asserted>
EOF
)"
```

Attach screenshots by uploading them to the PR body (drag-and-drop equivalent:
`gh pr comment` with an image URL, or push them to a branch and link). One
`Closes #n` line **per issue in the batch** — that is what makes merging the PR
close all of them.

## 8. Mark the batch Done

Only after the PR is open (and merged, if you were asked to merge):

```sh
bash .claude/skills/work-project-tasks/set-status.sh Done <itemId> [<itemId> ...]
bash .claude/skills/work-project-tasks/task-lock.sh release <lowest issue number>
```

**Release the lock, always** — on `Done` and on `Blocked` alike. A lock left
behind blocks that batch for every machine, and the hourly sweeper will report
it as stale with your hostname on it. This is why "every task you claim ends as
`Done` or `Blocked`" is now load-bearing rather than good manners.

Then close out **in the channel**: the PR URL, the issues it closes, what you
verified, and anything you deliberately left out. A handed-off run's final
reply lands there automatically — make it the close-out and you're done. An
inline (fallback) run instead posts one line back where it was asked — the
outcome, the PR, and the channel to read. Not a second copy of the close-out
(§3, *Report in one place*).

---

## If you can't finish

Mark it **`Blocked`** and say why. An item left in `In Progress` with nobody on
it is worse than one honestly blocked — the board claims it's being handled when
it isn't.

Both steps are required. The status is the signal, the comment is the reason,
and a status with no reason just hands a human the same puzzle you had.

```sh
bash .claude/skills/work-project-tasks/set-status.sh Blocked <itemId> [<itemId> ...]
bash .claude/skills/work-project-tasks/task-lock.sh release <lowest issue number>

gh issue comment <n> --repo freeflow-im/flow --body "$(cat <<'EOF'
**Blocked:** <the one-line reason>

<what you tried, and what you need — a decision, a credential, a spec answer.>
EOF
)"
```

Block the **whole batch**, and comment on **every issue in it**. Whoever picks it
up will be looking at one of them, not necessarily the one you chose. Post the
reason in the Flow channel as well — that's where someone is watching.

Blocking is the one case where the requester's conversation carries the
substance: state what you need there — a handed-off run `send_message`s the
source conversation channelId from its brief; an inline run puts it in its
reply. Don't just point at the channel: nobody unblocks a question they
haven't read.

**`Blocked`, not back to `Queued for Dev`.** Re-queueing hides the problem: the
next agent takes the task and walks into the same wall. A human moves it back to
`Queued for Dev` once the blocker is resolved — that's their call, not yours.

Write the comment for someone who wasn't there. Name the specific decision or
missing fact, not "couldn't get it working". If the task is underspecified, ask
the precise question rather than guessing — a wrong guess costs more than a
round trip.

## Rules worth restating

- **Don't start `Todo` work.** If the queue is empty, the answer is "nothing is
  queued", not "here's something from the backlog I picked".
- **Don't split or merge batches.** The grouping is a human decision about what
  belongs in one review.
- **Don't mark Done without a PR.** Done means the change exists and is
  reviewable, not that you finished editing.
- **Don't leave anything in `In Progress`.** Every task you claim ends the run
  as `Done` or `Blocked` — **and releases its lock.** A lock left behind blocks
  that batch on every machine, not just this one.
- **Don't take work whose lock you lost.** A non-zero `task-lock.sh claim` means
  another machine has it. That's the system working, not a problem to route
  around — never delete someone else's lock to proceed.
- **Don't retry a `Blocked` task.** It's blocked on a human, not on effort.
- **Don't push to `main`.** Everything goes through a PR.
- **Don't leave your servers running.** The run ends with the machine as you
  found it — your dev server, app builds and simulator app stopped, and any
  system setting you changed put back.
- **Don't work the batch in the conversation you were asked in** when
  `start_task` is available. Claim, open the channel, hand off, reply one line,
  end your turn. The inline path is the fallback for a missing daemon, not a
  choice.
- **Don't start building before the plan is posted.** The plan is the cheap
  moment to be corrected; code written ahead of it spends that chance.
- **Don't let the plan go stale.** If you stop following it, post the revision.
  A channel whose plan no longer matches the work is worse than none.
- **Don't work silently.** If the channel exists, the run should be legible from
  it alone — including how far through the plan it got.
- **Don't report twice.** The channel gets the write-up; where you were asked
  gets a line pointing at it. The exception is something they must act on — a
  blocker, a question, a decision.
