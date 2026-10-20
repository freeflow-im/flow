# Building and releasing Flow

Flow ships as five separate things on different schedules. This page is the
index: what each one is, the single command that builds it, and the single
command that releases it. Details live in the linked docs — this file stays a
map, not a duplicate.

If you only want to run Flow locally, you want
[Local development](#local-development) below, or the quick start in
[README.md](README.md). If you want to run Flow on your own server, you want
[DEPLOYMENT.md](DEPLOYMENT.md).

| Artifact | Build | Release | Automatic? |
|---|---|---|---|
| Server + web client | `pnpm build` | `git push origin main` | **Yes** — Railway builds every push to `main` |
| macOS app | `apps/macos/tools/make-app.sh` | `apps/macos/tools/release-macos.sh` | No — run locally, needs signing credentials |
| iOS app | `xcodegen generate` + Xcode | `apps/ios/tools/release-ios.sh` | No — run locally, needs the signing account |
| `flow-agent-bridge` (npm) | `pnpm --filter flow-agent-bridge build` | bump `version`, merge to `main` | **Yes** — GitHub Actions publishes |
| Android app | `pnpm --filter @flow/android apk:debug` | — (no release path yet, ANDROID.md phase 6) | No |
| Marketing site (`flowlandingpage/`) | `pnpm build` (in `flowlandingpage/`) | merge to `main` | **Yes** — GitHub Actions deploys to Cloudflare Pages |
| Desktop app (Electron, `apps/desktop`) | `pnpm --filter @flow/desktop build` then `start` | not yet — M5 of `docs/specs/desktop-electron.md` | No — runs from source only today |

The desktop app is in the workspace but **not** in the Railway build
(`railway.json` filters it out): the server never needs it, and its Electron
dev dependency is a 100 MB download. Set `ELECTRON_SKIP_BINARY_DOWNLOAD=1` on
the Railway `app` service so `pnpm install` skips that download too.

Three of these release themselves when you merge, and two do not. **Merging to
`main` does not ship the macOS or iOS app.** That is the single most common
thing to get wrong.

---

## Local development

Prerequisites: Node 22+, pnpm 10, Docker, and — for the native clients —
macOS 14+ with Xcode 26.

```sh
cd packages/infra && docker compose up -d   # Postgres on host port 5442, NATS
pnpm install
pnpm build                                  # = pnpm -r build across every package

cd packages/server
pnpm migrate
pnpm dev                                    # http://127.0.0.1:8787
```

The server serves the API, the WebSocket gateway, **and** the built web client
from `packages/web/dist`. It reads that directory at boot, so after rebuilding
the web client you must restart the server to pick it up.

Working on the web client alone is faster with Vite's dev server:

```sh
cd packages/web && pnpm dev
```

The pnpm workspace is `packages/*` plus `apps/desktop` (the Electron shell,
see [apps/desktop/README.md](apps/desktop/README.md)) — `apps/macos` and
`apps/ios` are native projects outside it, built by their own toolchains.

| Package | Build output |
|---|---|
| `@flow/shared` | `dist/` — types and Zod schemas both the server and web import. **Build this first;** a stale `dist` here surfaces as `SyntaxError: does not provide an export named …` when the server boots. |
| `@flow/server` | `dist/` — TypeScript plus a copy of `src/db/migrations/*.sql` |
| `@flow/web` | `dist/` — typechecked (`tsc --noEmit`) then bundled by Vite |
| `flow-agent-bridge` | `dist/` — the published npm package |

---

## Server + web client

**The web client has no release of its own — it ships inside the server
deploy.** `pnpm -r build` writes `packages/web/dist`, and the running server
serves it.

Production is Railway, connected to `freeflow-community/flow`, so pushing to `main`
builds and ships. The contract is in [`railway.json`](railway.json): Railpack,
build `pnpm -r build`, start `node packages/server/dist/index.js`, gated on
`/healthz`.

```sh
git push origin main
railway deployment list --service app --json   # poll until SUCCESS
curl https://app.freeflow.im/healthz           # → {"ok":true}
```

Database migrations are additive `.sql` files in
`packages/server/src/db/migrations/` and apply at boot — shipping a migration is
just deploying.

Runbooks, environment variables, logs, rollback: **[docs/ops/DEPLOYMENT.md](docs/ops/DEPLOYMENT.md)**.

**The Slack connector is a second Railway service, `slack-connector`, in the
same project.** It also deploys from `main`, with its build, start and healthcheck
(`/health`) set on the service in Railway (config files are deprecated there),
a volume at `/data`, and only when files under `packages/slack-connector/` or
`packages/shared/` change. Public origin
`https://slack.freeflow.im`. Secrets, origins and the Slack app setup:
[docs/dev/SLACK_CONNECTOR.md](docs/dev/SLACK_CONNECTOR.md).

---

## macOS app

### Build

```sh
cd apps/macos
swift run Flow              # run straight from source
tools/make-app.sh           # package dist/Flow.app (needed for flow:// links and notifications)
```

`FLOW_SERVER_URL` is **baked into the bundle** at build time:

```sh
FLOW_SERVER_URL=http://127.0.0.1:8787 tools/make-app.sh   # local-server build
```

Unset, it defaults to `https://app.freeflow.im`. Check that the variable is not
exported in your shell before cutting a release build — a value left over from a
QA session ships an app pointed at localhost.

Sessions and caches are namespaced per server and per `FLOW_PROFILE`, so builds
against different servers coexist on one Mac without interfering.

### Release

One command, from the repo root, on a clean `main` that matches origin:

```sh
apps/macos/tools/release-macos.sh              # patch bump  (2.2.24 -> 2.2.25)
apps/macos/tools/release-macos.sh --minor      # 2.2.24 -> 2.3.0
apps/macos/tools/release-macos.sh 2.5.0        # explicit
apps/macos/tools/release-macos.sh --dry-run    # show the plan, build nothing
```

**Releasing is a separate act from merging, and the version comes from the live
appcast — not from a file in the repo.** The script reads
`https://app.freeflow.im/download/mac/appcast.xml` to learn what is actually
published, adds one, prints the commits since the last tag, asks you to confirm,
then runs the full chain via `publish-dmg.sh --build`: release build, sign,
notarize, staple, DMG, signed Sparkle appcast, and the uploads to R2. On success
— and only then — it tags the commit `macos-v<version>` and pushes the tag.

That ordering is the point. A `macos-v*` tag always means "this exact commit is
live", never "someone tried". It is also the only thing that records *which
commit* a release contains; `apps/macos/VERSION` never did.

Four things to know:

- **Don't bump `apps/macos/VERSION` in a PR.** It is now just a fallback for
  local `make-app.sh` builds. The release version arrives through
  `FLOW_APP_VERSION`, which `make-app.sh` already prefers.
- **`CFBundleVersion` is untouched** — still `git rev-list --count HEAD`, which
  is derived and monotonic. Sparkle orders updates by it.
- **Run it in a terminal you can see.** The appcast is signed with an EdDSA key
  in the login keychain, which can raise a GUI prompt (`-25320` if unanswered).
  `--yes` skips the confirmation but cannot answer a keychain prompt.
- **One-time credentials:** a Developer ID Application certificate, a
  `flow-notary` notarytool profile, `dmgbuild` importable by the `python3` on
  PATH, and R2 keys in the repo-root `.env`. Setup is in
  [docs/specs/phase14.md](docs/specs/phase14.md) §2.

**The Sparkle EdDSA private key lives in one login keychain on one Mac.** If
that machine is lost, no future appcast can be signed and every installed copy
stops receiving updates permanently. Keep a backup of that key somewhere safe.

`publish-dmg.sh --build` still works on its own if you need to re-upload without
cutting a version. It just won't tag, and it will reuse whatever version is in
`VERSION` — which is why `release-macos.sh` is the normal path.

`.github/workflows/dist-macos.yml` mirrors this in CI, but it is
`workflow_dispatch` only and **has never been run** — every release so far has
been cut locally. Treat it as untested.

Signing, notarization, the DMG install window, the Sparkle feed layout:
[docs/ops/DEPLOYMENT.md](docs/ops/DEPLOYMENT.md) §§ *macOS app download* and
*macOS auto-update*.

---

## iOS app

The Xcode project is generated, not committed:

```sh
cd apps/ios
xcodegen generate           # creates FlowiOS.xcodeproj
open FlowiOS.xcodeproj      # then ⌘R
```

Headless simulator build:

```sh
xcodebuild -project FlowiOS.xcodeproj -scheme Flow \
  -sdk iphonesimulator -destination 'platform=iOS Simulator,name=iPhone 17 Pro' \
  -derivedDataPath .build CODE_SIGNING_ALLOWED=NO build
```

### Release (TestFlight / App Store)

One command, from the repo root:

```sh
apps/ios/tools/release-ios.sh              # archive + upload
apps/ios/tools/release-ios.sh --dry-run    # print the plan, build nothing
apps/ios/tools/release-ios.sh 412          # explicit build number (escape hatch)
```

Signing team is `RP5QYMYA4Z`, bundle id `im.freeflow.app` — both live in
`project.yml` so they survive `xcodegen generate`.

**The build number is derived, not authored.** The script uses
`git rev-list --count HEAD` and passes it to `xcodebuild` as a command-line
build setting, which outranks the project and reaches both the app and its
share extension — they must match or the archive is rejected. This is the same
mechanism `apps/macos/tools/make-app.sh` already uses for the macOS
`CFBundleVersion`. `CURRENT_PROJECT_VERSION` in `project.yml` is a fallback for
local Xcode builds; **do not bump it per upload.**

Why: bumping a number in the repo records an intention, not a fact. Builds 23,
24, 25, 26 and 28 were all uploaded while their bump commits sat on unmerged
branches, so `main` claimed 23 when App Store Connect already held 28. Each
drift ended in a rejected upload or a bookkeeping PR that would have moved
`main` *backwards*. A number in the repo cannot see the server that owns it;
the commit count can only go up. If App Store Connect still rejects the number,
the script bumps and retries.

The script tags `ios-build-<n>` **after** a successful upload, so a tag always
means "this commit is on App Store Connect" and names the commit — which no
version file ever did.

The archive needs **Node on `PATH`**: a "Bundle FEATURES.md" build phase runs
`scripts/build-features.mjs` and copies the result into the app, so the
"What's new" screen ships the notes of that exact build. The phase fails the
build with a clear message if it can't find `node`.

The export step signs with an auto-provisioned Apple Distribution
cert/profile and **uploads straight to App Store Connect** (that's the
`destination: upload` in `ExportOptions.plist`); the build lands in TestFlight
after a few minutes of processing. Auth rides the Apple ID session in Xcode →
Settings → Accounts, so the machine must be signed into the team. Export
compliance is pre-answered (`ITSAppUsesNonExemptEncryption` in the plist).
First-time account setup (device registration, app record) is in
[apps/ios/README.md](apps/ios/README.md).

Simulator, device install, signing, and server selection:
[docs/design/IOS.md](docs/design/IOS.md).

---

## Android app

The web client in a Capacitor shell — `apps/android` (route and phasing in
[docs/design/ANDROID.md](docs/design/ANDROID.md); the seam is the desktop
client's, [docs/specs/desktop-electron.md](docs/specs/desktop-electron.md)).
The Gradle project is committed; the web bundle is synced into it at build
time, and the server it talks to is baked into the shell, not the bundle:

```sh
pnpm --filter @flow/web build
pnpm --filter @flow/android apk:debug            # -PflowServerUrl=… to target another server
# → apps/android/android/app/build/outputs/apk/debug/app-debug.apk
```

Needs JDK 21 + Android SDK 36 (`ANDROID_HOME`); `pnpm -r build` deliberately
does not. `.github/workflows/android.yml` builds a debug APK artifact for PRs
touching `apps/android/**`, `packages/web/**` or `packages/shared/**`. No Play
listing or release script yet (ANDROID.md phase 6); nothing ships
automatically. Details: [apps/android/README.md](apps/android/README.md).

---

## Marketing site (freeflow.im)

The landing page in `flowlandingpage/` is a standalone Next.js project — **not
part of the pnpm workspace** — built as a fully static export (`out/`) and
served by Cloudflare Pages at `freeflow.im` (canonical apex; `www` redirects).

```sh
cd flowlandingpage
pnpm install --ignore-workspace   # the flag matters; keeps its lockfile local
pnpm dev                          # local preview
pnpm build                        # static export → out/
```

[`.github/workflows/deploy-landing.yml`](.github/workflows/deploy-landing.yml)
fires on any push to `main` touching `flowlandingpage/**` and deploys `out/` to
the Cloudflare Pages project `freeflow-landing`. So releasing is just merging.

One-time Cloudflare setup (already done for prod): Pages project
`freeflow-landing`; custom domains `freeflow.im` and `www.freeflow.im`; a
redirect rule sending `www` → apex (301); repo secrets `CLOUDFLARE_API_TOKEN`
(Cloudflare Pages: Edit) and `CLOUDFLARE_ACCOUNT_ID`.

```sh
gh run list --workflow deploy-landing.yml   # check a deploy
```

---

## flow-agent-bridge (npm)

**It publishes itself. Never run `npm publish` by hand.**

[`.github/workflows/publish-bridge.yml`](.github/workflows/publish-bridge.yml)
fires on any push to `main` touching `packages/agent-bridge/**` and publishes
via npm trusted publishing (OIDC — no tokens, no OTP), skipping if the version
in `package.json` is already on the registry.

So releasing is: **bump the version in the same PR as the change**, and merging
ships it.

```sh
gh run list --workflow publish-bridge.yml   # check a release
```

---

## Open gaps

- **iOS releases are manual and local.** TestFlight uploads work (see above)
  but there's no CI lane, and the App Store listing (screenshots, privacy
  policy, review) hasn't been submitted yet.
- **`dist-macos.yml` is unproven.** It exists and is wired for secrets, but has
  never executed, so the macOS release remains a local, single-machine
  operation.
- **No version tags.** The repo has no git tags; released builds are traceable
  only through `apps/macos/VERSION` plus the commit count baked in as
  `CFBundleVersion`.
