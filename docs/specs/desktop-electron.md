# Desktop client (Electron) for macOS, Windows and Linux

Status: Approved · 2026-09-20. **M1–M2 merged (#622)**: host seam,
server/connector origin admission, `apps/desktop` shell that signs in and
chats. **M3 built** (notifications, badge, tray). M4–M5 open.
Platforms: desktop (new), with changes to web and server

## Outcome and scope

A person on Windows or Linux can install Flow as a real desktop app, and a
person on macOS can install the same app. It behaves like the native macOS
client: it stays signed in across launches, keeps every connected server
online, shows OS notification banners with sound when something needs you,
keeps a count on the dock or taskbar icon, opens `flow://` links, updates
itself, and lets you drag files in, paste images, share your screen and join
huddles. It ships from one code base for all three operating systems.

The app is an Electron shell around the existing web client in
`packages/web`. The web client already has nearly everything the macOS app
has (multi-server connections, huddles, artifacts, find bar, activity
feed, notification preferences). What it lacks is the operating system: a
window that outlives the tab, a place to keep a token safely, banners that
open the right window, a badge, a URL scheme, an updater. That is what the
shell adds, through one small bridge.

Example: Dana uses Flow on a Windows laptop. She installs Flow, signs in with
Google (the system browser opens, then hands back to the app), and closes the
window. Flow keeps running in the tray. A DM arrives; Windows shows a toast
with a sound, the taskbar icon shows 1. She clicks the toast; the Flow window
comes back on that DM and the badge clears. A week later, Flow tells her a
new version is ready and installs it on restart.

**Parity target is the macOS client**, as recorded in `CHANGELOG.md`
**Parity** and `docs/design/NOTIFICATIONS.md`. Where macOS and web differ
today, the desktop app follows macOS. The gaps expected to remain are listed
under Acceptance below and go in the Parity ledger when the app ships.

V1 does not: build a new UI, share Swift code, add push (there is no push on
macOS either), add launch-at-login, or replace the native macOS app. The
native Swift app stays the promoted macOS client; the Electron build on macOS
is a supported download and the reference for the other two platforms.

### Why Electron and not Tauri

The user-visible gaps between clients today come from WebKit, not from the
shell: Safari cannot run mini apps in a frame, and Safari cannot share tab
audio (both in the Parity ledger). Tauri uses the OS web view (WebKit on
macOS, WebView2 on Windows, WebKitGTK on Linux), so one desktop client would
have three different browsers and would inherit those gaps. Electron ships
one Chromium, so the desktop app behaves the same everywhere, and it behaves
like the Chromium web client that QA already tests. The cost is a larger
download (about 100 MB per platform) and a Chromium upgrade cadence, both
accepted.

---

## User experience

### Install and sign in

- Downloads: `Flow.dmg` (macOS, universal), `Flow-Setup.exe` (Windows x64,
  NSIS, per-user install), `Flow.AppImage` and `flow.deb` (Linux x64). All
  served from `GET /download/desktop/<platform>`, the same 302-to-R2 pattern
  as `/download/mac`.
- First launch shows the same sign-in screen as the web client, pointed at
  the bundled default server (`https://app.freeflow.im`, or `FLOW_SERVER_URL`
  at build time, exactly as `apps/macos/tools/make-app.sh` bakes it).
- Email + password signs in inside the app. **Continue with Google** and **sign
  in to another Flow server** (PKCE) both open the
  *system browser* and return through `flow://` links, the same handoff the
  macOS app uses. Google blocks its sign-in inside embedded browsers, so this
  is required, not a preference. Registration and password reset work inside
  the app, as on web; this closes the macOS-only gap in the Parity ledger
  rather than copying it.
- The session token is kept in the OS credential store (Keychain, Windows
  Credential Manager via DPAPI, libsecret on Linux), one entry per
  connection + identity scope, matching `StorageScope` on macOS. Sign-out
  removes it and wipes the local caches for that scope.

### Windows, tray and quitting

- One main window, restored to its last size, position and display. Cmd+N /
  Ctrl+N opens another window (M4). Each window remembers its own workspace,
  channel, thread and panel, as `WindowState` does on macOS.
- **macOS:** closing the last window keeps the app in the Dock, like the
  native app. Cmd+Q quits.
- **Windows and Linux:** closing the last window hides the app to a tray icon
  and keeps it running, so notifications and the badge keep working. The tray
  menu has Open Flow, a per-connection unread summary, Check for Updates, and
  Quit. This is a deliberate divergence from macOS (which has no status
  item): it is the platform equivalent of staying in the Dock. A setting
  turns it off ("Quit when the window is closed").
- The window title follows macOS: `Flow` or `Flow — alice @ host` when
  `FLOW_PROFILE` is set.

### Notifications

The shell does not decide *what* notifies. The web client already applies the
whole model in `docs/design/NOTIFICATIONS.md`: the server-computed
`suppressAlert` gate, per-user preferences (DM, mention, group mention,
thread reply, reaction, channel invite, sound), and the "looking at it" rule.
The shell changes only *how* a banner is shown and what happens when it is
clicked:

- Banners go through the bridge to the main process and are shown with
  Electron's `Notification` (UNUserNotificationCenter on macOS, toast on
  Windows, libnotify on Linux). Title and body are the same strings the web
  client builds today. The channel name goes in the **subtitle** on macOS
  (closing the Parity item that the macOS banner names no conversation) and
  is folded into the title on Windows and Linux, as the web already must.
- `sound: false` maps to a silent notification. The OS Focus / Focus Assist /
  Do Not Disturb settings apply on their own; the app does not add a second
  DND layer, same as macOS.
- Clicking a banner shows and focuses the right window (creating one if the
  app was hidden to tray), switches to the owning connection and workspace,
  jumps to the message or thread, and marks the row read, the same routing
  `AppDelegate.route()` does on macOS. A click that arrives while the app is
  starting is queued and replayed once the renderer is ready.
- "Looking at it" is stricter than in a browser tab: the channel counts as
  seen only when `document.hidden` is false **and the window is focused**.
  The bridge reports focus changes so the web client can apply the same
  app-active gate the macOS `scenePhase` handler applies. Errs toward
  notifying, never toward swallowing.
- When several windows are open (M4), only one banner is shown per
  notification id; the main process de-duplicates by id.
- `persistentBanners` ("keep banners on screen") stays web-only. On desktop,
  how long a banner stays is an OS setting, as on macOS and iOS; the toggle
  is hidden when running in the shell.
- Permission: macOS asks on first banner (the app must be a signed bundle for
  banners to appear at all, exactly like `swift run` today). Windows and
  Linux do not prompt.

### Badge

- The unread-notifications total across all connections is set on the Dock
  icon (macOS), the taskbar icon overlay (Windows) and the launcher badge
  where the desktop supports it (Linux, Unity/KDE via `app.setBadgeCount`;
  else the tray icon shows a dot). The number is the server's total, summed
  across connections exactly as `refreshAggregateBadge()` does on macOS; it is
  re-asked from every connection when the app regains focus.

### Files and content

- Drag-and-drop and image paste already work in the web composer; they are
  verified on each OS.
- Downloads go to the OS Downloads folder. A finished download offers
  **Reveal in Finder / Show in folder** (parity with macOS).
- Links open in the system browser. Mini apps and link artifacts open in a
  separate Flow window with the minted token, inline in the app rather than a
  new browser tab (parity with the macOS panel). Any other `window.open` is
  refused and sent to the system browser.
- Text zoom (Cmd/Ctrl + `+`, `-`, `0`) is a menu command that persists per
  profile, matching macOS text zoom. Cmd/Ctrl+F opens the existing find bar.
- Spell-check with right-click suggestions is on (Chromium's checker), the
  same as the native text view on macOS. A context menu with Cut / Copy /
  Paste / Copy Link is provided; Electron has none by default.
- A standard application menu with the Edit roles is required on macOS so
  Cmd+C / Cmd+V / Cmd+A work at all.

### Huddles, screen share, devices

- Huddles use `livekit-client` exactly as the web client does.
- macOS asks for microphone and camera through the OS prompt; the bundle
  carries the usage strings and hardened-runtime entitlements
  `com.apple.security.device.audio-input` and `.camera`, as
  `tools/Flow.entitlements` does today. Windows and Linux do not prompt.
- Screen share: the shell answers `getDisplayMedia` with a picker. On
  macOS 15+ it uses the system picker; elsewhere it shows a Flow picker of
  screens and windows built from `desktopCapturer`. Screen Recording
  permission refused on macOS opens the same Privacy pane the native app
  opens. Windows can share system audio (loopback); macOS and Linux share
  silently, the same as the native macOS app today.

### Updates

- The app checks for updates daily and from **Check for Updates…** in the
  app menu (macOS) or the tray and Help menu (Windows, Linux), downloads in
  the background, and installs on the next restart with a prompt. Feed is
  `electron-updater`'s generic provider over R2, published at
  `/download/desktop/<platform>/…` next to the Sparkle feed.
- Linux `.deb` installs do not self-update (no supported mechanism); the
  AppImage does. The `.deb` shows a "new version available" link instead.

---

## Architecture

```
apps/desktop/                       @flow/desktop (added to the pnpm workspace)
  src/main/                          main process: windows, tray, menu, deep links,
                                     notifications, badge, updater, secrets,
                                     display-media handler, downloads, profiles
  src/preload/                       contextBridge → window.flowDesktop (typed by
                                     packages/shared/src/desktop.ts)
  src/renderer/                      none — loads packages/web/dist
  resources/                         icons, entitlements, tray images
  electron-builder.yml
  tools/release-desktop.sh           version from the live feed, tags desktop-v<ver>
packages/shared/src/desktop.ts       FlowDesktopBridge type + DESKTOP_ORIGIN
packages/web/src/lib/host.ts         getHost(): bridge when present, browser fallback
```

### Loading the web client

The shell **bundles** `packages/web/dist` and serves it from a privileged
custom scheme, origin `app://flow`, registered as standard and secure so
`localStorage`, `fetch`, WebSockets and service-worker-free caching behave as
on the web. It does not load `https://app.freeflow.im` at runtime.

Why bundle rather than load the site: the macOS app already pairs a client
build with a release, and multi-server means the client cannot assume it was
served by the server it talks to. Bundling gives the shell and the bridge
contract one version, a working sign-in screen when offline, and a clean
Content-Security-Policy. The cost is that web changes reach desktop users
only with a desktop release; that is already true of macOS and iOS.

Consequence for the web client: today the default connection is
`location.origin` (`packages/web/src/lib/connectionRuntime.ts`). On desktop
`location.origin` is `app://flow`, which is not a server. The web client
takes the default origin from the host (`host.defaultServerOrigin`) and
falls back to `location.origin` in a browser. Everything else already
resolves against a connection's canonical origin, not the page's.

Consequence for the server: a request from the shell carries
`Origin: app://flow`. The server's allowed-origin check (`FLOW_WEB_URL`,
`FLOW_ALLOWED_WEB_ORIGINS`) must accept the constant `DESKTOP_ORIGIN`
automatically, the way it accepts the canonical origin, and the R2 bucket
CORS rules must list it for presigned uploads. Another Flow server that has
not upgraded refuses the desktop at discovery; the app says so plainly
("This server does not accept desktop clients yet") rather than failing
later. The alternative, rewriting `Origin` in the shell, was rejected: it
also needs response-header rewriting to pass Chromium's CORS check, and it
hides which client is talking from every server it talks to.

### Bridge contract (`window.flowDesktop`)

Exposed with `contextIsolation: true`, `sandbox: true`, `nodeIntegration:
false`. Every call is typed in `packages/shared/src/desktop.ts` so the web
client and the shell compile against one contract. The renderer never gets a
Node API. As built in M2 the secrets calls are **synchronous**: the preload
loads the decrypted values once and mirrors writes to the main process, so
the web client's token reads stay synchronous and nothing in
`connectionRuntime.ts` had to become async. The shape below is the target;
`notifications`, `badge`, `windows.openApp` and `downloads` arrive with
M3–M4.

```ts
interface FlowDesktopBridge {
  platform: 'darwin' | 'win32' | 'linux';
  version: string;                       // shell version, shown in About
  profile: string | null;                // FLOW_PROFILE, for the window title
  defaultServerOrigin: string;           // baked FLOW_SERVER_URL
  isFocused(): Promise<boolean>;
  onFocusChange(cb: (focused: boolean) => void): () => void;

  notifications: {
    show(n: { id: string; title: string; subtitle?: string; body: string;
              silent: boolean; routing: NotificationRouting }): Promise<void>;
    onClick(cb: (routing: NotificationRouting) => void): () => void;
    clearDelivered(routingId: string): Promise<void>;
  };
  badge: { set(count: number): Promise<void> };
  secrets: {                             // safeStorage-backed, keyed by scope
    get(key: string): Promise<string | null>;
    set(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
  };
  links: {
    openExternal(url: string): Promise<void>;
    onDeepLink(cb: (url: string) => void): () => void;   // flow://…
  };
  windows: {
    openApp(url: string, title: string): Promise<void>;   // mini app / link artifact
    setTitle(title: string): Promise<void>;
  };
  downloads: { revealLast(): Promise<void> };
  zoom: { get(): Promise<number>; set(level: number): Promise<void> };
}
```

`NotificationRouting` is `{ routingId, workspaceId, channelId, messageId,
threadRootId }`, the same keys `Banners.swift` packs into `userInfo`.

The web client reaches all of this only through `packages/web/src/lib/host.ts`.
In a browser, `getHost()` returns a fallback with the same shape: the
Notification API, no badge, `window.open` for external links, `localStorage`
for secrets, a no-op deep-link listener. That keeps every call site free of
`if (isDesktop)` branches and keeps the browser behaviour unchanged.

### Web client changes (`[web]`)

1. `host.ts` and the fallback, plus the bridge type in `@flow/shared`.
2. Default connection origin from the host.
3. Session tokens through `host.secrets` in `connectionRuntime.ts` and the
   registry in `connections.ts`; a one-time move from `localStorage` on first
   desktop launch is not needed (fresh install).
4. `maybeBanner` in `Main.tsx` calls `host.notifications.show` with the
   subtitle and routing, and registers `onClick`. The seen rule adds the
   focus gate. `persistentBanners` hidden on desktop.
5. Badge: after every `notification.read` and each refresh, call
   `host.badge.set(total)`; re-ask on focus.
6. Auth: when the host is a desktop, Google and PKCE sign-in open the
   system browser with `returnUrl: flow://signin`, and the
   deep-link listener completes them through the existing
   `/v1/auth/app-link/exchange` and handoff paths. `NativeSignIn.tsx` already
   produces the code; `authHandoff.ts` already consumes it.
7. Mini apps and link artifacts call `host.windows.openApp` instead of a new
   tab.
8. Deep links `flow://invite/<token>` and `flow://signin?code=` are handled
   with the same rules as `AppState.handleDeepLink` (refuse a PKCE callback
   that has no pending operation; refuse a legacy link when more than one
   connection exists).

### Main process (`[desktop]`)

- **Single instance** on Windows and Linux; a second launch forwards its
  `flow://` argument to the running app. macOS uses the `open-url` event.
  `flow` is registered with `setAsDefaultProtocolClient` on all three.
- **Windows:** `BrowserWindow` per window; state saved per profile; a
  window's `webContents` is never destroyed while hidden to tray, so the
  connections stay online.
- **Security:** `setWindowOpenHandler` denies everything and opens the URL
  externally, except `openApp` windows created by the main process;
  `will-navigate` allows only `app://flow`; a permission request handler
  allows media, display-capture, notifications and clipboard-read and denies
  the rest; CSP on the `app://` document; Electron fuses set (no run-as-node,
  no node options, ASAR integrity on); `webview` tag disabled.
- **Notifications:** `Notification` per request; de-dup by id across
  windows; click → show/focus the window the routing belongs to (or the last
  focused one) then forward the routing to that renderer; pending click
  queue during startup.
- **Badge:** `app.setBadgeCount` on macOS and Linux; `setOverlayIcon` with a
  rendered count on Windows.
- **Secrets:** `safeStorage.encryptString` into a JSON file under the
  profile's `userData`; refuse to store when `isEncryptionAvailable()` is
  false and tell the renderer, which then falls back to session-only (no
  plaintext token on disk). On Linux this needs a running secret service;
  the fallback is the documented behaviour.
- **Profiles:** `FLOW_PROFILE` selects `userData` (`Flow-<profile>`), so
  QA's alice/scott fixtures run side by side as on macOS.
  `FLOW_SERVER_URL` at build time sets `defaultServerOrigin`; at run time it
  overrides it (dev only).
- **Display media:** `session.setDisplayMediaRequestHandler` with the system
  picker on macOS 15+, else a Flow picker window over `desktopCapturer`;
  loopback audio on Windows when the caller asked for audio.
- **Downloads:** `will-download` saves to the Downloads folder without a
  dialog and remembers the last path for `revealLast`.
- **Menu:** macOS app menu (About, Check for Updates…, Preferences → opens
  the profile view, Quit), Edit roles, View (zoom, find), Window. Windows and
  Linux get the same items under a hidden menu bar with accelerators, plus
  the tray menu.
- **Theme:** `nativeTheme.themeSource` follows what the web client renders
  (light today; the macOS app forces light). Revisit when the web adds dark.
- **Updater:** `electron-updater`, daily check + menu item, background
  download, prompt on ready. Feed URL baked from the server URL:
  `<server>/download/desktop/<platform>/`.

### Server changes (`[server]`)

- Accept `DESKTOP_ORIGIN` in the browser-origin check; report
  `capabilities.desktop = true` in `/v1/client-info` so discovery can explain
  a refusal.
- `GET /download/desktop/<platform>` (302 to the presigned installer) and
  `GET /download/desktop/<platform>/:asset` with the same whitelist regex
  approach as `/download/mac/:asset`, serving the updater's `latest*.yml`,
  `.zip`, `.exe`, `.AppImage` and blockmaps from R2 under
  `downloads/desktop/`.
- R2 CORS rule for `app://flow` (ops step, in `docs/ops/DEPLOYMENT.md`).

---

## Build, sign and release

| | macOS | Windows | Linux |
|---|---|---|---|
| Artifact | `.dmg` + `.zip` (updater), universal | NSIS `.exe` x64 + blockmap | `.AppImage` x64, `.deb` x64 |
| Signing | Developer ID (BizTrip AI Inc.), notarized, stapled — the same identity and `flow-notary` profile the Swift app uses | **Unsigned for now** (ruling 2026-09-20). Windows shows a SmartScreen warning on install; the download page explains the "More info → Run anyway" step. Auto-update still works. | none |
| Auto-update | yes | yes | AppImage yes, `.deb` no |
| Bundle / app id | `im.freeflow.desktop` (distinct from the Swift app's `com.flow.macos`, so both install) | `im.freeflow.desktop` | `im.freeflow.desktop` |

- Build: `pnpm --filter @flow/desktop build` runs the web build, then
  `electron-builder` for the current OS. The web build already runs
  `scripts/build-features.mjs`, so the What's New content ships with the
  app as it does on macOS.
- **The version comes from the release, not the repo** (the rule in
  `CLAUDE.md`). `apps/desktop/package.json` stays at `0.0.0`;
  `tools/release-desktop.sh` reads the live `latest-mac.yml`, adds one,
  passes the version to `electron-builder` through `extraMetadata`, and tags
  `desktop-v<version>` only after all three uploads succeed.
- **The release runs locally on the Mac, like the macOS app. No CI tooling
  for now** (ruling 2026-09-20). `electron-builder` builds all three targets
  from macOS in one run (`--mac --win --linux`): the Windows NSIS installer
  needs no signing tool because it ships unsigned, and the Linux AppImage
  and `.deb` build on macOS without extra setup. The macOS build signs and
  notarizes with the credentials `release-macos.sh` already uses, and the
  uploads use the R2 keys in the repo-root `.env`. Windows and Linux
  installers built this way are tested on a real machine or VM before the
  tag is pushed (see Verification). A CI workflow can be added later when a
  Windows certificate arrives; nothing in the layout depends on where the
  build runs.
- `BUILD.md` gains a row for the desktop app and `DEPLOYMENT.md` a section
  for the feed layout.

---

## Milestones

Each milestone is a PR or a short series, shippable alone, and lands nothing
user-visible on web or macOS until stated.

### M1 — Host seam in the web client `[web]` `[server]`

- `packages/shared/src/desktop.ts` (bridge type, `DESKTOP_ORIGIN`),
  `packages/web/src/lib/host.ts` with the browser fallback, default origin
  from the host, secrets through the host. Browser behaviour unchanged; unit
  tests for the fallback and the origin selection.
- Server accepts `DESKTOP_ORIGIN`; `/v1/client-info` reports `desktop`.

### M2 — Shell that signs in and chats `[desktop]`

- `apps/desktop` in the workspace; `app://flow` scheme; one window with
  state restore; app menu with Edit roles; context menu and spell-check;
  external links; single instance; `flow://` registration and deep links;
  profiles; dev script that points at the local server.
- Google and PKCE sign-in through the system browser and back.
- Runs on all three OSes from source. No installer yet.

### M3 — Notifications, badge, tray `[desktop]` `[web]`

- Banners with subtitle and click routing; focus gate in the seen rule;
  badge; tray with hide-on-close on Windows and Linux; pending-click queue.
- `packages/server/scripts/notify-e2e.mjs` gains a desktop mode that asserts one banner per
  behaviour through the bridge (mocked `Notification` in main).

### M4 — Media and windows `[desktop]`

- Display-media handler and picker; macOS entitlements and usage strings;
  downloads with reveal; mini-app windows; text zoom; multiple windows with
  banner de-dup.

### M5 — Packaging, updates, release `[desktop]` `[server]` `[ops]`

- `electron-builder` targets, signing and notarization on macOS, updater,
  `/download/desktop/*` routes, R2 layout and CORS, `release-desktop.sh`
  (local, all three targets), `BUILD.md` and `DEPLOYMENT.md`. First tagged
  release `desktop-v1.0.0`.
- Marketing site: Windows and Linux download buttons; macOS keeps the Swift
  app as the primary download (decision below).

---

## Verification

- `pnpm -r build` and `pnpm -r test` stay green; `@flow/desktop` typechecks
  against the shared bridge type.
- Playwright's Electron driver runs a smoke suite locally on the Mac
  (`pnpm --filter @flow/desktop test:e2e`): launch with `FLOW_SERVER_URL`
  at a local server, sign in with a fixture user, send and receive a
  message, receive a banner (mocked `Notification`), click routing, badge
  value, deep link into a channel, external link handling, zoom
  persistence. It is not wired into CI for now.
- QA (`.claude/agents/quality-assurance.md`) adds a desktop pass mirroring
  the macOS pass: notifications for each kind with the app focused, hidden to
  tray, and minimized; the "looking at it" rule across two windows; sign-out
  clears the credential store; update from the previous tagged build.
- Windows and Linux runs happen on real machines or VMs before each release;
  a Mac cannot verify toast or libnotify behaviour.

## Acceptance

- Installers for macOS, Windows and Linux are published at
  `/download/desktop/<platform>` and self-update (except `.deb`).
- Every macOS client behaviour in `CHANGELOG.md` Parity that is not marked
  macOS-only-by-nature is present on desktop, and each remaining difference
  has a Parity line. At minimum these are expected to remain and are recorded
  as deliberate: no Sign in with Apple; Linux badge depends on the desktop
  environment; `.deb` does not self-update; Windows is unsigned.
- Notification behaviours in `docs/design/NOTIFICATIONS.md` pass on desktop,
  and that document's per-client table gains a desktop column.
- The desktop client is a fifth surface: `changelog/README.md` adds the
  `[desktop]` tag, and the PR client-impact checklist in `CLAUDE.md` adds
  `- [ ] desktop client (Electron)`.
- `BUILD.md` and `docs/ops/DEPLOYMENT.md` describe the build, feed and
  release; `decision_log.md` records the rulings below.

## Decisions to confirm

1. **macOS positioning.** The Swift app stays the promoted macOS client; the
   Electron build on macOS is a supported download but not the default
   button. Both register `flow://`; when both are installed, macOS lets the
   user pick the handler, and QA runs with one installed.
2. **Bundle vs. remote load.** Bundle, as argued above.
3. **Tray on Windows and Linux, none on macOS.** Recorded as a deliberate
   divergence.
4. **`DESKTOP_ORIGIN` accepted by default** in the server's origin check,
   so third-party servers need only an upgrade, not a config change.

## Rulings already made (2026-09-20)

- **Windows ships unsigned.** No code-signing certificate for now; the
  SmartScreen warning is accepted and explained on the download page.
- **No CI tooling.** The release is a local script on the Mac that builds
  all three targets, the same shape as `release-macos.sh`. Revisit when a
  Windows certificate is bought.

Both go in `decision_log.md` when the first desktop PR lands.
