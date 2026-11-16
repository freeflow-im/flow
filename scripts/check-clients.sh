#!/usr/bin/env bash
# Compile both native clients from the shared sources, locally, before pushing.
#
# macOS and iOS share the data model, networking, GRDB cache, SyncEngine and
# AppState; the platform-specific halves (Banners, ImageLoader, every View) are
# separate files with matching signatures. Nothing but a compiler notices when
# one of those signatures drifts — and only the *other* platform's compiler.
# PR #465 is the case this exists for: shared `SyncEngine` gained a `sound:`
# argument, the iOS `Banners` shim did not grow the parameter, macOS stayed
# green, and a 6.5-minute CI run was the first thing to say so.
#
# Usage:
#   scripts/check-clients.sh              # compile both, in parallel
#   scripts/check-clients.sh --tests      # …and run both hermetic test suites
#   scripts/check-clients.sh --macos      # one platform only
#   scripts/check-clients.sh --ios
#   scripts/check-clients.sh --serial     # interleaved logs, one at a time
#
# The first run in a fresh worktree pays for fetching and building the SPM
# dependencies and takes minutes.
# After that both halves are incremental — seconds when nothing shared moved.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

DO_MACOS=1
DO_IOS=1
WITH_TESTS=0
PARALLEL=1
IOS_DEVICE="${CHECK_CLIENTS_IOS_DEVICE:-iPhone 17}"

for arg in "$@"; do
  case "$arg" in
    --macos|--macos-only) DO_IOS=0 ;;
    --ios|--ios-only) DO_MACOS=0 ;;
    --tests) WITH_TESTS=1 ;;
    --serial) PARALLEL=0 ;;
    -h|--help) sed -n '2,26p' "${BASH_SOURCE[0]}" | sed 's|^# \{0,1\}||'; exit 0 ;;
    *) echo "check-clients: unknown option $arg" >&2; exit 2 ;;
  esac
done

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
red()  { printf '\033[31m%s\033[0m\n' "$1"; }
green(){ printf '\033[32m%s\033[0m\n' "$1"; }

command -v xcodebuild >/dev/null || { red "xcodebuild not found — install Xcode 26."; exit 1; }
if [ "$DO_IOS" = 1 ] && ! command -v xcodegen >/dev/null; then
  red "xcodegen not found — brew install xcodegen"
  exit 1
fi

LOGDIR="$(mktemp -d "${TMPDIR:-/tmp}/check-clients.XXXXXX")"
trap 'rm -rf "$LOGDIR"' EXIT

check_macos() {
  local log="$LOGDIR/macos.log"
  {
    if [ "$WITH_TESTS" = 1 ]; then
      # LiveAPITests need a live server and skip themselves without one, so a
      # plain `swift test` here is still hermetic.
      swift test --package-path apps/macos
    else
      swift build --package-path apps/macos --build-tests
    fi
  } >"$log" 2>&1
  echo $? >"$LOGDIR/macos.status"
}

check_ios() {
  local log="$LOGDIR/ios.log"
  {
    # Regenerating is cheap and keeps the project in step with project.yml —
    # the file that says which shared sources iOS actually compiles.
    xcodegen generate --spec apps/ios/project.yml --project apps/ios --quiet || exit $?
    # A test action has to name a concrete simulator; a build does not, which
    # is why the default check needs no booted device.
    local -a cmd
    cmd=(xcodebuild -project apps/ios/FlowiOS.xcodeproj -scheme Flow
         -derivedDataPath apps/ios/.build -quiet CODE_SIGNING_ALLOWED=NO)
    if [ "$WITH_TESTS" = 1 ]; then
      cmd+=(-destination "platform=iOS Simulator,OS=latest,name=$IOS_DEVICE")
      cmd+=(-only-testing:FlowUnitTests test)
    else
      cmd+=(-destination 'generic/platform=iOS Simulator' build)
    fi
    "${cmd[@]}"
  } >"$log" 2>&1
  echo $? >"$LOGDIR/ios.status"
}

started=$(date +%s)
bold "check-clients: compiling$([ "$WITH_TESTS" = 1 ] && echo ' and testing') $( [ "$DO_MACOS" = 1 ] && printf 'macOS '; [ "$DO_IOS" = 1 ] && printf 'iOS' )"

if [ "$PARALLEL" = 1 ]; then
  [ "$DO_MACOS" = 1 ] && check_macos &
  macos_job=$!
  [ "$DO_IOS" = 1 ] && check_ios &
  ios_job=$!
  wait $macos_job 2>/dev/null
  wait $ios_job 2>/dev/null
else
  [ "$DO_MACOS" = 1 ] && check_macos
  [ "$DO_IOS" = 1 ] && check_ios
fi

elapsed=$(( $(date +%s) - started ))
failed=0

report() {
  local name="$1" key="$2" enabled="$3"
  [ "$enabled" = 1 ] || return 0
  local status
  status="$(cat "$LOGDIR/$key.status" 2>/dev/null || echo 1)"
  if [ "$status" = 0 ]; then
    green "  ✓ $name"
  else
    failed=1
    red "  ✗ $name"
    # The compiler lines that matter, not the whole transcript — errors when
    # there are any, and only then everything else it had to say.
    local lines
    lines="$(grep -E 'error: ' "$LOGDIR/$key.log" | head -12)"
    [ -n "$lines" ] || lines="$(tail -12 "$LOGDIR/$key.log")"
    printf '%s\n' "$lines" | sed 's/^/      /'
    echo "      (full log: $LOGDIR/$key.log — kept until this shell exits)"
  fi
}

echo
report "macOS" macos "$DO_MACOS"
report "iOS" ios "$DO_IOS"
echo
if [ "$failed" = 1 ]; then
  # Keep the logs around when there is something to read in them.
  trap - EXIT
  red "check-clients: FAILED in ${elapsed}s"
  exit 1
fi
what="$( [ "$DO_MACOS" = 1 ] && printf 'macOS'; [ "$DO_MACOS" = 1 ] && [ "$DO_IOS" = 1 ] && printf ' + '; [ "$DO_IOS" = 1 ] && printf 'iOS' )"
green "check-clients: $what $([ "$WITH_TESTS" = 1 ] && echo green || echo 'builds clean') in ${elapsed}s"
