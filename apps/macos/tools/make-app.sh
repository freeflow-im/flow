#!/bin/bash
# Wraps the SwiftPM executable in a minimal Flow.app bundle (phase 2,
# operator ruling): enables UNUserNotificationCenter banners and registers the
# flow:// URL scheme with LaunchServices. `swift build` and the bare-executable
# QA launch path are untouched.
#
# Usage: tools/make-app.sh [debug|release]   (default: debug)
#   FLOW_SERVER_URL=http://127.0.0.1:8787 tools/make-app.sh   # local-server app
# Packaged apps default to production; `swift build`/`swift run` (no bundle
# plist) keep defaulting to the local dev server.
set -euo pipefail
cd "$(dirname "$0")/.."

CONF=${1:-debug}
SERVER_URL=${FLOW_SERVER_URL:-https://app.freeflow.im}

# Build tag = the short commit SHA of this build. `BUILD_SHA` env var overrides
# for CI; `dev` outside a checkout. The workspace menu shows the marketing
# version instead; this is its dev-build fallback (see BuildInfo.swift).
BUILD_SHA=${BUILD_SHA:-$(git rev-parse --short HEAD 2>/dev/null || echo "dev")}

# Marketing version (VERSION file) + a MONOTONIC build number. Sparkle orders
# updates by CFBundleVersion, so it must always increase: the commit count on
# the current branch does that without any state to keep. A SHA cannot be
# compared, which is why FlowBuild alone was never enough to detect "newer".
# FLOW_APP_VERSION is how a release supplies the marketing version:
# tools/release-macos.sh derives it from the live appcast and passes it in. The
# VERSION file is only the fallback for local builds — do not bump it in a PR.
SHORT_VERSION=${FLOW_APP_VERSION:-$(cat VERSION 2>/dev/null || echo "2.0.0")}
BUILD_NUMBER=${FLOW_BUILD_NUMBER:-$(git rev-list --count HEAD 2>/dev/null || echo "1")}

# Appcast the updater polls. Points at whichever server this build talks to, so
# a local-server build never offers production updates.
FEED_URL=${FLOW_APPCAST_URL:-"$SERVER_URL/download/mac/appcast.xml"}
# EdDSA public key matching the private key that signs releases (tools/sign_update).
# Empty in dev builds: Sparkle then refuses to install anything, which is the
# safe default — an unsigned feed must never be trusted.
SPARKLE_PUBKEY=${FLOW_SPARKLE_PUBKEY:-$(cat tools/sparkle-public-key.txt 2>/dev/null || echo "")}

swift build -c "$CONF"

BIN=".build/$CONF/Flow"
APP="dist/Flow.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$BIN" "$APP/Contents/MacOS/Flow"
cp Resources/AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"
# Ship the user-facing release notes so the "What's new" sheet (opened from the
# Build label in the workspace menu) can render them. Read via Bundle.main.
# FEATURES.md is generated from changelog/ — build it fresh first.
node ../../scripts/build-features.mjs
cp ../../FEATURES.md "$APP/Contents/Resources/FEATURES.md"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key><string>Flow</string>
    <key>CFBundleDisplayName</key><string>Flow</string>
    <key>CFBundleIdentifier</key><string>com.flow.macos</string>
    <key>CFBundleVersion</key><string>${BUILD_NUMBER}</string>
    <key>CFBundleShortVersionString</key><string>${SHORT_VERSION}</string>
    <key>CFBundleExecutable</key><string>Flow</string>
    <key>CFBundleIconFile</key><string>AppIcon</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>LSMinimumSystemVersion</key><string>14.0</string>
    <key>FlowServerURL</key><string>${SERVER_URL}</string>
    <key>FlowBuild</key><string>${BUILD_SHA}</string>
    <key>SUFeedURL</key><string>${FEED_URL}</string>
    <key>SUPublicEDKey</key><string>${SPARKLE_PUBKEY}</string>
    <!-- Ask on second launch rather than nagging at first run; the user's
         answer is remembered and changeable from the update dialog. -->
    <key>SUEnableAutomaticChecks</key><true/>
    <key>SUScheduledCheckInterval</key><integer>86400</integer>
    <key>NSHighResolutionCapable</key><true/>
    <key>NSPrincipalClass</key><string>NSApplication</string>
    <!-- Huddles: mic (Phase 1) and camera (#435). Screen Recording has no
         usage-description key — macOS grants it through System Settings only. -->
    <key>NSMicrophoneUsageDescription</key><string>Flow needs microphone access to let you talk in a huddle.</string>
    <key>NSCameraUsageDescription</key><string>Flow needs camera access to let you turn on video in a huddle.</string>
    <key>CFBundleURLTypes</key>
    <array>
        <dict>
            <key>CFBundleURLName</key><string>com.flow.macos.invite</string>
            <key>CFBundleURLSchemes</key>
            <array><string>flow</string></array>
        </dict>
    </array>
</dict>
</plist>
PLIST

# --- Embed Sparkle (auto-update) ----------------------------------------------
# SwiftPM resolves it as an XCFramework but, unlike Xcode, does nothing to put
# it inside the bundle: without this the app launches and immediately dies on
# a missing @rpath/<Name>.framework. Copy the macOS slice, then teach the
# executable to look in Contents/Frameworks (SwiftPM emits @loader_path and the
# toolchain paths, neither of which finds it).
mkdir -p "$APP/Contents/Frameworks"
NEEDS_RPATH=0
for FW_NAME in Sparkle; do
  # Excludes __MACOSX: some of these XCFrameworks arrive as a re-zipped
  # download, which leaves an `__MACOSX/` sibling of AppleDouble resource-fork
  # stubs alongside the real tree — same framework name, no real symlinks
  # inside. `find`'s traversal order isn't guaranteed, so without this filter
  # `head -1` can silently pick the stub and produce a Frameworks/ entry that
  # copies but fails to codesign ("bundle format unrecognized").
  FW=$(find .build/artifacts -type d -name "$FW_NAME.framework" -path "*macos*" ! -path "*__MACOSX*" 2>/dev/null | head -1)
  if [ -n "$FW" ]; then
    # ditto (not cp) preserves the framework's symlink layout and xattrs — a
    # flattened framework fails to load and cannot be signed correctly.
    ditto "$FW" "$APP/Contents/Frameworks/$FW_NAME.framework"
    NEEDS_RPATH=1
  else
    echo "warning: $FW_NAME.framework not found under .build/artifacts — this build may not launch"
  fi
done
if [ "$NEEDS_RPATH" = "1" ]; then
  install_name_tool -add_rpath "@executable_path/../Frameworks" \
    "$APP/Contents/MacOS/Flow" 2>/dev/null || true
fi

# Sign nested code INSIDE-OUT (deepest first); a container's signature covers
# everything within it, so signing the app first and the framework after
# invalidates the app. `codesign --deep` is Apple-discouraged and gets the
# order wrong for XPC services, hence the explicit walk.
# Extra codesign flags (the release path adds --options runtime --timestamp)
# come after the identity and are forwarded with "$@" — NOT a named array:
# macOS ships bash 3.2, where expanding an empty named array under `set -u` is
# an "unbound variable" error that kills the script mid-bundle. "$@" is
# special-cased and safe when empty.
sign_nested() {
  local identity="$1"; shift
  local sparkle="$APP/Contents/Frameworks/Sparkle.framework"
  local targets=(
    "$sparkle/Versions/B/XPCServices/Downloader.xpc"
    "$sparkle/Versions/B/XPCServices/Installer.xpc"
    "$sparkle/Versions/B/Updater.app"
    "$sparkle/Versions/B/Autoupdate"
    "$sparkle"
  )
  for t in "${targets[@]}"; do
    [ -e "$t" ] || continue
    codesign --force "$@" -s "$identity" "$t" >/dev/null 2>&1 \
      || echo "warning: codesign failed for $(basename "$t")"
  done
}

# Signature: required for UserNotifications + Keychain on modern macOS.
# Prefer the stable "MyChat Dev Signing" identity (kept across the Flow rename) (self-signed, in the login
# keychain): a persistent identity means Keychain ACLs survive rebuilds, so
# the token-access prompt happens once ever instead of once per build.
# Fall back to ad-hoc when the identity is absent (fresh machines, CI).
IDENTITY="MyChat Dev Signing" # existing dev cert kept across the Flow rename (new cert = manual trust setup)
if security find-identity -p codesigning -v 2>/dev/null | grep -q "$IDENTITY"; then
  sign_nested "$IDENTITY"
  codesign --force -s "$IDENTITY" "$APP" >/dev/null 2>&1 \
    || { sign_nested -; codesign --force -s - "$APP" >/dev/null 2>&1; } \
    || echo "warning: codesign failed (banners may not work)"
else
  sign_nested -
  codesign --force -s - "$APP" >/dev/null 2>&1 || echo "warning: codesign failed (banners may not work)"
fi

# Register the flow:// scheme with LaunchServices.
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
  -f "$(pwd)/$APP" >/dev/null 2>&1 || true

echo "Built $APP"
echo "Run with:  open $APP    (or FLOW_PROFILE=name $APP/Contents/MacOS/Flow)"
