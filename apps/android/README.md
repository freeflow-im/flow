# Flow for Android (Capacitor)

The Android client: the web client in `packages/web`, in a thin Capacitor
shell. The route and the phasing are in
[`docs/design/ANDROID.md`](../../docs/design/ANDROID.md); the seam it is
built on is the desktop client's
([`docs/specs/desktop-electron.md`](../../docs/specs/desktop-electron.md),
"Bridge contract"). This package is the shell that signs in and chats — the
Android counterpart of `apps/desktop` M1–M2. Push, huddles in the background,
the share target and the Play release come as their own changes.

## How it fits together

- The WebView loads the bundled `packages/web/dist` from Capacitor's local
  server at `https://flow.localhost` — a real secure context — and talks to
  the Flow server baked into the build. The server admits that origin as a
  bundled client, the way it admits the desktop's `app://flow`
  (`ANDROID_ORIGIN` in `@flow/shared`; `docs/dev/MULTISERVER.md`).
- **The bridge** is the desktop's `FlowDesktopBridge`, reached by the web
  client through `packages/web/src/lib/host.ts` like everywhere else. A
  WebView has no preload, so it is built in two parts:
  - `ShellBoot.java` registers a **document-start script** for the app's
    origin only, which leaves `window.flowShellBoot`: the info block
    (`platform: 'android'`, version, the baked server) and a decrypted
    snapshot of the credentials — what keeps the web client's token reads
    synchronous, as the Electron preload's mirror does.
  - `FlowShellPlugin.java` (Capacitor plugin `FlowShell`) takes everything
    after boot: credential writes into `EncryptedSharedPreferences`
    (`Secrets.java`), `openExternal` as a Chrome Custom Tab, and `flow://`
    links the OS handed the app, delivered as retained plugin events so a
    cold-start link is never lost.
  - `packages/web/src/lib/hostAndroid.ts` folds the two into the bridge
    shape. There is no Android-only UI code and the web client never depends
    on Capacitor.
- Sign-in with Google, with another Flow server, and with Slack open the
  system browser and come back through `flow://` links, as on desktop and
  macOS. `LinkPolicy.java` keeps both directions to the app's own scheme and
  http(s)/mailto, the desktop's `argv.ts` rules.

## Build

Needs JDK 21 and the Android SDK (`ANDROID_HOME`, platform 36, build-tools
36); `pnpm -r build` and the root `pnpm test` deliberately do not, which is
why this package has no `build` or `test` script — the JUnit tests are
`test:android`, and `android.yml` is where they run.

```sh
pnpm install
pnpm --filter @flow/web build                     # the client the shell bundles
pnpm --filter @flow/android apk:debug             # → android/app/build/outputs/apk/debug/app-debug.apk
```

Which server the app talks to is a Gradle property, the way `apps/desktop`
bakes `FLOW_SERVER_URL`: `-PflowServerUrl=https://flow.example.com`
(default `https://app.freeflow.im`). The web bundle is server-agnostic.
Version: `-PflowVersionCode` / `-PflowVersionName` (CI passes the commit
count; a local build is `1` / `0.1.0-local`).

Debug builds carry the committed `debug.keystore`, so every debug APK from
any machine installs over the previous one, and trust **user-installed CA
certificates** (`src/debug/…/network_security_config.xml`) so a development
server behind a private CA works; a release build keeps Android's default of
system CAs only.

Plain `http://` is allowed only to a loopback server, and only when the web
client permits it (`packages/web/src/lib/serverOrigin.ts`); a phone has no
loopback Flow server, so a LAN development server needs HTTPS.
`FLOW_ANDROID_DEV=1` at `cap sync` time additionally relaxes the WebView
(cleartext, mixed content, remote inspection) for a loopback dev build —
never for a build that ships.

Install and run on a device: `adb install -r app-debug.apk`; inspect the
page at `chrome://inspect` when built with `FLOW_ANDROID_DEV=1`.

## Tests

```sh
pnpm --filter @flow/android test:android         # JUnit: boot script, link policy (pure JVM; needs a cap sync first)
pnpm --filter @flow/web test -- hostAndroid       # the bridge adapter
```

## CI: `.github/workflows/android.yml`

- Every PR touching `apps/android/**`, `packages/web/**` or
  `packages/shared/**` gets a debug APK as a workflow artifact (login
  required to download). Reports, does not block.
- A push to `main` or a `feat/android-*` branch **also attaches the APK to a
  rolling pre-release** when the repository variable `ANDROID_DEV_RELEASE_TAG`
  is set — a stable, login-free link for testers:
  `https://github.com/<owner>/flow/releases/download/<tag>/flow-android-debug.apk`.
  Unset = no release is touched (upstream's default).
- The server the APK talks to is the variable `ANDROID_SERVER_URL` (default
  `https://app.freeflow.im`); `ANDROID_DEV_BUILD=1` makes it a dev build;
  `ANDROID_RUNNER` picks the runner label.

## Phone over Wi-Fi from a build VM

A VM without USB passthrough reaches the phone with Android 11+ wireless
debugging: Developer options → Wireless debugging → *Pair device with pairing
code*, then `adb pair <ip>:<pair-port>` and `adb connect <ip>:<port>`.
