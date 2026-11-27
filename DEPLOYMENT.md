# Deploying FreeFlow on Cloudflare

FreeFlow runs on Cloudflare. The whole suite is **one Worker**, `packages/edge`. Each app (Chat, Docs,
Mail, Calendar, Contacts, Meet, the assistant and the rest) is a Durable Object inside it with its own
SQLite storage. Files are in R2, and the web clients are the Worker's static assets. There is no
database server and no message bus to run.

This guide takes you from a Cloudflare account to a running instance on your own domain. If you only
want an account, use the hosted service at <https://app.freeflow.im>. If you only want to try the code,
`pnpm dev:suite` runs the same Worker on your machine ([BUILD.md](BUILD.md) § Local development).

> **Read this first.** `packages/edge/wrangler.toml` is the configuration of our own deploy. Its routes,
> hostnames and several of its settings name `freeflow.im`. Section 3 lists what you must change. We
> deploy from that file on every merge, but we have not yet run these steps on a second, empty
> Cloudflare account, so expect to adjust something.

> Licensing: FreeFlow is free to use and free to host under the [FSL-1.1-ALv2](LICENSE.md). Read it
> before you offer FreeFlow commercially.

---

## 1. What you are deploying

```
your zone on Cloudflare (records proxied)
  app.example.com ─→ Worker
      ├─ Durable Objects   Directory (accounts and organizations), Org (Chat), Docs, Mail,
      │                    Calendar, Contacts, Events, Assistant, AppStore, MeetingAgent
      ├─ Static assets     every web client's build, at /chat, /docs, /mail, /calendar, …
      ├─ R2                files and attachments
      ├─ Queues            wake jobs, account provisioning
      ├─ Container         OCR for scanned PDFs (optional)
      └─ Images, Browser   thumbnails and link previews, PDF export
```

Each Durable Object applies its own schema migrations when it starts. A deploy is one command and needs
no migration step.

## 2. Requirements

- A Cloudflare account on the **Workers Paid** plan. Durable Objects with SQLite storage, Queues, the
  dynamic Worker loader (custom apps) and Containers (PDF OCR) need it.
- A domain whose DNS is on Cloudflare.
- Node 22 or later and pnpm 10.
- Docker, only if you keep the PDF OCR container (section 3).

## 3. Change the configuration to yours

Edit `packages/edge/wrangler.toml`. Every setting has a comment there that explains it.

**The Worker and its hosts**

| Setting | Ours | Set it to |
|---|---|---|
| `name` | `freeflow-edge` | any name |
| `routes` | `app.freeflow.im`, `edge.freeflow.im`, the two plugin hosts, `*.flowtoo.org` | one entry: `{ pattern = "app.example.com", custom_domain = true }` |
| `ASSET_HOSTS` | `app.freeflow.im,edge.freeflow.im` | your host |
| `PORTED_HOSTS` | `edge.freeflow.im,app.freeflow.im` | your host |
| `WEB_URL_BASE`, `FLOW_WEB_URL` | `https://app.freeflow.im` | `https://app.example.com` |
| `FLOW_HANDOFF_RETURN_URLS` | `flow://signin,https://app.freeflow.im/` | the same, with your host |
| `PLUGIN_HOSTS` | the ChatGPT plugin's hosts | remove it |
| `ORIGIN_URL` | `https://origin.freeflow.im` | see "The origin" below |

**Parts you can leave out at first**

| Part | In `wrangler.toml` | Without it |
|---|---|---|
| Hosted mail | `MAIL_PROVIDER`, `MXROUTE_SERVER` | Remove both. People still connect their own mail accounts; nobody gets a hosted mailbox. |
| Meet and huddles | `RTK_ACCOUNT_ID`, `RTK_APP_ID` | Remove both, or set your own RealtimeKit app and the `RTK_API_TOKEN` secret. Without the token Meet is off. |
| Custom apps' screens | `APPS_DOMAIN`, the `*.flowtoo.org` route | Remove both, or use a second domain of your own with a proxied wildcard record. Apps' screens need a domain apart from the suite's. |
| PDF OCR | the `[[containers]]` block and the `PDF_OCR` binding | Remove them and Docker is not needed. PDFs that have a text layer still import. |

**The origin.** `ORIGIN_URL` is our older Node server on AWS. The Worker sends it any path it does not
answer itself, and today that is only the ChatGPT plugin and a few old pages. A new instance has no
origin. Local development points `ORIGIN_URL` at a dead port and the suite works, so do the same:
set it to an address that answers nothing. A path the Worker does not know then fails instead of
reaching our server.

## 4. Create the resources

From `packages/edge`, after `pnpm exec wrangler login`:

```sh
pnpm exec wrangler r2 bucket create flow-files
pnpm exec wrangler queues create flow-jobs
pnpm exec wrangler queues create flow-jobs-dlq
pnpm exec wrangler queues create flow-provisioning
pnpm exec wrangler queues create flow-provisioning-dlq
```

Use another bucket name if you like, and change `bucket_name` under `[[r2_buckets]]` to match.
The Durable Objects need no step: the `[[migrations]]` blocks create them on the first deploy.

## 5. Set the secrets

Each one is `pnpm exec wrangler secret put <NAME>` in `packages/edge`.

**Required**

| Secret | What it is |
|---|---|
| `FLOW_DATA_KEY` | Seals Chat's messages and files, and the passwords of connected mail and calendar accounts. Make it once with `openssl rand -base64 32` (as local development does) and **keep a copy**: with a different key the stored data cannot be read. |

**Email that the suite sends** (sign-in codes, invitations). Without these, each link is written to
the Worker's log instead of being sent, which is enough for a first sign-in (`wrangler tail`).

| Secret | What it is |
|---|---|
| `EMAIL_API_TOKEN` | A Cloudflare API token with Email Sending: Edit |
| `CLOUDFLARE_ACCOUNT_ID` | Your account id |
| `EMAIL_FROM` | The sender address, on a domain set up for Email Sending |
| `INVITE_URL_BASE` | The address invitation links start with, `https://app.example.com` |

**Direct file uploads and downloads** (presigned R2 addresses)

| Secret | What it is |
|---|---|
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | An R2 API token for the bucket |
| `R2_ENDPOINT` | `https://<account id>.r2.cloudflarestorage.com` |
| `R2_BUCKET` | The bucket's name |

The browser sends and fetches files straight from R2, so the bucket also needs a CORS policy that
allows your host. [docs/design/STORAGE.md](docs/design/STORAGE.md) explains it.

**Optional**

| Secret | Turns on |
|---|---|
| `ANTHROPIC_API_KEY` | The built-in assistant model. `OPENAI_API_KEY` and `OPENROUTER_API_KEY` add the other providers. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Sign in with Google, and Google Calendar |
| `APPLE_AUDIENCE` | Sign in with Apple from the native apps |
| `RTK_API_TOKEN` | Meet and huddles (Cloudflare RealtimeKit) |
| `FLOW_PUSH_DRIVER`, `FLOW_APNS_KEY`, `FLOW_APNS_KEY_ID`, `FLOW_APNS_TEAM_ID` | Push notifications to the iOS app |
| `MXROUTE_USERNAME`, `MXROUTE_API_KEY` | Hosted mail on MXRoute |
| `CLOUDFLARE_DNS_TOKEN`, `CLOUDFLARE_DNS_ZONE_ID` | DNS records for each organization's own host |

`EDGE_ORIGIN_SECRET` is only for an origin, so a new instance does not need a real value.

`packages/edge/scripts/put-secrets.sh` copies our secrets from AWS Parameter Store. It is for our own
deploy and is of no use on another account.

## 6. Build and deploy

From the repository root:

```sh
pnpm install
pnpm --filter @flow/shared build      # the app manifests, which the next steps read
pnpm dev:suite --build                # builds every web client and fills public/; stop it once it has started
cd packages/edge
pnpm exec wrangler deploy
```

`dev:suite --build` is the simplest way to build every client for its own path (`/chat`, `/docs`,
`/mail` and so on). It then runs `packages/edge/scripts/assemble.mjs`, which copies the builds into
`packages/edge/public/`. A client that has no build is left out, and its path then answers "not
built into this deploy".

`wrangler deploy` uploads the Worker and its assets, creates the custom domain and its DNS record, and
builds the OCR container if you kept it.

Check it:

```sh
curl https://app.example.com/edge/health        # {"ok":true}
```

## 7. The first account

Open `https://app.example.com/signup`. Sign-up is confirmed by email. If you have not set up email
yet, run `pnpm exec wrangler tail` in `packages/edge` and take the link from the log. Then make
your organization and invite the others from it.

## 8. Deploying on every merge

Our deploy is GitHub Actions: a merge to `main` runs `flow-aws-deploy.yml`, which builds the clients
and calls `deploy-edge.yml` to run `wrangler deploy`. Those workflows also deploy our AWS origin and
copy files from its image, so they will not run unchanged in a fork.

For your own pipeline, run the commands of section 6 with two secrets set in the environment:

- `CLOUDFLARE_API_TOKEN`: a token with Workers Scripts: Edit and Workers Routes: Edit, plus DNS: Edit
  and Zone: Read on your zone. Add the account's Containers: Edit if you kept PDF OCR.
- `CLOUDFLARE_ACCOUNT_ID`

Build the clients with `pnpm -r build` there instead of `dev:suite --build`, with each client's
`BASE_PATH` set as `scripts/dev-suite.mjs` sets it.

## 9. Operating it

All from `packages/edge`:

```sh
pnpm exec wrangler tail                # live logs
pnpm exec wrangler deployments list    # what is deployed
pnpm exec wrangler rollback            # back to the previous version
pnpm exec wrangler queues list         # look for messages in the -dlq queues
```

Stored logs are in the Cloudflare dashboard under Workers & Pages › your Worker › Logs
(`[observability]` is on in `wrangler.toml`).

**Upgrading.** Pull, build and deploy again (section 6). Durable Objects migrate themselves on their
first request after the deploy.

**Rollback.** `wrangler rollback` puts the previous code back. It does not undo a storage migration
that the newer version already applied.

**What to keep safe**

- `FLOW_DATA_KEY`. Losing it loses the sealed data.
- The R2 bucket. It holds every uploaded file.
- The Durable Objects' storage is kept by Cloudflare. There is no dump command for the whole
  instance today, so plan backups around what each app can export.

## 10. Native clients

The macOS and iOS apps are built and released apart from the suite, and a merge does not ship them.
[BUILD.md](BUILD.md) has the commands. `GET /download/mac` serves the Mac app from the R2 key
`downloads/Flow.dmg`, and the app's update feed is under `downloads/mac/`.

## Reference

- [BUILD.md](BUILD.md): every artifact, how it is built and how it is released.
- [docs/ops/DEPLOYMENT.md](docs/ops/DEPLOYMENT.md): the operator's notes for our own production,
  including the AWS origin.
- [docs/specs/cloudflare-migration.md](docs/specs/cloudflare-migration.md): how the suite moved to the
  Worker, and what is still on the origin.
- `packages/edge/wrangler.toml`: every binding and setting, each with its explanation.
