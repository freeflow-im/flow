#!/bin/bash
# Produce a signed, notarized, distributable macOS build of Flow.app — one
# non-interactive command after the one-time credential setup (phase 14, see
# docs/specs/phase14.md). Output: dist/Flow.dmg (a stapled dist/Flow.app inside),
# which opens with no Gatekeeper warning on a clean Mac.
#
# Usage:
#   FLOW_SIGN_IDENTITY="Developer ID Application: Jane Doe (AB12CD34EF)" \
#   FLOW_NOTARY_PROFILE="flow-notary" \
#   apps/macos/tools/dist.sh
#
# Env contract (§2 of the spec):
#   FLOW_SIGN_IDENTITY  Developer ID Application identity (required)
#   FLOW_NOTARY_PROFILE notarytool keychain profile name (required)
#   FLOW_SERVER_URL     server the build points at (optional; make-app.sh default)
#
# Runs identically locally and in CI. Holds no secrets — signing uses an
# identity already in the keychain, notarization a stored keychain profile.
# Never falls back to ad-hoc signing: a missing identity aborts the run, because
# an ad-hoc build cannot be notarized.
set -euo pipefail
cd "$(dirname "$0")/.."

fail() { echo "dist.sh: $*" >&2; exit 1; }

# Submit a container (.zip or .dmg) to Apple, block on the verdict, and abort
# with the log on anything but Accepted. Used for both the app (zipped) and the
# final DMG.
notarize() {
  local container="$1" json id status
  echo "==> Submitting $(basename "$container") to Apple notary service (waits for verdict)"
  json=$(xcrun notarytool submit "$container" \
    --keychain-profile "$FLOW_NOTARY_PROFILE" \
    --wait --output-format json) || { echo "$json" >&2; fail "notarytool submit failed"; }
  echo "$json"
  id=$(printf '%s' "$json" | /usr/bin/plutil -extract id raw - 2>/dev/null || true)
  status=$(printf '%s' "$json" | /usr/bin/plutil -extract status raw - 2>/dev/null || true)
  if [ "$status" != "Accepted" ]; then
    echo "==> Notarization did not succeed (status: ${status:-unknown}); fetching log" >&2
    [ -n "$id" ] && xcrun notarytool log "$id" --keychain-profile "$FLOW_NOTARY_PROFILE" >&2 || true
    fail "notarization rejected — see the log above (docs/specs/phase14.md §4 on entitlements)"
  fi
}

# --- Preflight: env + identity must be present before we build anything -------
[ -n "${FLOW_SIGN_IDENTITY:-}" ] || fail \
  "FLOW_SIGN_IDENTITY is unset. Set it to your Developer ID Application identity.
See docs/specs/phase14.md §2 for one-time credential setup."
[ -n "${FLOW_NOTARY_PROFILE:-}" ] || fail \
  "FLOW_NOTARY_PROFILE is unset. Set it to your notarytool keychain profile name.
See docs/specs/phase14.md §2 for one-time credential setup."

if ! security find-identity -p codesigning -v 2>/dev/null | grep -qF "$FLOW_SIGN_IDENTITY"; then
  fail "signing identity not found in keychain:
  $FLOW_SIGN_IDENTITY
Install the Developer ID Application certificate (docs/specs/phase14.md §2)."
fi

ENTITLEMENTS="tools/Flow.entitlements"
[ -f "$ENTITLEMENTS" ] || fail "missing $ENTITLEMENTS"

APP="dist/Flow.app"
ZIP="dist/Flow.zip"
DMG="dist/Flow.dmg"

# --- 1. Release build + bundle (reuse make-app.sh so bundling never drifts) ---
echo "==> Building release bundle"
tools/make-app.sh release

# --- 2. Sign: hardened runtime + secure timestamp + entitlements --------------
# Nested code first (make-app.sh signed it with the *dev* identity): notarization
# rejects a bundle whose nested code isn't Developer ID-signed under the hardened
# runtime with a secure timestamp. Inside-out — signing the app seals everything
# beneath it, so anything re-signed afterwards invalidates the outer signature.
SPARKLE_FW="$APP/Contents/Frameworks/Sparkle.framework"
echo "==> Signing embedded frameworks (nested code, inside-out)"
for nested in \
  "$SPARKLE_FW/Versions/B/XPCServices/Downloader.xpc" \
  "$SPARKLE_FW/Versions/B/XPCServices/Installer.xpc" \
  "$SPARKLE_FW/Versions/B/Updater.app" \
  "$SPARKLE_FW/Versions/B/Autoupdate" \
  "$SPARKLE_FW"; do
  [ -e "$nested" ] || continue
  codesign --force --options runtime --timestamp \
    -s "$FLOW_SIGN_IDENTITY" "$nested" \
    || fail "failed to sign $(basename "$nested")"
done

echo "==> Signing with Developer ID under the hardened runtime"
codesign --force --options runtime --timestamp \
  --entitlements "$ENTITLEMENTS" \
  -s "$FLOW_SIGN_IDENTITY" "$APP"

# --- 3. Verify the signature before spending time uploading -------------------
echo "==> Verifying signature"
codesign --verify --deep --strict --verbose=2 "$APP"

# --- 3a. Verify the bundle can actually reach the mic and camera (#469) -------
# Under `--options runtime` the hardened runtime gates mic and camera behind
# entitlements, and refuses them *before* TCC is consulted: no consent prompt,
# no entry in Privacy & Security, requestAccess false in milliseconds. That
# shipped for a while, because a missing entitlement is silent at build time
# and make-app.sh (no hardened runtime) can never reproduce it. So assert it
# here, on the signed artifact, where a regression costs a failed release
# instead of a bug report from someone else's machine. A usage string is the
# other half of the same grant — missing one, macOS kills the app on request.
echo "==> Verifying hardened-runtime device access"
SIGNED_ENTS=$(codesign -d --entitlements - --xml "$APP" 2>/dev/null)
for ent in com.apple.security.device.audio-input com.apple.security.device.camera; do
  printf '%s' "$SIGNED_ENTS" | grep -q "$ent" \
    || fail "the signed bundle is missing the '$ent' entitlement.
Huddle mic/camera would be denied with no prompt on every machine (issue #469).
Check $ENTITLEMENTS."
done
for key in NSMicrophoneUsageDescription NSCameraUsageDescription; do
  /usr/libexec/PlistBuddy -c "Print :$key" "$APP/Contents/Info.plist" >/dev/null 2>&1 \
    || fail "the built bundle's Info.plist has no $key — macOS terminates an app
that requests the device without one. Check tools/make-app.sh."
done

# --- 4. Zip for submission (notarytool needs a container) ---------------------
echo "==> Packaging zip for notarization"
rm -f "$ZIP"
ditto -c -k --keepParent "$APP" "$ZIP"

# --- 5. Notarize the app, blocking on the verdict -----------------------------
notarize "$ZIP"

# --- 6. Staple the ticket so the app validates offline ------------------------
echo "==> Stapling notarization ticket to the app"
xcrun stapler staple "$APP"

# --- 7. Package the styled DMG (drag-to-Applications window) -------------------
# dmgbuild writes the install-window layout — the arrow background and the
# /Applications symlink — straight into the DMG's .DS_Store, headless (no Finder
# / AppleScript). Layout in tools/dmg-settings.py; the background is
# Resources/dmg-background.png, regenerated from tools/make-dmg-bg.swift if absent.
echo "==> Building styled DMG"
BG="Resources/dmg-background.png"
[ -f "$BG" ] || swift tools/make-dmg-bg.swift "$BG"
python3 -c "import dmgbuild" 2>/dev/null || fail \
  "dmgbuild not installed. Install it:
  pip3 install --user --break-system-packages dmgbuild   (or: pipx install dmgbuild)
It builds the drag-to-Applications install window headlessly."
rm -f "$DMG"
python3 - "$APP" "$DMG" "$BG" <<'PY'
import sys, dmgbuild
app, dmg, bg = sys.argv[1], sys.argv[2], sys.argv[3]
dmgbuild.build_dmg(dmg, "Flow", settings_file="tools/dmg-settings.py",
                   defines={"app": app, "background": bg})
PY

# --- 8. Notarize + staple the DMG itself --------------------------------------
# The app inside is already stapled; notarizing and stapling the distributed
# .dmg removes the "downloaded from the Internet" check at mount time too, so
# even mounting works offline (Apple's recommended practice: notarize the final
# artifact). Requires a second notary round-trip.
notarize "$DMG"
echo "==> Stapling notarization ticket to the DMG"
xcrun stapler staple "$DMG"

# --- 9. Final gate check — what a fresh Mac will assess -----------------------
echo "==> Gatekeeper assessment"
spctl --assess --type execute --verbose "$APP"   # expect: accepted, source=Notarized Developer ID
xcrun stapler validate "$APP"
xcrun stapler validate "$DMG"

rm -f "$ZIP"

# --- 10. Sparkle update archive + appcast -------------------------------------
# Existing installs update from the appcast, not the DMG: Sparkle downloads a
# zip of the *stapled* app and swaps it in place. generate_appcast signs each
# archive with the EdDSA private key from the login keychain (public half is
# baked into the bundle as SUPublicEDKey) and writes the feed.
UPDATES_DIR="dist/updates"
SPARKLE_BIN=$(find .build/artifacts -type d -name bin -path "*sparkle*" 2>/dev/null | head -1)
if [ -n "$SPARKLE_BIN" ] && [ -x "$SPARKLE_BIN/generate_appcast" ]; then
  VERSION=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$APP/Contents/Info.plist")
  BUILD=$(/usr/libexec/PlistBuddy -c "Print :CFBundleVersion" "$APP/Contents/Info.plist")
  DOWNLOAD_PREFIX=${FLOW_UPDATE_URL_PREFIX:-"https://app.freeflow.im/download/mac/"}
  echo "==> Packaging update archive Flow-$VERSION-$BUILD.zip"
  # Keep only the newest archives: generate_appcast lists every zip it finds, and
  # an unbounded directory means an unbounded feed (and a slow publish).
  mkdir -p "$UPDATES_DIR"
  ditto -c -k --keepParent "$APP" "$UPDATES_DIR/Flow-$VERSION-$BUILD.zip"
  ls -t "$UPDATES_DIR"/Flow-*.zip 2>/dev/null | tail -n +6 | xargs rm -f 2>/dev/null || true

  echo "==> Generating signed appcast"
  # Key source: the login keychain by default (Sparkle's recommendation — the
  # private key never touches disk). A keychain read needs a GUI prompt the
  # first time, which a headless/CI run can't answer, so FLOW_SPARKLE_KEY_FILE
  # points at an exported key for those. "$@"-style expansion, not an array —
  # bash 3.2 (see make-app.sh).
  set -- --download-url-prefix "$DOWNLOAD_PREFIX"
  if [ -n "${FLOW_SPARKLE_KEY_FILE:-}" ]; then
    [ -f "$FLOW_SPARKLE_KEY_FILE" ] || fail "FLOW_SPARKLE_KEY_FILE not found: $FLOW_SPARKLE_KEY_FILE"
    set -- "$@" --ed-key-file "$FLOW_SPARKLE_KEY_FILE"
  fi
  "$SPARKLE_BIN/generate_appcast" "$@" "$UPDATES_DIR" \
    || fail "generate_appcast failed.
If it reported a Keychain error (-25320), the signing key exists but this
(non-interactive) run can't be granted access. Authorize it once from YOUR
terminal, clicking 'Always Allow' at the prompt:
  $SPARKLE_BIN/sign_update $UPDATES_DIR/*.zip
Or export the key for headless use and set FLOW_SPARKLE_KEY_FILE:
  $SPARKLE_BIN/generate_keys -x sparkle-private-key.txt   # keep this OUT of git
If there is no key at all, create one: $SPARKLE_BIN/generate_keys
(its public half belongs in tools/sparkle-public-key.txt)"
  echo "    feed: $UPDATES_DIR/appcast.xml"
else
  echo "warning: Sparkle tools not found — skipping appcast (existing installs won't see this build)"
fi

echo
echo "Done. Distributable: $DMG"
echo "  → download, open, drag Flow to /Applications, launch — no Gatekeeper prompt."
[ -f "$UPDATES_DIR/appcast.xml" ] && \
  echo "  → existing installs update from $UPDATES_DIR/appcast.xml (publish with tools/publish-dmg.sh)"
