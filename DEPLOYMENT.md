# Self-hosting Flow

Flow is designed to be cheap and boring to run: **one Node process**, a
**Postgres** database, and a **NATS** server. The web client is built to static
files and served by that same Node process, so the API, the WebSocket gateway,
and the web app all live on one origin — no CORS, no second web server, no
Electron, nothing to orchestrate.

This guide gets you from a clean machine to a working instance. If you just
want an account without running anything, use the hosted service at
<https://app.freeflow.im>.

> Licensing: Flow is free to use and free to host under the
> [FSL-1.1-ALv2](LICENSE.md). Read it before offering Flow commercially.

---

## 1. What you're deploying

```
                    ┌──────────────────────────────┐
   browser  ──────► │  Flow server (Node ≥ 22)     │
   macOS/iOS app ─► │  REST + WebSocket + web app  │
                    │  one process, one port       │
                    └───────┬──────────────┬───────┘
                            │              │
                     ┌──────▼─────┐  ┌─────▼──────┐
                     │ Postgres 16│  │ NATS 2.10  │
                     │ (your data)│  │ (events)   │
                     └────────────┘  └────────────┘
                                     file blobs → local disk
                                                  or S3/R2
```

Both dependencies are required. Postgres holds everything durable (messages
are encrypted at rest); NATS fans real-time events out to connected clients and
the server refuses to boot without it.

## 2. Requirements

| | |
|---|---|
| Node | 22 or newer |
| pnpm | 10 (`corepack enable && corepack prepare pnpm@10 --activate`) |
| Postgres | 16 or newer |
| NATS | 2.10 (core NATS — JetStream is not used) |
| Disk | only if you keep file uploads on local disk (see §6) |

## 3. Quick start (single machine)

Start the two dependencies. The repo ships a compose file that runs both:

```sh
git clone https://github.com/freeflow-im/flow.git
cd flow
cd packages/infra && docker compose up -d && cd ../..
```

That gives you Postgres on host port **5442** and NATS on **4222**. (Port 5442
rather than 5432 so it won't collide with a Postgres you already run.) If you
have your own Postgres and NATS, skip this and point `DATABASE_URL` /
`NATS_URL` at them instead.

Install, build, and run:

```sh
pnpm install
pnpm build                        # builds shared, server, and the web client

cd packages/server
pnpm start                        # → http://127.0.0.1:8787
```

Open <http://127.0.0.1:8787>. **Database migrations run automatically at every
boot** — there is no separate migrate step to remember, and shipping a schema
change is just restarting the server.

Health check for your process supervisor or load balancer:

```sh
curl http://127.0.0.1:8787/healthz     # → {"ok":true}
```

## 4. Configuration

Everything is environment variables. The server also reads a `.env` file at the
repo root if one exists — real environment variables always win over it.

**The defaults are tuned for local development.** For a real deployment you
need at least the four variables in the first block.

### Required for a real deployment

| Variable | Set it to |
|---|---|
| `DATABASE_URL` | Your Postgres connection string. Defaults to the docker-compose database. |
| `HOST` | `0.0.0.0` (or `::` for IPv6). **The default is `127.0.0.1`, which only accepts connections from the same machine** — this is the most common reason a fresh deployment appears unreachable. |
| `FLOW_WEB_URL` | The public URL users reach you at, e.g. `https://chat.example.com`. This is baked into signup and password-reset links, so if it's wrong those emails point at the wrong host. |
| `FLOW_DATA_KEY` | Base64 32-byte key: `openssl rand -base64 32`. See the warning below. |

> ### ⚠️ About `FLOW_DATA_KEY`
> Messages and files are AES-256-GCM encrypted at rest with this key. **If you
> lose it, every message and file in your database is permanently unreadable —
> there is no recovery path.** Back it up somewhere other than the server, and
> treat it like a root credential.
>
> If you leave it unset the server generates one on first boot and writes it to
> `packages/server/.keys/data.key.json` (mode 600). That's fine for a laptop,
> but it means the key lives on the same disk as everything else — set the
> variable explicitly for anything you care about.

### Commonly useful

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8787` | Port to listen on |
| `NATS_URL` | `nats://127.0.0.1:4222` | NATS server |
| `LOG_LEVEL` | pino default | `debug`, `info`, `warn`, … |
| `FLOW_MAX_FILE_MB` | `500` | Upload cap (direct-to-object-storage path only) |
| `INVITE_URL_BASE` | `flow://invite/` | Prefix for invite links. The default deep-links into the native app; set it to `https://your-host/invite/` if your users are on the web. |
| `FLOW_REDIRECT_FROM_HOSTS` | empty (off) | Comma-separated hostnames to 302 onto `FLOW_WEB_URL`. Use this when you change domains and the old hostname still points at this server — browsers and installed apps migrate themselves before you drop the DNS. `/v1` and `/api` are exempt on purpose: a 302 turns a POST into a GET and a WebSocket upgrade can't follow one, so old clients keep working on the old hostname until it goes away. |

### Email

| Variable | Default | Purpose |
|---|---|---|
| `FLOW_EMAIL_DRIVER` | `dev` | `dev` writes each email to `packages/server/.emails/*.json` and logs the link. `cloudflare` sends for real. |
| `FLOW_EMAIL_FROM` | `noreply@mail.freeflow.im` | Sending address — change this |
| `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_KEY` | — | Required when the driver is `cloudflare` |

Cloudflare Email Service is the only real sending driver implemented today. If
you use a different provider you'll need to add a driver — it's a small
interface (`send({to, subject, text})`) in `packages/server/src/email/index.ts`,
deliberately kept to one method so adding SES/Postmark/SMTP is a contained
change. See §5 for how to bootstrap without any email at all.

### Push notifications (iOS)

| Variable | Default | Purpose |
|---|---|---|
| `FLOW_PUSH_DRIVER` | `dev` | `dev` writes each push to `packages/server/.push/*.json` and logs it. `apns` sends for real — not implemented yet. |
| `FLOW_APNS_KEY` | — | base64 of the `.p8` APNs Auth Key |
| `FLOW_APNS_KEY_ID` | — | 10-char key id naming that `.p8` |
| `FLOW_APNS_TEAM_ID` | — | Apple Developer team id |
| `FLOW_APNS_TOPIC` | `im.freeflow.app` | APNs topic — the app's bundle id. A device that registered under a different bundle id wins over this. |
| `FLOW_APNS_ENV` | `sandbox` | Fallback APNs environment; the per-device `environment` wins over it. TestFlight builds are `production`. |

The dev driver's files are exactly what `xcrun simctl push <device> <file>`
takes, so you can replay any push into a simulator without an Apple account.

### Sign in with Google (optional)

| Variable | Purpose |
|---|---|
| `GOOGLE_CLIENT_ID` | OAuth 2.0 **Web** client id. Unset = the Google button is hidden everywhere and nothing else changes. |
| `FLOW_GOOGLE_REQUIRE_HD` | Defaults on. Set `0` if your org has a custom domain but no Google Workspace. |

In Google Cloud → APIs & Services → Credentials, create a **Web application**
OAuth client with your public URL as an authorized JavaScript origin. No
redirect URI is needed — Flow uses the ID-token flow.

## 5. Creating the first account

Registration is email-first by design: you enter an address, and the account is
only created by whoever clicks the emailed link. That means **a brand-new
instance with no working email still needs that link** to bootstrap its first
user.

With the default `dev` email driver you don't need a mail provider — the link
is written to disk and printed to the log:

```sh
# after submitting your address in the web UI:
tail -f packages/server/.emails/*.json
# or just watch the server output for:
#   [email:dev] to=you@example.com subject="Finish creating your Flow account" link=https://...
```

Paste that link into your browser to set your name and password. The first
user to register creates their own workspace; the database ships empty with no
fixtures or seed data.

Once you're in, switch `FLOW_EMAIL_DRIVER` to `cloudflare` (or your own driver)
so everyone else can sign up normally — the dev driver never sends anything and
leaves plaintext signup links on disk, so don't leave it on in production.

## 6. File storage

Uploads are encrypted before storage either way. Pick a driver:

**Local disk** (default) — blobs go under `FLOW_FILE_DIR`
(`packages/server/.files` by default). Simplest option; make sure it's on
persistent storage and included in your backups. Uploads and downloads are
proxied through the server.

**S3-compatible object storage** — set `FLOW_BLOB_DRIVER=r2`. Clients then
upload and download directly against presigned URLs, so large files never pass
through your server's memory. Built against Cloudflare R2 but it's the plain S3
API.

| Variable | Purpose |
|---|---|
| `FLOW_BLOB_DRIVER` | `r2` to enable object storage; unset/`local` for disk |
| `CLOUDFLARE_S3_ENDPOINT` | `https://<account-id>.r2.cloudflarestorage.com` |
| `CLOUDFLARE_ACCESS_KEY_ID`, `CLOUDFLARE_SECRET_ACCESS_KEY` | S3 API token pair |
| `FLOW_R2_BUCKET` | Bucket name (default `flow-files`) |

**You must set a CORS policy on the bucket.** Browsers preflight the presigned
uploads, so without it web uploads fail while the native apps keep working —
a confusing failure to debug:

```sh
aws s3api put-bucket-cors --bucket flow-files \
  --endpoint-url $CLOUDFLARE_S3_ENDPOINT \
  --cors-configuration '{"CORSRules":[{
    "AllowedOrigins":["https://chat.example.com"],
    "AllowedMethods":["GET","PUT","HEAD"],
    "AllowedHeaders":["content-type","range"],
    "ExposeHeaders":["content-length","content-type","content-range","etag"],
    "MaxAgeSeconds":3600}]}'
```

Already have files on local disk and want to move them? Set
`FLOW_MIGRATE_BLOBS=1` for exactly one boot — it decrypts and copies everything
to object storage (idempotent; watch for `blob migration to R2 finished` in the
log), then remove the variable.

## 7. Putting it on the internet

Terminate TLS at a reverse proxy in front of the Node process. The only thing
Flow needs beyond a normal HTTP proxy is **WebSocket upgrade support on
`/v1/ws`** — without it the app loads but never receives live messages, which
looks like a broken app rather than a proxy misconfiguration.

nginx:

```nginx
server {
    listen 443 ssl;
    server_name chat.example.com;
    # ssl_certificate ... ;

    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Upgrade    $http_upgrade;   # required for /v1/ws
        proxy_set_header Connection "upgrade";
        proxy_set_header Host       $host;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 3600s;                    # don't cut idle sockets
    }
}
```

Caddy needs no WebSocket configuration at all:

```
chat.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

Run the server itself under systemd, Docker, or whatever supervisor you already
use — it's a plain `node packages/server/dist/index.js`, it exits non-zero on
fatal errors, and it shuts down cleanly on SIGTERM.

### As a Docker image

[`packages/server/deploy/aws/Dockerfile`](packages/server/deploy/aws/Dockerfile)
builds the server and the web client into one image (run
`docker build -f packages/server/deploy/aws/Dockerfile .` from the repository
root). It listens on `0.0.0.0:8787`, runs as an unprivileged user, has a
`HEALTHCHECK` on `/healthz` and needs the variables from §4, with
`DATABASE_URL` and `NATS_URL` pointing at your Postgres and NATS.

The hosted instance at app.freeflow.im no longer runs this image: since
2026-11-03 it is the Cloudflare Worker in `packages/edge` ([BUILD.md](BUILD.md)).
The image still runs on one AWS instance, with Postgres and NATS as containers
beside it and Caddy in front, as the origin behind the Worker that serves the
legacy ChatGPT plugin:
[`packages/docs/deploy/aws/template.yaml`](packages/docs/deploy/aws/template.yaml)
and its README.

## 8. Native clients

The macOS app is built pointing at a server URL, so a self-hosted instance needs
its own build:

```sh
cd apps/macos
FLOW_SERVER_URL=https://chat.example.com tools/make-app.sh   # → dist/Flow.app
```

Sessions and caches are isolated per server, so a Mac can run a build for your
instance alongside one for the hosted service without them interfering.

Currently the iOS app is pinned to the standard server. We are working on making
the server URL configurable so that you can use the app with your custom instance.

## 9. Upgrading

```sh
git pull
pnpm install
pnpm build
# restart the server — migrations apply automatically on boot
```

Migrations are additive `.sql` files in
`packages/server/src/db/migrations/`. Read [CHANGELOG.md](CHANGELOG.md) before
upgrading; anything needing operator action is called out there.

## 10. Backups and what to keep

Three things, and you need all three to restore:

1. **The Postgres database** — every message, channel, and account.
2. **`FLOW_DATA_KEY`** — without it a database backup restores to unreadable
   ciphertext. Store it separately from the database dump.
3. **File blobs** — `FLOW_FILE_DIR` on disk, or your bucket.

## Reference

- [`docs/ops/DEPLOYMENT.md`](docs/ops/DEPLOYMENT.md) — the runbook for the
  hosted instance at app.freeflow.im. Specific to our infrastructure, but a
  worked example of a real production setup: DNS, certificates, and the
  gotchas we hit along the way.
- [`packages/server/src/config.ts`](packages/server/src/config.ts) — the
  authoritative list of every setting and its default.
- [CONTRIBUTING.md](CONTRIBUTING.md) — running Flow for development rather than
  for real use.

Stuck? Open an [issue](https://github.com/freeflow-im/flow/issues) or ask in
[Discussions](https://github.com/freeflow-im/flow/discussions).
