#!/usr/bin/env bash
# A cross-machine lock for a queue batch, held as a git ref on GitHub.
#
#   task-lock.sh claim   <key>     # 0 = you own it, 1 = someone else does
#   task-lock.sh release <key>     # always 0, missing lock is not an error
#   task-lock.sh list              # every held lock: key, holder, age
#   task-lock.sh sweep [hours]     # print locks older than N hours (default 2)
#
# WHY A REF AND NOT THE STATUS FIELD
#
# Setting Status to "In Progress" is a signal, not a claim. Projects V2 has no
# conditional update — `updateProjectV2ItemFieldValue` is last-write-wins with
# no "only if it is currently Queued for Dev". Two machines can both read the
# item as queued, both write In Progress, and both start the same work.
#
# Creating a git ref *is* a compare-and-swap: POST /git/refs returns 201 to
# exactly one caller and 422 "Reference already exists" to the rest, decided on
# GitHub's side with no timing assumptions. That makes it a real lock, and it
# works from any machine — which a local flock cannot.
#
# The refs live under refs/flow-locks/, not refs/heads/, so they never appear
# as branches in the UI, in `git branch -a`, or in anyone's fetch.
#
# The ref points at a parentless commit whose message and author date record
# who took the lock and when. A ref alone carries no timestamp, so without it a
# dead lock is indistinguishable from a live one and `sweep` has nothing to read.
set -uo pipefail

REPO=${FLOW_LOCK_REPO:-freeflow-im/flow}
NS=flow-locks

fail() { echo "task-lock: $*" >&2; exit 2; }

# Key it on the BATCH — the lowest issue number — matching the skill's
# one-batch-one-branch rule. A per-item lock would let one machine claim half a
# batch while another takes the rest.
key_ref() { printf 'refs/%s/task-%s' "$NS" "$1"; }

cmd_claim() {
  local key=$1 base tree sha
  [ -n "$key" ] || fail "claim needs a batch key"

  base=$(gh api "repos/$REPO/git/ref/heads/main" --jq .object.sha 2>/dev/null) \
    || fail "cannot read main — is gh authenticated?"
  tree=$(gh api "repos/$REPO/git/commits/$base" --jq .tree.sha) \
    || fail "cannot read main's tree"

  # Parentless, so it is attached to no history and can never be mistaken for
  # work. It exists only to carry the holder and the timestamp.
  sha=$(gh api -X POST "repos/$REPO/git/commits" --input - --jq .sha <<JSON
{"message": "claim task-$key by ${USER:-unknown}@$(hostname -s) pid $$", "tree": "$tree"}
JSON
  ) || fail "cannot create the claim commit"

  if gh api -X POST "repos/$REPO/git/refs" \
       -f ref="$(key_ref "$key")" -f sha="$sha" >/dev/null 2>&1; then
    echo "claimed task-$key"
    return 0
  fi

  # 422 is the normal outcome of losing a race, not a failure to report.
  echo "task-$key is already claimed" >&2
  return 1
}

cmd_release() {
  local key=$1
  [ -n "$key" ] || fail "release needs a batch key"
  if gh api -X DELETE "repos/$REPO/git/refs/$NS/task-$key" >/dev/null 2>&1; then
    echo "released task-$key"
  else
    echo "task-$key was not locked" >&2
  fi
  return 0
}

# Print "key<TAB>holder<TAB>age_hours" for every held lock.
locks() {
  local refs
  refs=$(gh api "repos/$REPO/git/matching-refs/$NS" --jq '.[] | .ref + " " + .object.sha' 2>/dev/null) || return 0
  [ -n "$refs" ] || return 0
  while read -r ref sha; do
    [ -n "$ref" ] || continue
    local msg date age
    msg=$(gh api "repos/$REPO/git/commits/$sha" --jq .message 2>/dev/null)
    date=$(gh api "repos/$REPO/git/commits/$sha" --jq .author.date 2>/dev/null)
    age=$(python3 -c "
import datetime,sys
try:
    d=datetime.datetime.fromisoformat(sys.argv[1].replace('Z','+00:00'))
    now=datetime.datetime.now(datetime.timezone.utc)
    print(round((now-d).total_seconds()/3600, 1))
except Exception:
    print('?')" "$date" 2>/dev/null)
    printf '%s\t%s\t%s\n' "${ref#refs/$NS/task-}" "${msg#claim task-* by }" "$age"
  done <<<"$refs"
}

cmd_list() {
  local out
  out=$(locks)
  if [ -z "$out" ]; then echo "no locks held"; return 0; fi
  printf 'batch\tholder\thours\n'
  printf '%s\n' "$out"
}

# Report stale locks. Deliberately does NOT delete them: a lock that keeps going
# stale is a bug worth seeing, and clearing it silently sends the next machine
# into the same wall. Same reasoning as never auto-requeueing an In Progress item.
cmd_sweep() {
  local max=${1:-2} found=0
  while IFS=$'\t' read -r key holder age; do
    [ -n "$key" ] || continue
    [ "$age" = "?" ] && continue
    if (( $(echo "$age > $max" | bc -l) )); then
      echo "STALE: task-$key held by $holder for ${age}h"
      found=1
    fi
  done <<<"$(locks)"
  [ "$found" = 0 ] && echo "no stale locks"
  return 0
}

case "${1:-}" in
  claim)   cmd_claim "${2:-}" ;;
  release) cmd_release "${2:-}" ;;
  list)    cmd_list ;;
  sweep)   cmd_sweep "${2:-2}" ;;
  *) fail "usage: task-lock.sh claim|release <key> | list | sweep [hours]" ;;
esac
