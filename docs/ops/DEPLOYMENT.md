# Deployment

Flow runs in production at **https://app.freeflow.im**. This documents what's
deployed where, how to operate it, and what's deliberately not done yet.
First deployed 2026-07-19.

## Architecture

```
Cloudflare DNS (freeflow.im)
  app.freeflow.im  CNAME → <target from Railway>     (DNS only / grey cloud)
        │
        ▼
Railway project "flow"  (36e91a36-9fa2-4881-9988-d81e45c16d6e)
  ├─ app   — Fastify server: REST API + WS gateway + web client (one origin)
  │           volume "app-volume" mounted at /data (encrypted file blobs)
  ├─ nats  — nats:2.10-alpine, private-network only (nats.railway.internal)
  │
  ├──────► Neon Postgres 17 — project "flow-usw" (winter-water-17964134,
  │          aws-us-west-2, direct endpoint ep-lingering-night-afa8f8k5 — not
  │          -pooler), messages AES-256-GCM-encrypted at rest.
  │          Migrated 2026-07-20 from "flow" (weathered-mountain-27798470,
  │          aws-us-east-2): the app runs in Railway sfo, and the cross-country
  │          DB cost ~90ms per query (~1s per message send); us-west-2 halves
  │          it to ~45ms, the practical floor for sfo↔Oregon. Old project
  │          deleted same day after verifying green (operator call).
  └──────► Cloudflare Email Service — transactional sends from
             noreply@mail.freeflow.im (signup, reset, account notes)
```

- Railway fallback URL: https://app-production-556c.up.railway.app
- The web client is served by the API server (`packages/web/dist`), so API,
  WebSocket, and web are one origin — no CORS.
- Build/start config is versioned in `railway.json` (Railpack, `pnpm -r build`,
  `node packages/server/dist/index.js`, healthcheck `/healthz`).
- Migrations run automatically at server boot (`src/db/migrate.ts`).

## Environment variables (Railway `app` service)

Secrets live only in Railway service variables — never in the repo.

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Neon connection string. Use the **direct** endpoint (`ep-…aws.neon.tech`), not the `-pooler` one — postgres.js uses prepared statements, which break on PgBouncer transaction pooling. Keep `sslmode=require`; drop `channel_binding`. |
| `NATS_URL` | `nats://nats.railway.internal:4222` (private network) |
| `HOST` | `::` (listen on all interfaces; Railway routes over IPv6) |
| `NODE_ENV` | `production` |
| `FLOW_DATA_KEY` | Base64 32-byte encryption key (generated with `openssl rand -base64 32`). **Production-only key, independent of local dev's `.keys/` file. Losing it makes all message/file ciphertext unreadable — treat like a root credential.** |
| `FLOW_EMAIL_DRIVER` | `cloudflare` (real sends; the dev-only `autoVerify` register bypass is inert) |
| `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_KEY` | Email Service REST API credentials |
| `FLOW_EMAIL_FROM` | `noreply@mail.freeflow.im` |
| `FLOW_WEB_URL` | `https://app.freeflow.im` — base URL baked into emailed signup/reset links |
| `FLOW_FILE_DIR` | `/data/files` (on the persistent volume) — only read by the local blob driver and the one-time R2 migration |
| `FLOW_BLOB_DRIVER` | `r2` — file/thumb/avatar blobs in Cloudflare R2, presigned direct upload/download. Unset/`local` = disk under `FLOW_FILE_DIR`. |
| `CLOUDFLARE_S3_ENDPOINT` | `https://<account-id>.r2.cloudflarestorage.com` |
| `CLOUDFLARE_ACCESS_KEY_ID` / `CLOUDFLARE_SECRET_ACCESS_KEY` | R2 S3-API token pair |
| `FLOW_R2_BUCKET` | Bucket name (default `flow-files`). **One-time bucket setup**: create the bucket, then set a CORS policy — browsers preflight the presigned PUTs and CORS-check the 302'd GETs, so without it web uploads/downloads fail while native clients work fine: `aws s3api put-bucket-cors --bucket flow-files --endpoint-url $CLOUDFLARE_S3_ENDPOINT --cors-configuration '{"CORSRules":[{"AllowedOrigins":["https://app.freeflow.im","app://flow","http://127.0.0.1:8787","http://localhost:8787","http://127.0.0.1:5173","http://localhost:5173"],"AllowedMethods":["GET","PUT","HEAD"],"AllowedHeaders":["content-type","range"],"ExposeHeaders":["content-length","content-type","content-range","etag"],"MaxAgeSeconds":3600}]}'` (propagates in ~1 min; the S3 endpoint's TLS itself provisions ~1 min after the first bucket exists). `app://flow` is the desktop app's origin (`docs/specs/desktop-electron.md`): without it, desktop uploads fail with "Failed to fetch" while everything else works. Read the live policy first with `get-bucket-cors` so you extend it rather than replace it. |
| `FLOW_MIGRATE_BLOBS` | Set to `1` for ONE deploy to run the volume→R2 decrypt-and-copy at boot (idempotent; watch logs for `blob migration to R2 finished`), then remove. |
| `GOOGLE_CLIENT_ID` | OAuth 2.0 **Web** client id — enables Sign in with Google (phase 16) and is the `aud` we require on ID tokens. Unset = the button is hidden everywhere and `/v1/auth/google` returns `503 google_disabled`; nothing else changes. **One-time Google Cloud setup**: APIs & Services → Credentials → *Create OAuth client ID* → Web application, with **Authorized JavaScript origins** `https://app.freeflow.im` (plus `http://localhost:5173` / `http://127.0.0.1:8787` for local dev). No redirect URI is needed — we use the ID-token flow. Not a secret: the id ships in the page. |
| `GOOGLE_CLIENT_SECRET` | Unused today (the ID-token flow needs no exchange). Only required if we ever adopt the auth-code flow to get Google refresh tokens. |
| `APPLE_BUNDLE_ID` | The iOS app's bundle id (`im.freeflow.app`) — enables Sign in with Apple (native iOS flow) and is the `aud` we require on Apple identity tokens. Unset = the button is hidden on iOS and `/v1/auth/apple` returns `503 apple_disabled`; nothing else changes. No secret and no Apple developer-portal server config needed — verification is pure JWKS (`https://appleid.apple.com/auth/keys`); the App ID just needs the Sign in with Apple capability, which rides the app's entitlements. |
| `FLOW_GOOGLE_REQUIRE_HD` | Defaults on. Set to `0` to let an org on a custom domain *without* Google Workspace turn on domain self-registration (the consumer-domain denylist still applies). See decision_log 2026-07-24. |
| `FLOW_REDIRECT_FROM_HOSTS` | Retirement window for a re-domained hostname (phase17 §13). Comma-separated; unset = off. Set to `app.flowtoo.org` to 302 the old host onto `FLOW_WEB_URL` while its DNS still points here, then remove it when the records are dropped. `/v1` and `/api` are exempt by design — a 302 replays a POST as a GET and `/v1/ws` can't follow one, so old native clients keep working rather than going silently quiet. `/download/*` *is* redirected: that's how installed Mac apps reach the new appcast. Chosen over a Cloudflare redirect rule so the old hostname stays DNS-only and Railway keeps renewing its cert. |
| `FLOW_PUSH_DRIVER` | `apns` — real iOS push over HTTP/2 to Apple. Unset/`dev` writes each push as a `simctl`-ready JSON file under `FLOW_PUSH_OUTBOX` and delivers nothing, which is right for local QA and wrong for production. Selecting `apns` without the three credentials below fails at boot rather than falling back. |
| `FLOW_APNS_KEY` | Base64 of the `.p8` APNs Auth Key (`base64 -i AuthKey_XXXXXXXXXX.p8`). One key per Apple Developer team, reusable across apps — **treat like a root credential**; anyone holding it can push to every app on the team. A raw PEM is accepted too, for the paste that skipped the base64 step. |
| `FLOW_APNS_KEY_ID` | The 10-char key id that names the `.p8` above (the `XXXXXXXXXX` in its filename). Rides in the provider JWT's `kid`. |
| `FLOW_APNS_TEAM_ID` | Apple Developer team id — the provider JWT's `iss`. |
| `FLOW_APNS_TOPIC` | APNs topic = the app's bundle id; defaults to `im.freeflow.app`. A device that registered under a different bundle id wins over this. |
| `FLOW_APNS_ENV` | `production` (set) or `sandbox`. **Fallback only — the per-device `environment` column wins**, so a TestFlight build (which uses *production* APNs) and a locally signed development build can both be live against this server at once. Getting this wrong is the classic first-deploy silence: pushes are accepted by the wrong host and simply never arrive. |
| `FLOW_FCM_SERVICE_ACCOUNT` | Android push (ANDROID.md phase 3): the Firebase service-account key — a path to the JSON, the JSON itself, or its base64. Set = `android` device rows are sent through FCM HTTP v1; unset = the dev driver writes them to `FLOW_PUSH_OUTBOX` like an unconfigured iOS. One key per Firebase project; it can send as the app to every registered device, so treat it like `FLOW_APNS_KEY`. The app's own `google-services.json` (not secret) must come from the same project. |
| `FLOW_PUSH_BODY_PREVIEW` | Defaults on: the message text rides in the push (operator ruling, decision_log 2026-09-01). Set to `0` to send who-messaged-you with no body, so no plaintext reaches Apple. |

## Operations

Everything below assumes the Railway CLI is logged in and the repo directory
is linked (`railway link --project flow`).

Deploys are automatic: the `app` service is connected to
`freeflow-community/flow`, so **pushing to `main` builds and ships** (Railpack →
`/healthz` gate). Watch it with `railway deployment list`. Use `railway up`
only to deploy an unpushed working tree (hotfix/experiment) — it snapshots the
local directory and bypasses git.

```sh
# normal path: just push — Railway builds the new HEAD on push to main
git push origin main
railway deployment list --service app --json   # poll until SUCCESS

# manual override: deploy the current working tree without pushing
railway up --service app --detach -m "what changed"

# logs / status
railway logs --service app --lines 200
curl https://app.freeflow.im/healthz           # → {"ok":true}

# env vars
railway variable list --service app --json
railway variable set KEY=value --service app
```

Database access: `psql` with the `DATABASE_URL` from Railway variables, or the
Neon console/MCP (project `weathered-mountain-27798470`). Migrations are
additive `.sql` files in `packages/server/src/db/migrations/` — they apply at
boot, so shipping a migration is just deploying.

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

Two records in the Cloudflare `freeflow.im` zone, both required:

| Type | Name | Value |
|---|---|---|
| CNAME | `app` | the target shown in the domain's Railway settings — **DNS only** (grey cloud) |
| TXT | `_railway-verify.app` | `railway-verify=<token from the domain's Railway settings>` |

Read both values out of Railway at the time you create the record rather than
copying them from here: the previous version of this doc recorded two different
CNAME targets in two places, and at least one of them was stale.

Hard-won lesson: the CNAME + certificate are **not sufficient** — Railway's
edge refuses to route the hostname (404 "Application not found", even with a
valid cert) until domain ownership is verified via the TXT record. The token
is in the custom domain's status (dashboard, or GraphQL
`customDomain.status.verificationToken`). If the custom domain is ever deleted
and re-added, the CNAME target changes — re-check both records.

Railway issues and renews the TLS cert; the Cloudflare proxy must stay off
unless the zone's SSL mode is set to Full and you accept Railway's proxy
caveats. If a cert sticks in `VALIDATING_OWNERSHIP`, force it with the
`customDomainIssueCertificate` GraphQL mutation.

Email DNS (`mail.freeflow.im` sending domain) was configured in Cloudflare's
Email Service onboarding, separately from this record.

## Production vs local

| | Local dev | Production |
|---|---|---|
| DB | docker Postgres :5442 | Neon (TLS) |
| Email | dev driver → `.emails/` outbox + console link | Cloudflare, real sends |
| `autoVerify` register bypass (QA scripts, macOS dev) | works | ignored by design |
| Blobs | `packages/server/.files/` (disk driver, server-proxied uploads) | Cloudflare R2 `flow-files` (presigned direct up/download; volume `/data/files` legacy) |
| Data key | `.keys/data.key.json` (auto-created) | `FLOW_DATA_KEY` env |
| Web URL in emails | `http://127.0.0.1:8787` | `https://app.freeflow.im` |

The production DB starts empty — no QA fixtures. First registered user
bootstraps their own workspace.

## Known gaps / next steps

- ~~No GitHub auto-deploy~~ — done: the `app` service is connected to
  `freeflow-community/flow` and ships on push to `main`. `railway up` remains the
  manual working-tree override (see Operations).
- ~~macOS app targets localhost~~ — done: packaged apps default to
  `https://app.freeflow.im` (`FlowServerURL` in Info.plist via make-app.sh;
  `FLOW_SERVER_URL` env overrides; bare `swift run` still defaults local).
  Per-server storage isolation keeps prod/dev sessions and caches separate.
- ~~Blobs on volume, not R2~~ — done: `FLOW_BLOB_DRIVER=r2` stores blobs in
  Cloudflare R2 with presigned direct upload/download (see decision_log
  2026-07-20). After a verified `FLOW_MIGRATE_BLOBS=1` run, the `/data`
  volume is only a rollback safety net and can be dropped.
- **No monitoring/alerting**; Neon free tier keeps ~6 h of point-in-time
  history. Revisit backups before real data accumulates.
- Single app instance. Multi-node was scoped in phase 4 (NATS is already the
  event bus), but nothing forces it yet.
