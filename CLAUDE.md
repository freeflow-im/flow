# Flow — working conventions

- **Every feature or fix PR adds one file to `changelog/`** — named
  `YYYY-MM-DD-short-slug.md`, format in `changelog/README.md`: a `#` title,
  then succinct bullets with platform tags (`[server]` `[web]` `[macos]`
  `[ios]` `[desktop]` `[bridge]` `[qa]`). One file per PR, never edit another PR's file —
  that is what makes concurrent PRs conflict-free. Do NOT append entries to
  CHANGELOG.md; its history is frozen in the `CHANGES_ARCHIVE_*.log` files.
  A shipped change with no entry file fails the QA close-out.
- **Keep entry bullets very succinct** — one or two lines per bullet:
  what changed, and the *why* only when it isn't obvious from the what. No
  narrating the investigation, no restating the diff, no listing every file
  touched. The commit message is where reasoning belongs; the changelog is a
  scannable ledger. If an entry needs more than three lines, that's a sign it
  belongs in the commit body or `decision_log.md` instead.
- **CHANGELOG.md is now only the Parity ledger.** A change that lands on one
  client but not the others MUST add a line to its Parity section (deliberate
  divergence vs gap to close) — that section is the client-sync mechanism and
  should trend toward empty. QA verifies this at phase checkpoints. Parity
  edits are in-place, so keep them small and merge promptly (the file is
  union-merged; if GitHub still shows a conflict, a local
  `git merge origin/main` auto-resolves it — same for `decision_log.md`).
- **FEATURES.md is generated — NEVER edit it by hand.** When a change is
  user-visible, put a friendly note in a `## Feature` section of your
  `changelog/` entry file, written *for users*: no platform tags, file names,
  migrations, or other internals — just what someone can now do or will
  notice. Purely internal changes (refactors, tests, infra, bridge plumbing)
  omit the section. Mention a platform only when the feature is specific to
  it. `scripts/build-features.mjs` builds FEATURES.md (gitignored) from those
  sections on every web predev/prebuild and in `make-app.sh`.
- **Every PR description carries a client-impact checklist.** List all five
  surfaces and tick the ones where someone should see a difference:

  ```
  Visible impact:
  - [ ] web client
  - [ ] macOS client
  - [ ] iOS client
  - [ ] desktop client (Electron)
  - [ ] agent bridge
  ```

  Tick for *visible* impact — behaviour a person or an agent can observe —
  regardless of which layer the change lives in: a server-only change that
  alters what every client renders ticks three boxes, and a refactor behind an
  unchanged surface ticks none. All five unticked is a legitimate answer that
  says "nothing to look at", not "I forgot". The point is that gaps get stated
  rather than inferred: an unticked box a reviewer expected ticked is exactly
  the divergence the CHANGELOG **Parity** section exists to track, and the
  checklist is where it surfaces — while it's still cheap to fix. It also
  tells QA which apps to actually open.
- Key decisions and operator rulings go in `decision_log.md`.
- **`BUILD.md` is the release map** — what each artifact is built and shipped
  by, and which ones ship automatically. Two rules worth knowing without
  opening it: merging to `main` deploys the server + web client (Railway) but
  does **not** release the macOS or iOS app, and shipping macOS is one command,
  `apps/macos/tools/release-macos.sh` (never `dist.sh` + `publish-dmg.sh` as
  separate steps).
- **NEVER bump a native app's version in a feature PR.** Releasing is a
  separate act from merging, and the version belongs to the release, not to
  whoever last touched the code. `release-macos.sh` reads the **live appcast**
  to learn what is actually published, adds one, builds that commit, and tags
  it `macos-v<version>` only after the upload succeeds — so a tag always means
  "this commit is live", and it names the commit, which no version file ever
  did. `apps/macos/VERSION` is now only a fallback for local `make-app.sh`
  builds; leave it alone.
  **iOS works the same way now.** `apps/ios/tools/release-ios.sh` derives the
  build number from `git rev-list --count HEAD`, passes it to `xcodebuild`, and
  tags `ios-build-<n>` after the upload. `CURRENT_PROJECT_VERSION` in
  `apps/ios/project.yml` is a fallback for local Xcode builds — do not bump it
  per upload, and do not open a PR that does.
  (Why the old rule went: bumping in PRs recorded an intention rather than a
  fact, and it failed twice in one day — two PRs bumped to the same 2.2.24 and
  the second merged as a silent no-op, and that release actually carried three
  PRs' worth of code. iOS had the mirror-image failure five times in three
  days: builds 23, 24, 25, 26 and 28 were uploaded while their bumps sat on
  unmerged branches, so `main` claimed 23 when App Store Connect held 28 — and
  the bookkeeping PRs, if merged in the wrong order, would have moved `main`
  backwards into the next collision. A number in the repo cannot see the server
  that owns it.)
- **`flow-agent-bridge` publishes itself.** Never run `npm publish` by hand.
  `.github/workflows/publish-bridge.yml` fires on any push to `main` touching
  `packages/agent-bridge/**` and publishes via npm trusted publishing (OIDC —
  no tokens, no OTP), skipping if `package.json`'s version is already on the
  registry. So releasing is just: bump the version in the same PR as the
  change, and merging ships it. Check a release with
  `gh run list --workflow publish-bridge.yml`.
- Run basics: docker compose in `packages/infra` (postgres on host port 5442),
  `pnpm dev` in `packages/server` (serves API + WS + web dist on 127.0.0.1:8787;
  restart after rebuilding `packages/web/dist`), macOS app via
  `apps/macos/tools/make-app.sh` → `dist/Flow.app`.
- UI automation requires an idle desktop or explicit operator authorization
  (see the QA manual in `.claude/agents/quality-assurance.md`).
- **`packages/docs` is the Workspace app of the FreeFlow suite** (the former
  `freeflow-im/mcp-docs` repository, added as a git subtree on 2026-11-01; design in
  `docs/specs/freeflow-suite.md`). It has its own conventions in
  `packages/docs/CLAUDE.md` and `packages/docs/docs/architecture.md`; read those
  before changing it. It is in the pnpm workspace (`pnpm --filter @flow/docs
    release workflow. The hosted app ships with the suite (`flow-aws-deploy.yml`,
  `deploy-edge.yml`); `docs-desktop-release.yml` builds the `desktop-v*` tags, though
  installed apps still update from freeflow-im/mcp-docs's releases.
