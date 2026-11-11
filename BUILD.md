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
| Server + web client | `pnpm build` | `git push origin main` | **Yes** — Railway builds every push to `main`; during the move to AWS, `flow-aws-deploy.yml` deploys it there too |
| macOS app | `apps/macos/tools/make-app.sh` | `apps/macos/tools/release-macos.sh` | No — run locally, needs signing credentials |
| iOS app | `xcodegen generate` + Xcode | `apps/ios/tools/release-ios.sh` | No — run locally, needs the signing account |
| `flow-agent-bridge` (npm) | `pnpm --filter flow-agent-bridge build` | bump `version`, merge to `main` | **Yes** — GitHub Actions publishes |
| Flow marketing site (`flowlandingpage/`) | `pnpm build` (in `flowlandingpage/`) | merge to `main` | **Yes** — GitHub Actions deploys to Cloudflare Pages |
| Home page (`freeflowhome/`) | `pnpm build` (in `freeflowhome/`) | merge to `main` | **Yes** — GitHub Actions deploys to Cloudflare Pages |
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

Prerequisites: Node 22+, pnpm 10, and — for the native clients — macOS 14+
with Xcode 26. Docker is only needed for the [origin stack](#the-origin-stack).

**The backend is one process.** Every app of the suite — Chat, Docs, Mail,
Calendar, Contacts, Admin, and the directory, assistant and event bus behind
them — lives in the Cloudflare Worker in `packages/edge`, each as a Durable
Object. `wrangler dev` runs all of them locally in one process, with local
SQLite storage under `packages/edge/.wrangler/`. No Postgres, no NATS, no Node
server.

### The whole suite on one URL

```sh
pnpm install
pnpm dev:suite --build        # first time: builds every client, then starts
pnpm dev:suite                # after that: starts from the existing builds
```

That is http://localhost:8787 — Chat at `/chat`, Docs at `/docs`, Mail at
`/mail`, Calendar at `/calendar`, Contacts at `/contacts`, Admin at `/admin`,
the same shape as production. `scripts/dev-suite.mjs` builds each client for
its manifest's base path (`BASE_PATH`, as the server image does), fills
`packages/edge/public/` with `scripts/assemble.mjs`, writes
`packages/edge/.dev.vars` with a fresh `FLOW_DATA_KEY` the first time, and
starts the Worker with production's hostname vars set to `localhost`.

Things to know:

- **Sign-up and sign-in links are printed to the terminal**, not emailed.
  Register at `/chat`, then copy the link from the Worker's log.
- **A client's build is a snapshot.** After editing a client, rebuild it:
  `pnpm dev:suite --build=mail` (the package name's last part), or `--build`
  for all of them. For hot reload, see the next section.
- **Editing the Worker** (`packages/edge/src`) reloads it. If a change seems
  not to take, restart: its hot reload has served a stale bundle before.
- **Keep `.dev.vars`.** The Worker's local data is sealed with its
  `FLOW_DATA_KEY`; a new key makes the old mail and calendar accounts
  unreadable.
- **PDF OCR is off** (`--enable-containers=false`: it needs Docker). PDFs with
  a text layer still import.
- `--port=<n>` for another port, `--var=KEY:value` for extra Worker vars
  (`wrangler.toml` documents them). A client without a build is left out and
  its path answers "not built into this deploy".

### Hot reload on one client

Run the Worker as above, then that client's Vite dev server beside it; each
proxies `/v1` (and Docs' `/api`) to the Worker on 8787:

| Client | Command | Dev URL |
|---|---|---|
| Chat | `cd packages/web && pnpm dev` | http://localhost:5173 |
| Mail | `cd packages/mail && pnpm dev` | http://localhost:5185/mail/ |
| Calendar | `cd packages/calendar && pnpm dev` | http://localhost:5186/calendar/ |
| Contacts | `cd packages/contacts && pnpm dev` | http://localhost:5187/contacts/ |
| Admin | `cd packages/admin && pnpm dev` | http://localhost:5188/admin/ |
| Home | `cd packages/home && pnpm dev` | http://localhost:5189/home/ |
| Docs | `cd packages/docs && DOCS_API=http://127.0.0.1:8787 BASE_PATH=/docs/ pnpm dev:client` | http://localhost:5173/docs/ |

Sign in on the Worker's URL first: the session cookie is per host, so a Vite
dev server on another port sees it only through its proxy. Mail and Calendar
also run with **no backend at all** from a sample mailbox or calendar:
`MAIL_MOCK=1 pnpm dev`, `CALENDAR_MOCK=1 pnpm dev`.

Docs' plain `pnpm dev` is the **standalone** MCP Docs app (its own Fastify
server on 3001 over a folder), not the suite; `DOCS_API` points its client at
the Worker instead. Docs and Chat both default to port 5173, so run one of
them on `PORT=5174`.

### The origin stack

The Node server (`packages/server`) and its Postgres and NATS are the AWS
origin: the Worker proxies to it only the paths it has not ported, and
`cloudflare-migration.md` step 7 retires it. You need it locally only to work
on the server itself:

```sh
cd packages/infra && docker compose up -d   # Postgres on host port 5442, NATS
pnpm build                                  # = pnpm -r build across every package
cd packages/server && pnpm migrate && pnpm dev   # http://127.0.0.1:8787, API + Chat client
```

It serves Chat's built client from `packages/web/dist` and reads that
directory at boot, so after rebuilding the web client restart it. The Worker
and the server both default to port 8787; run one of them elsewhere.

The pnpm workspace is `packages/*` plus `apps/desktop` (the Electron shell,
see [apps/desktop/README.md](apps/desktop/README.md)) — `apps/macos` and
`apps/ios` are native projects outside it, built by their own toolchains.

| Package | Build output |
|---|---|
| `@flow/shared` | `dist/` — types, Zod schemas and the app manifests the Worker, the server, the web clients and the build scripts import. **Build this first;** a stale `dist` here surfaces as `SyntaxError: does not provide an export named …` when the server boots. |
| `@flow/edge` | no output — `wrangler deploy` bundles it; `public/` is assembled from the clients' builds |
| `@flow/server` | `dist/` — TypeScript plus a copy of `src/db/migrations/*.sql` |
| `@flow/web`, `@flow/mail`, `@flow/calendar`, `@flow/contacts`, `@flow/admin`, `@flow/home` | `dist/` — typechecked (`tsc --noEmit`) then bundled by Vite, each for its base path |
| `@flow/docs` | `dist/client/` — the Workspace client; `dist/plugin/` the ChatGPT plugin |
| `flow-agent-bridge` | `dist/` — the published npm package |

---

## Server + web client

**The web client has no release of its own — it ships inside the server
deploy.** `pnpm -r build` writes `packages/web/dist`, and the running server
serves it.

**Production is moving from Railway to AWS** (phase 1.5 of the FreeFlow suite).
The operator does the cut-over by hand with
[docs/ops/FLOW_TO_AWS.md](docs/ops/FLOW_TO_AWS.md); until its DNS step,
`app.freeflow.im` is still Railway.

- **AWS** (the destination): the server's image is
  [`packages/server/deploy/aws/Dockerfile`](packages/server/deploy/aws/Dockerfile),
  built from the repository root, and runs as the `flow` container on the stack
  that hosts the Workspace app
  ([`packages/docs/deploy/aws/template.yaml`](packages/docs/deploy/aws/template.yaml)),
  beside its Postgres and NATS containers, behind Caddy.
  [`flow-aws-deploy.yml`](.github/workflows/flow-aws-deploy.yml) builds and
  pushes the image and runs `deploy.sh flow <sha>` on the instance on a push to
  `main` touching the server, web or shared packages (once the repository
  variable `AWS_FLOW_ECR_REPOSITORY` is set). Logs: CloudWatch `/flow/app`.
- **The clients come from the manifests** (`APP_MANIFESTS` in `packages/shared/src/manifests.ts`):
  the image's build loop, `deploy-edge.yml`'s copy-out and the assembler all read them through
  `packages/edge/scripts/clients.mjs`. Adding an app is a manifest entry plus
  `node packages/edge/scripts/clients.mjs write`, which regenerates the Dockerfile's COPY lines and
  `flow-aws-deploy.yml`'s static `paths:` filter; the edge tests fail until it is run.
- **Railway** (until the cut-over, then retired): connected to
  `freeflow-im/flow`, so pushing to `main` builds and ships. The contract is
  in [`railway.json`](railway.json): Railpack, build `pnpm -r build`, start
  `node packages/server/dist/index.js`, gated on `/healthz`. The runbook's last
  step removes it.

```sh
git push origin main
railway deployment list --service app --json   # poll until SUCCESS
curl https://app.freeflow.im/healthz           # → {"ok":true}
```

Database migrations are additive `.sql` files in
`packages/server/src/db/migrations/` and apply at boot — shipping a migration is
just deploying.

Runbooks, environment variables, logs, rollback: **[docs/ops/DEPLOYMENT.md](docs/ops/DEPLOYMENT.md)**.

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

## Marketing sites (freeflow.im, flow.freeflow.im)

Two standalone Next.js projects — **not part of the pnpm workspace** — each
built as a fully static export (`out/`) and served by Cloudflare Pages:

| Folder | Domain | Pages project | Workflow |
|---|---|---|---|
| `freeflowhome/` | `freeflow.im` (canonical apex; `www` redirects) — lists every Freeflow tool | `freeflow-home` | [`deploy-home.yml`](.github/workflows/deploy-home.yml) |
| `flowlandingpage/` | `flow.freeflow.im` — the Flow page, with Log in / Sign up | `freeflow-landing` | [`deploy-landing.yml`](.github/workflows/deploy-landing.yml) |

```sh
cd freeflowhome                   # or flowlandingpage
pnpm install --ignore-workspace   # the flag matters; keeps its lockfile local
pnpm dev                          # local preview
pnpm build                        # static export → out/
```

Each workflow fires on any push to `main` touching its folder and deploys
`out/`. So releasing is just merging. `deploy-home.yml` creates its Pages
project on the first run if it is missing.

One-time Cloudflare setup: custom domain `flow.freeflow.im` on
`freeflow-landing`; `freeflow.im` and `www.freeflow.im` on `freeflow-home`; a
redirect rule sending `www` → apex (301); repo secrets `CLOUDFLARE_API_TOKEN`
(Cloudflare Pages: Edit) and `CLOUDFLARE_ACCOUNT_ID`. The home page's
`public/_redirects` sends the old `freeflow.im/agents`, `/migrate` and
`/self-host` paths to `flow.freeflow.im`.

```sh
gh run list --workflow deploy-home.yml      # check a home page deploy
gh run list --workflow deploy-landing.yml   # check a Flow page deploy
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

## Workspace app (packages/docs) and MCP Docs (apps/mcp-docs)

The former MCP Docs repository, added as a git subtree for the FreeFlow suite
(`docs/specs/freeflow-suite.md`), split by `docs/specs/docs-core.md`: `packages/docs` is
the engine and the hosted app, `apps/mcp-docs` the standalone desktop app (Electron, the
installer, the plugins) with its own version. Two root workflows carry the deploys:

- The hosted Workspace app ships inside the suite: the server's image (`flow-aws-deploy.yml`)
  for the ChatGPT plugin on AWS, and the Worker (`deploy-edge.yml`) for app.freeflow.im. The
  former `docs-aws-deploy.yml` was removed on 2026-11-03.
- `docs-desktop-release.yml` builds the macOS and Windows apps, makes the GitHub
  release **in this repository** and publishes the installer to npm when a
  `desktop-v<version>` tag is pushed; the tag is made by
  `pnpm --filter @freeflow-im/mcp-docs-app release -- <version>` in `apps/mcp-docs`, after
  writing `release-notes/<version>.md` there. Installed apps check this
  repository's releases for updates (`desktop/updater.js`), as does
  `npx @freeflow-im/mcp-docs`. Both workflows install with pnpm at the repository root.
  **Hand-over from the old repository** (`docs/specs/docs-core.md` §4.1, once): the
  first release made here (0.2.39) must also be published as a release of
  `freeflow-im/mcp-docs` with the same files, so apps on 0.2.38 take one more update
  from there and look here from then on; then that repository is made read-only with a
  README pointing here. Never push code to it again.

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
