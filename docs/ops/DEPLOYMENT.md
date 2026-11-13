# Deployment

Production runs on **Cloudflare**: the Worker `freeflow-edge` in `packages/edge` serves `app.freeflow.im` (since
2026-11-03, `docs/ops/CUTOVER_TO_CLOUDFLARE.md`). A **legacy AWS instance**, the origin, still runs behind it for the
ChatGPT plugin. Railway was retired on 2026-11-01. How a merge ships is in [BUILD.md](../../BUILD.md); this page is
the operator's side.

## Architecture

```
Cloudflare zone freeflow.im (records proxied, orange cloud)
  app.freeflow.im, edge.freeflow.im ─→ Worker freeflow-edge (PORTED_HOSTS: the Worker answers)
  │   ├─ Durable Objects: Directory (accounts), Org (Chat), Docs, Mail, Calendar, Contacts, Events, Assistant, PdfOcr (a Container)
  │   ├─ R2: files
  │   ├─ Static assets: every web client's build (assembled from the manifests)
  │   └─ a path it does not answer ─→ the origin
  docs.freeflow.im, mcpdocs.freeflow.im ─→ Worker ─→ the origin (PLUGIN_HOSTS: the ChatGPT plugin)
  <slug>.freeflow.im ─→ organizations' own hosts, records written by the Worker

origin.freeflow.im ─→ AWS us-west-2, stack mcpdocs, one EC2 instance (packages/docs/deploy/aws/README.md)
  ├─ caddy     — HTTPS, routes by host
  ├─ flow      — the server image (packages/server/deploy/aws/Dockerfile), with the Workspace app and the plugin
  ├─ app       — MCP Docs (the plugin's hosted app)
  └─ postgres, nats — the server's database and bus
```

The Worker's settings: vars in `packages/edge/wrangler.toml` (each one explained there), secrets with
`pnpm exec wrangler secret put <NAME>` in `packages/edge`, or all of them from the origin's SSM parameters with
`bash scripts/put-secrets.sh` (dry run) and `--apply`. The origin's settings are SSM SecureString parameters,
`/flow/<NAME>` and `/mcpdocs/<NAME>`, read by `deploy.sh` on each deploy.

## Operations

```sh
# normal path: merge to main. flow-aws-deploy.yml deploys the Worker (job edge) and the origin (job deploy).
gh run list --workflow flow-aws-deploy.yml --branch main
gh workflow run deploy-edge.yml        # redeploy the Worker alone, with the clients from the latest image

# the Worker (from packages/edge, after pnpm exec wrangler login)
pnpm exec wrangler tail                # live logs
pnpm exec wrangler deployments list    # what is deployed
pnpm exec wrangler rollback            # back to the previous version

# the origin (Session Manager: aws ssm start-session --target <instance>)
/opt/mcpdocs/deploy.sh flow latest     # rerun its container, e.g. after changing a parameter
# logs: CloudWatch /flow/app and /mcpdocs/app
```

**Rollback.** Roll the Worker back with `wrangler rollback`. Sending `app.freeflow.im` back to the origin (removing it
from `PORTED_HOSTS`) is no longer a rollback: the origin's data stopped at the cut-over, and everything since is in
the Worker's objects.

**Data.** Each organization's data is its Durable Objects' SQLite, which apply their own migrations when they start;
files are in R2.

## macOS app download

The signed-out web page (and the "app not installed?" fallback on the signed-in
CTAs) link to `GET /download/mac`, which 302s to a short-lived presigned URL for
the DMG stored in R2 at key **`downloads/Flow.dmg`**. Publishing a new build is
one command, no code deploy:

```sh
# Cut a release: derive the next version from the live appcast, build,
# notarize, publish, and tag the commit. This is the normal path.
apps/macos/tools/release-macos.sh

# Re-upload at the current version, without cutting a new one.
apps/macos/tools/publish-dmg.sh --build

# Or, if you already ran dist.sh, just upload the current DMG:
apps/macos/tools/publish-dmg.sh
```

`release-macos.sh` wraps `publish-dmg.sh --build` and supplies the version via
`FLOW_APP_VERSION`, so everything below applies to both. See
[BUILD.md](../../BUILD.md) § *macOS app* for why the version comes from the
appcast rather than a file in the repo.

`publish-dmg.sh` reads the R2 creds from repo-root `.env` (the same
`CLOUDFLARE_*` vars the server uses), maps them onto the `AWS_*` names the AWS
CLI actually reads — the CLI ignores `CLOUDFLARE_*`, so a bare `aws s3 cp` picks
up whatever stray AWS key is in your shell and fails with *"access key has
length 20, should be 32"* — and opts out of the CLI v2 default checksums that R2
rejects. `--build` first runs `dist.sh` (needs the Developer ID cert +
`flow-notary` notarytool profile; one-time setup in docs/specs/phase14.md §2 —
plus `pip3 install --user --break-system-packages dmgbuild` for the styled
drag-to-Applications install window).

The DMG opens as a drag-to-install window (Flow → Applications, with an arrow).
That layout is built by `dmgbuild` from `tools/dmg-settings.py` and the
background in `Resources/dmg-background.png` (+`@2x`), regenerated from
`tools/make-dmg-bg.swift` if missing.

Overwriting the key ships the new build immediately — the route always presigns
the current object. Until the key exists the route returns `404 not_found`
(the page's download link just fails to fetch, no crash). The bucket's existing
CORS policy already covers this (same-origin redirect from app.freeflow.im).

## macOS auto-update (Sparkle)

The DMG only reaches *new* downloads. Installed copies update themselves from a
Sparkle appcast published in the same step:

| Object | Route | Purpose |
|---|---|---|
| `downloads/mac/appcast.xml` | `/download/mac/appcast.xml` | the feed the app polls (daily, plus **Check for Updates…** in the app menu) |
| `downloads/mac/Flow-<ver>-<build>.zip` | `/download/mac/Flow-<ver>-<build>.zip` | the archive it installs |

`dist.sh` generates both after stapling; `publish-dmg.sh` uploads archives
first, then the feed (publishing the feed first would announce an update that
404s). Publishing without a feed is a loud warning, not a silent pass — that
build would ship to new downloads only.

**Trust model.** Each archive is signed with an **EdDSA key**; the public half
is baked into every bundle as `SUPublicEDKey` (`tools/sparkle-public-key.txt`,
committed — it's public). The app refuses anything that doesn't verify, so
neither the transport nor the bucket has to be trusted. The **private** half
lives in the login keychain of whoever publishes and never touches disk. Losing
it means no existing install can be updated again: rotating it requires shipping
a new bundle (with the new public key) through the DMG, which only reaches
people who re-download. Guard it accordingly.

**Versions.** `CFBundleVersion` is the commit count (`git rev-list --count
HEAD`) — monotonic, no state to keep — and Sparkle orders updates by it. The
marketing string comes from `apps/macos/VERSION`; bump that for a user-visible
version change. `FlowBuild` (short SHA) stays as the build label in the
workspace menu.

**A keychain prompt blocks the first signing run** on any machine: the tools
need permission to read the key, and a headless run can't answer. Authorize it
once interactively (click *Always Allow*):

```sh
apps/macos/.build/artifacts/sparkle/Sparkle/bin/sign_update apps/macos/dist/updates/*.zip
```

For CI, export the key once and point the release at the file instead:

```sh
apps/macos/.build/artifacts/sparkle/Sparkle/bin/generate_keys -x sparkle-private-key.txt
FLOW_SPARKLE_KEY_FILE=sparkle-private-key.txt apps/macos/tools/dist.sh
```

That file is gitignored and is a credential — treat it like the Developer ID
cert.

**A dev build never offers production updates**: `SUFeedURL` is derived from
whatever `FLOW_SERVER_URL` the bundle was built with, and a build with no public
key (or no bundle at all — `swift run`) leaves the updater inert with the menu
item disabled.

## DNS / domain

All in the Cloudflare `freeflow.im` zone. The Worker's routes are in `packages/edge/wrangler.toml` (`routes`). A route
only takes traffic for a hostname whose record is **proxied** (orange cloud), so a grey record bypasses the Worker.
`edge.freeflow.im` is a custom domain of the Worker. `origin.freeflow.im` points at the AWS instance, which keeps its
own Caddy certificates.

Each organization's `<slug>.freeflow.im` record is written by the Worker (`CLOUDFLARE_DNS_ZONE_ID` and its token in
the Worker's secrets). Email DNS (`mail.freeflow.im` sending domain) was configured in Cloudflare's Email Service
onboarding, separately. Hosted mail domains are MXRoute's (`decision_log.md` 2026-11-08).

## Production vs local

| | Local dev (`pnpm dev:suite`) | Production |
|---|---|---|
| Runs | one Worker on http://localhost:8787 (`wrangler dev`) | Worker `freeflow-edge` |
| Data | SQLite under `packages/edge/.wrangler/` | Durable Objects' SQLite |
| Files | local R2 under `.wrangler/` | Cloudflare R2 |
| Data key | `FLOW_DATA_KEY` in `packages/edge/.dev.vars` (made on first run) | `FLOW_DATA_KEY` Worker secret |
| Email | dev driver: the link is in the Worker's log | real sends |
| Web URL in emails | `http://localhost:8787` | `https://app.freeflow.im` |

## Known gaps / next steps

- **The AWS origin is not retired yet** (step 7 of `docs/specs/cloudflare-migration.md`): it waits for the ChatGPT
  plugin to move.
- **No monitoring or alerting.**
