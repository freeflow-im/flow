# Flow desktop (Electron)

The desktop client for macOS, Windows and Linux: an Electron shell around the
web client in `packages/web`. The design and the milestone plan are in
[`docs/specs/desktop-electron.md`](../../docs/specs/desktop-electron.md).
This package is M1–M2 of that plan: it signs in and chats; notifications,
badge, tray, media and installers are later milestones.

## Run it from source

```sh
pnpm install                                    # once; downloads Electron
pnpm --filter @flow/web build                   # the client the shell serves
pnpm --filter @flow/desktop build               # bakes config, compiles main + preload
pnpm --filter @flow/desktop start               # against https://app.freeflow.im
pnpm --filter @flow/desktop dev                 # against http://127.0.0.1:8787
```

Environment, the same names the macOS build script uses:

| Variable | Effect |
|---|---|
| `FLOW_SERVER_URL` | At `build` time: baked as the default server. At run time (unpackaged only): overrides it. |
| `FLOW_PROFILE` | A separate profile (`Flow Desktop-<name>` under the app-data directory), with its own credentials and window state, and named in the window title. |
| `FLOW_WEB_DIST` | Serve a web build from somewhere other than `packages/web/dist`. |

## Notifications while running from source (macOS)

The Electron binary pnpm installs is only ad-hoc signed, and macOS's
notification API refuses banners from an app without a real signing
identity (`UNErrorDomain error 1`, and no permission prompt). Once per
`pnpm install`, sign it with any identity in your login keychain:

```sh
apps/desktop/scripts/sign-dev-electron.sh        # default: "MyChat Dev Signing"
```

Then relaunch; macOS asks to allow notifications for "Electron" on the first
banner. A packaged release (spec M5) is signed with the Developer ID and
needs none of this.

## How it fits together

- `src/main/` — the Electron main process. `appProtocol.ts` serves the web
  build from `app://flow`; `secrets.ts` keeps bearers in the OS store;
  `index.ts` owns the window, `flow://` links, the menu and IPC.
- `src/preload/index.cts` — the bridge, `window.flowDesktop`, typed by
  `FlowDesktopBridge` in `@flow/shared`. The web client reaches it only
  through `packages/web/src/lib/host.ts`.
- The renderer is the unmodified `packages/web/dist`. There is no desktop-only
  UI code.

Sign-in with Google and with another Flow server both open the
system browser and come back through `flow://` links, as the macOS app does.
A server must accept the `app://flow` origin (any Flow server from this
change on does); an older one refuses the desktop at discovery with a clear
message.

## Tests

```sh
pnpm --filter @flow/desktop test      # pure helpers: argv/deep links, window bounds
```
