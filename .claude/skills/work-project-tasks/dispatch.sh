#!/usr/bin/env bash
# One tick of the queue dispatcher: if work is queued and this machine has room
# for it, start a Claude Code run that takes the next batch off the board.
#
#   dispatch.sh              # run one tick
#   dispatch.sh --dry-run    # decide, print the decision, start nothing
#
# Installed as a LaunchAgent that fires every few minutes — see
# com.freeflow.flow-dispatcher.plist. Nothing here is Flow-specific: it decides
# *whether* to dispatch, and `claude -p` plus SKILL.md do the rest.
#
# PERMISSIONS: THE DISPATCHED RUN BYPASSES THEM
#
# The run takes a batch all the way to a PR, so it needs git, pnpm, swift,
# xcodebuild and gh — and it is unattended, so there is nobody to answer a
# prompt. The first live run proved the failure mode: it wrote the whole of
# #260, then could not commit, build or push, and blocked itself with the code
# stranded in a worktree.
#
# `claude -p` gets no Flow MCP tools (those come from the agent-bridge, not
# from any .mcp.json), so it cannot create_channel or start_task. It therefore
# takes SKILL.md's inline fallback and does the work itself. Two consequences
# worth being clear about:
#
#   - There is no #task-N channel for a dispatched batch. Progress lives in
#     this log and in the PR, not in Flow. Wiring the bridge's MCP into this
#     invocation would restore the hand-off, and is the better long-term shape.
#   - bypassPermissions means an unattended agent can run anything on this
#     machine as this user. Operator decision, taken knowingly (Scott,
#     2026-08-16). The guards below are what bounds it: no dispatch during a
#     release, a concurrency cap, and one run at a time per machine.
#
# WHAT THIS DOES NOT DO
#
# It does not claim the batch. Claiming belongs with the run that does the work,
# so the skill takes the cross-machine lock (task-lock.sh) as its first act. If
# two machines tick at the same moment, both may start a run and one will lose
# the lock and exit in seconds — which is cheap, and correct.
#
# The local flock below is not the lock that matters. It stops ONE machine
# racing itself when a tick runs long; the git ref is what stops two machines
# taking the same work.
set -uo pipefail

REPO_ROOT=${FLOW_REPO_ROOT:-$HOME/flow}
MAX_ACTIVE=${FLOW_MAX_ACTIVE:-2}
LOG=${FLOW_DISPATCH_LOG:-$HOME/flow-dispatcher.log}
PROMPT=${FLOW_DISPATCH_PROMPT:-"work on the next task from the active queue"}
# Flow credentials for the run's MCP server, and who to invite to the channel.
AGENT_JSON=${FLOW_AGENT_JSON:-$HOME/agent.json}
# Use the bridge build that is actually running, not the repo's dist/. They are
# not the same thing: the repo copy is stale because `pnpm --filter
# flow-agent-bridge build` currently fails (TS2339, ChannelDTO.parentId), and a
# stale build silently advertises FEWER tools — create_channel and
# invite_to_channel are missing from it, which is exactly the feature we need.
# Resolution order: explicit override, the running daemon's own entrypoint,
# then the repo copy as a last resort.
BRIDGE_ENTRY=${FLOW_BRIDGE_ENTRY:-}
if [ -z "$BRIDGE_ENTRY" ]; then
  BRIDGE_ENTRY=$(pgrep -fl "flow-agent-bridge/dist/index.js" 2>/dev/null \
    | grep -o '[^ ]*flow-agent-bridge/dist/index\.js' | head -1)
fi
[ -n "$BRIDGE_ENTRY" ] || BRIDGE_ENTRY=$REPO_ROOT/packages/agent-bridge/dist/index.js
INVITE_USER=${FLOW_DISPATCH_INVITE_USER:-}
# Where a stray send_message lands if the run posts before making its channel.
FALLBACK_CHANNEL=${FLOW_DISPATCH_FALLBACK_CHANNEL:-flow-task-work}

DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

say() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }

# One dispatcher per machine. A tick that overruns must not stack.
exec 9>/tmp/flow-dispatcher.lock
if ! /usr/bin/flock -n 9 2>/dev/null; then
  # macOS has no flock(1) by default; fall back to a pid file.
  if [ -f /tmp/flow-dispatcher.pid ] && kill -0 "$(cat /tmp/flow-dispatcher.pid 2>/dev/null)" 2>/dev/null; then
    say "another tick is still running — skipping"; exit 0
  fi
  echo $$ > /tmp/flow-dispatcher.pid
  trap 'rm -f /tmp/flow-dispatcher.pid' EXIT
fi

cd "$REPO_ROOT" 2>/dev/null || { say "no repo at $REPO_ROOT"; exit 1; }

# A release owns the whole machine: it needs a clean main, and two Xcode builds
# at once is how you get a confusing failure in the one that matters.
if pgrep -f "release-macos.sh|release-ios.sh|publish-dmg.sh" >/dev/null 2>&1; then
  say "a release is running — skipping"; exit 0
fi

# Concurrency. Count what the board says is already being worked, not local
# processes: the other runs may be on another machine.
ACTIVE=$(gh project item-list 1 --owner freeflow-im --format json --limit 100 2>/dev/null \
  | python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except Exception: print(999); raise SystemExit
print(sum(1 for i in d.get('items',[]) if i.get('status')=='In Progress'))")

if [ "$ACTIVE" = "999" ]; then say "cannot read the board — skipping"; exit 0; fi
if [ "$ACTIVE" -ge "$MAX_ACTIVE" ]; then
  say "$ACTIVE task(s) already in progress (cap $MAX_ACTIVE) — skipping"; exit 0
fi

# Advisory only: the skill re-reads the queue and is the authority. This just
# avoids paying for a Claude run to discover the queue is empty.
BATCH=$(bash "$REPO_ROOT/.claude/skills/work-project-tasks/next-batch.sh" 2>/dev/null)
COUNT=$(printf '%s' "$BATCH" | python3 -c "
import json,sys
try: print(len(json.load(sys.stdin)))
except Exception: print(0)")

if [ "${COUNT:-0}" -eq 0 ]; then say "nothing queued"; exit 0; fi

KEY=$(printf '%s' "$BATCH" | python3 -c "
import json,sys
print(min(i['number'] for i in json.load(sys.stdin)))")

if [ "$DRY" = 1 ]; then
  say "would dispatch batch task-$KEY ($COUNT issue(s)); $ACTIVE active, cap $MAX_ACTIVE"
  exit 0
fi

say "dispatching batch task-$KEY ($COUNT issue(s)); $ACTIVE active, cap $MAX_ACTIVE"

# --- Give the run its own Flow tools ----------------------------------------
# The bridge does not *contain* the flow tools, it *spawns* them: bridge.ts's
# writeMcpConfig launches `node <bridge>/dist/index.js mcp` with the agent token
# in env. Nothing about that is bridge-only, so the dispatcher writes the same
# config and its run gets create_channel, invite_to_channel and send_message —
# which is what puts a #task-N channel and a human back in the loop.
#
# FLOW_BRIDGE_SOCK is deliberately empty. That socket only exists for runs the
# daemon itself spawned, so start_task cannot work here — and should not: the
# hand-off exists to give a *waiting human* their agent back, and a cron tick
# has nobody waiting. The run creates its channel and works in it, which is
# SKILL.md §3's "If start_task is unavailable" path.
MCP_ARGS=()
MCP_CFG=""
if [ -f "$AGENT_JSON" ] && [ -f "$BRIDGE_ENTRY" ]; then
  MCP_CFG=$(FLOW_AGENT_JSON="$AGENT_JSON" BRIDGE_ENTRY="$BRIDGE_ENTRY" \
            FALLBACK_CHANNEL="$FALLBACK_CHANNEL" INVITE_USER="$INVITE_USER" \
            python3 - <<'PY'
import json, os, subprocess, sys, tempfile
cfg = json.load(open(os.environ['FLOW_AGENT_JSON']))
url, token = cfg['serverUrl'], cfg['agentToken']

def api(path):
    out = subprocess.run(['curl', '-fsS', '-H', f'Authorization: Bearer {token}',
                          f'{url}{path}'], capture_output=True, text=True)
    return json.loads(out.stdout) if out.returncode == 0 else None

ws = api('/v1/me/workspaces')
if not ws or not ws.get('workspaces'):
    sys.exit(1)                                   # no workspace → run without MCP
wsid = ws['workspaces'][0]['id']

chans = api(f'/v1/workspaces/{wsid}/channels') or {}
want = os.environ['FALLBACK_CHANNEL']
fallback = next((c['id'] for c in chans.get('channels', []) if c.get('name') == want), '')

doc = {'mcpServers': {'flow': {
    'command': 'node',
    'args': [os.environ['BRIDGE_ENTRY'], 'mcp'],
    'env': {
        'FLOW_SERVER_URL': url,
        'FLOW_AGENT_TOKEN': token,
        'FLOW_WORKSPACE_ID': wsid,
        'FLOW_CHANNEL_ID': fallback,
        'FLOW_THREAD_ROOT_ID': '',
        'FLOW_USER_ID': os.environ.get('INVITE_USER', ''),
        'FLOW_BRIDGE_SOCK': '',      # no daemon → no start_task, by design
    },
}}}
fd, path = tempfile.mkstemp(prefix='flow-dispatch-mcp-', suffix='.json')
with os.fdopen(fd, 'w') as f:
    json.dump(doc, f)
print(path)
PY
  ) || MCP_CFG=""
fi

if [ -n "$MCP_CFG" ]; then
  MCP_ARGS=(--mcp-config="$MCP_CFG")
  say "flow tools wired ($MCP_CFG)"
  PROMPT="$PROMPT

You were started by the queue dispatcher on a timer. No human is waiting on a
reply, so there is nothing to hand off to and start_task will not work here —
follow SKILL.md §3 'If start_task is unavailable' and do the work in this run.
Still create the task channel first and report into it as you go: that channel
is the only place a human can watch this or stop you.${INVITE_USER:+ Invite <@$INVITE_USER> to it.}"
else
  say "flow tools unavailable — the run will have no channel to report in"
fi

# This blocks for as long as the batch takes — tens of minutes, not seconds,
# because the run does the work itself rather than handing it off. That is
# fine: the pid guard at the top makes the next tick a no-op, and the board's
# In Progress count stops a second batch starting behind it.
claude -p "$PROMPT" --permission-mode bypassPermissions "${MCP_ARGS[@]}" 2>&1 | sed 's/^/    /'
rc=${PIPESTATUS[0]}
[ -n "$MCP_CFG" ] && rm -f "$MCP_CFG"
say "dispatch run finished (exit $rc)"
