# Flow to AWS: the cut-over runbook

Phase 1.5 of the FreeFlow suite (`docs/specs/flow-to-aws.md`, `docs/specs/freeflow-suite.md` §3.4). The Flow
server moves from Railway onto the AWS stack that already hosts the Workspace app
(`packages/docs/deploy/aws/template.yaml`, stack `mcpdocs`, us-west-2): one Graviton instance, Caddy for HTTPS,
the data volume at `/data`, images in ECR, deploys through Systems Manager. Postgres 17 and NATS 2.10 run as
containers on the same instance; Postgres's data is at `/data/postgres`, so the volume's daily snapshots cover it.

This is done by hand, by an operator with AWS, Railway, Cloudflare DNS and GitHub admin access. Nothing here has
been run against production; the PR that added it verified the image and the scripts locally only (see the end).

Read the whole page before starting. Steps 1 to 4 can be done days ahead and change nothing users see (except a
few minutes' restart of the docs app in step 2). Step 6 is the cut-over window; plan 30 to 60 minutes. Do it on a
different day from phase 2 (`freeflow-suite.md` §8).

## What you need

- AWS CLI **v2** (v1 fetches the contents of any parameter value that starts with `https://`, which breaks
  `put-parameter` for `FLOW_WEB_URL`), with the Session Manager plugin, signed in to the account with the stack.
- The Railway CLI linked to the `flow` project (`railway link --project flow`), `gh` with admin on
  `freeflow-im/flow`, and the Cloudflare `freeflow.im` zone.
- The source database. `docs/ops/DEPLOYMENT.md` says Flow's database is **Neon Postgres 17** (project `flow-usw`,
  direct endpoint), not a Railway Postgres; whatever `DATABASE_URL` is on Railway's `app` service is the source.
  The box runs Postgres 17 so the restore is never a downgrade. If Neon has an IP allow list, add the instance's
  address for the window.

Shell on the instance is Session Manager, as root:

```sh
aws ssm start-session --region us-west-2 --target <InstanceId>
sudo -i
```

The stack outputs (`InstanceId`, `PublicIp`, `FlowRepositoryUri`, `DeployRoleArn`) come from
`aws cloudformation describe-stacks --region us-west-2 --stack-name mcpdocs --query 'Stacks[0].Outputs'`.

## 1. The parameters under `/flow/`

`deploy.sh flow` reads every SecureString under `/flow/` into the container's environment, named for its
variable, on every deploy. Create them before the stack update, so the box can start Postgres as soon as it has
the new scripts.

```sh
put() { aws ssm put-parameter --region us-west-2 --type SecureString --overwrite --name "/flow/$1" --value "$2" >/dev/null; }
```

**New, for the box:**

| Parameter | Value |
|---|---|
| `/flow/POSTGRES_PASSWORD` | `openssl rand -hex 32`. Hex on purpose: `deploy.sh` puts it into `DATABASE_URL` as it is. It is set when `/data/postgres` is first created; changing the parameter later does not change the database's password (`ALTER USER flow PASSWORD '…'` in `docker exec -it postgres psql -U flow` first, then the parameter, then `deploy.sh flow`). |

**Copied from Railway's `app` service** (`railway variables --service app --environment production --kv`, one `NAME=value` line each; a value that spans lines, such as a PEM key, must be set by hand). Copy the value exactly;
do not retype it.

| Parameter | Where the value comes from |
|---|---|
| `/flow/FLOW_DATA_KEY` | Railway, **byte for byte**. See the warning below. |
| `/flow/FLOW_WEB_URL` | Railway (`https://app.freeflow.im`), unchanged. It names the public host, which is Railway until the DNS switch, so emailed links keep pointing at the live site during the rehearsal. |
| `/flow/FLOW_EMAIL_DRIVER` | `cloudflare` on Railway. **`dev` until the switch** (step 6), so a rehearsal on a copy of the data sends no mail. |
| `/flow/CLOUDFLARE_ACCOUNT_ID`, `/flow/CLOUDFLARE_API_KEY` | Railway (Cloudflare Email Service). |
| `/flow/FLOW_EMAIL_FROM` | Railway (`noreply@mail.freeflow.im`); `/flow/FLOW_EMAIL_FROM_NAME` too if Railway has it. |
| `/flow/FLOW_BLOB_DRIVER` | `r2`. |
| `/flow/CLOUDFLARE_S3_ENDPOINT`, `/flow/FLOW_R2_BUCKET` | Railway. Same bucket; its CORS policy names `https://app.freeflow.im`, which does not change. |
| `/flow/CLOUDFLARE_ACCESS_KEY_ID`, `/flow/CLOUDFLARE_SECRET_ACCESS_KEY` | Railway's pair at the switch. **Until then, a read-only pair**: a new R2 API token with *Object Read only* on this bucket. The daily orphan-file sweep deletes blobs of rows it thinks are unattached, and on a stale copy of the database that could include a file production attached after the dump; a read-only token makes those deletes fail harmlessly. |
| `/flow/FLOW_PUSH_DRIVER` | `apns` on Railway. **`dev` until the switch**, so the copy pushes nothing to real phones (its outbox and its scheduled messages would). |
| `/flow/FLOW_APNS_KEY`, `/flow/FLOW_APNS_KEY_ID`, `/flow/FLOW_APNS_TEAM_ID`, `/flow/FLOW_APNS_ENV` | Railway. `FLOW_APNS_KEY` must be the base64 form (one line). `/flow/FLOW_APNS_TOPIC` and `/flow/FLOW_PUSH_BODY_PREVIEW` only if Railway sets them. |
| `/flow/GOOGLE_CLIENT_ID`, `/flow/APPLE_BUNDLE_ID` | Railway. `/flow/GOOGLE_CLIENT_SECRET` and `/flow/FLOW_GOOGLE_REQUIRE_HD` only if Railway sets them. The Google client's JavaScript origin is `https://app.freeflow.im`, unchanged. |
| `/flow/LIVEKIT_API_KEY`, `/flow/LIVEKIT_API_SECRET`, `/flow/LIVEKIT_URL` | Railway (LiveKit Cloud, unchanged). |
| `/flow/FLOW_ALLOWED_WEB_ORIGINS`, `/flow/FLOW_HANDOFF_RETURN_URLS` | Railway, if set (the desktop app's origin and the handoff return URLs). |
| anything else Railway's `app` service sets | Copy it, except the list below: `FLOW_REDIRECT_FROM_HOSTS` (see step 6), `FLOW_SERVER_NAME`, `FLOW_REGISTRATION_ENABLED`, `FLOW_MAX_FILE_MB`, `INVITE_URL_BASE`, `LOG_LEVEL`, `FLOW_UNFURL_*`, `FLOW_BUS_PREFIX` are all read by the server (`packages/server/src/config.ts`). |

**Not copied** (the box or the image sets them): `DATABASE_URL` (the `postgres` container), `NATS_URL`
(`nats://nats:4222`), `HOST` and `PORT` (`0.0.0.0:8787`; Railway's `HOST=::` would be overridden anyway),
`NODE_ENV`, `FLOW_FILE_DIR` (`/data/files` in the image, on `/data/flow`), `FLOW_MIGRATE_BLOBS` (done long ago),
`ELECTRON_SKIP_BINARY_DOWNLOAD` and any `RAILWAY_*`. Setting `/flow/DATABASE_URL` or `/flow/NATS_URL` makes the
container use those instead of the box's: that is the RDS path later, and a mistake now.

A script for the bulk of it, from the file of `NAME=value` lines exported from Railway (keep the file in a private
temporary directory and delete it afterwards; it holds every secret). Run it with bash; without `--apply` it only
prints what it would do. It skips what the box sets, `FLOW_REDIRECT_FROM_HOSTS` (step 6), Railway's own and any
`VITE_*` leftovers, sets the two rehearsal drivers to `dev`, and leaves the R2 key pair for you to set by hand to
the read-only token (both undone in step 6):

```sh
cat > put-flow-params.sh <<'EOF'
#!/bin/bash
set -euo pipefail
file=${1:?railway.env}; apply=${2:-}
skip='^(DATABASE_URL|NATS_URL|HOST|PORT|NODE_ENV|FLOW_FILE_DIR|FLOW_MIGRATE_BLOBS|ELECTRON_SKIP_BINARY_DOWNLOAD|FLOW_REDIRECT_FROM_HOSTS|CLOUDFLARE_ACCESS_KEY_ID|CLOUDFLARE_SECRET_ACCESS_KEY|RAILWAY_.*|VITE_.*)$'
put() {
  if [ "$apply" = --apply ]; then
    aws ssm put-parameter --region us-west-2 --type SecureString --overwrite --name "/flow/$1" --value "$2" >/dev/null && echo "put /flow/$1"
  else
    echo "would put /flow/$1 (${#2} chars)"
  fi
}
while IFS= read -r line || [ -n "$line" ]; do
  [ -z "$line" ] && continue
  name=${line%%=*}; value=${line#*=}
  if [[ $name =~ $skip ]]; then echo "skip $name"; continue; fi
  case $name in FLOW_EMAIL_DRIVER|FLOW_PUSH_DRIVER) value=dev ;; esac
  put "$name" "$value"
done < "$file"
put POSTGRES_PASSWORD "$(openssl rand -hex 32)"
EOF
bash put-flow-params.sh railway.env            # dry run: read the names
bash put-flow-params.sh railway.env --apply
put CLOUDFLARE_ACCESS_KEY_ID <read-only token's key id>
put CLOUDFLARE_SECRET_ACCESS_KEY <read-only token's secret>
aws ssm get-parameters-by-path --region us-west-2 --path /flow/ --query 'Parameters[].Name' --output text | tr '\t' '\n' | sort
```

> ### ⚠️ `FLOW_DATA_KEY`
> Messages and files are AES-256-GCM encrypted at rest with this key. **If it is lost or mistyped, every message
> and file in the database is permanently unreadable; there is no recovery path.** Copy it from Railway exactly,
> keep the backup copy you already have somewhere other than the server, and check it after the restore (step 5)
> by reading old messages, not just by signing in: sign-in does not need the key.

## 2. Update the stack

The template adds the `flow` ECR repository, the `/flow/app` log group, `/flow*` parameters and the new
repository to the roles, the `FlowDomainName` parameter, and a new UserData (Caddy routing by host, `deploy.sh
docs|flow`, Postgres and NATS, the nightly dump). The deploy role now also trusts `freeflow-im/flow`
(`FlowGitHubRepo`, `FlowGitHubRepoIds`), which is where both deploy workflows run.

Two things to know before running it:

- **The instance is stopped and started** (a new `InstanceType` and UserData are "some interruptions" for
  CloudFormation): the docs app is down for a few minutes. Without an Elastic IP (`UseElasticIp=false`) the
  instance comes back on a **new public address**, and the docs app's A records must be changed at once.
- **Do not let CloudFormation replace the instance.** `LatestAmi` is an SSM parameter type, resolved again on
  every update: if Amazon Linux's latest AMI moved since the stack was made, a plain update would replace the
  instance. Pin it to the running instance's AMI first:

```sh
AMI=$(aws ec2 describe-instances --region us-west-2 --instance-ids <InstanceId> --query 'Reservations[0].Instances[0].ImageId' --output text)
aws ssm put-parameter --region us-west-2 --name /freeflow/instance-ami --type String --data-type aws:ec2:image --value "$AMI" --overwrite
```

Then make a change set and read it before running it:

```sh
aws cloudformation create-change-set --region us-west-2 --stack-name mcpdocs --change-set-name flow-to-aws \
  --template-body file://packages/docs/deploy/aws/template.yaml --capabilities CAPABILITY_NAMED_IAM \
  --parameters \
    ParameterKey=LatestAmi,ParameterValue=/freeflow/instance-ami \
    ParameterKey=InstanceType,ParameterValue=t4g.large \
    ParameterKey=FlowDomainName,ParameterValue=app.freeflow.im \
    ParameterKey=DomainName,UsePreviousValue=true \
    ParameterKey=OtherDomains,ParameterValue=docs.freeflow.im \
    ParameterKey=DataVolumeSizeGiB,UsePreviousValue=true \
    ParameterKey=GitHubRepo,UsePreviousValue=true \
    ParameterKey=GitHubRepoIds,ParameterValue=freeflow-im@309602851/mcp-docs@1431919019 \
    ParameterKey=FlowGitHubRepo,ParameterValue=freeflow-im/flow \
    ParameterKey=FlowGitHubRepoIds,ParameterValue=freeflow-im@309602851/flow@1305888551 \
    ParameterKey=GitHubOidcProviderArn,UsePreviousValue=true \
    ParameterKey=UseElasticIp,ParameterValue=true
aws cloudformation describe-change-set --region us-west-2 --stack-name mcpdocs --change-set-name flow-to-aws \
  --query 'Changes[].ResourceChange.[Action,LogicalResourceId,Replacement,join(`,`,Details[].Target.Name)]' --output table
```

(`OtherDomains` and `GitHubRepoIds` are given, not `UsePreviousValue`: the stack was made before they existed. The
instance has had no Elastic IP so far (`UseElasticIp=false`); since this update restarts it onto a new address
anyway, `true` gives it one address that never changes again, at the cost of moving the docs A records once.)

Expect `Add` for `FlowRepository`, `FlowLogs` and `Address` (the Elastic IP), `Modify` for `InstanceRole` and
`DeployRole`, and `Modify` for `Instance` and `DataAttachment` with `Replacement` **`Conditional`** whose changed
attributes are only `InstanceType` and `UserData`: CloudFormation says "conditional" because those replace an
instance whose root disk is an instance store, and ours is EBS (`aws ec2 describe-instances … --query
'Reservations[0].Instances[0].RootDeviceType'` says `ebs`), so they are a stop and start. If `ImageId` is among
the attributes, `Instance` says `True`, or `DataVolume` appears at all, delete the change set and find out why
before going on. Otherwise:

```sh
aws cloudformation execute-change-set --region us-west-2 --stack-name mcpdocs --change-set-name flow-to-aws
aws cloudformation wait stack-update-complete --region us-west-2 --stack-name mcpdocs
```

The instance is back on the Elastic IP: **change the docs A records** (`mcpdocs` and `docs`, DNS only) to the new
`PublicIp` output now. **UserData runs only on an instance's first boot**, so the instance is back with the old scripts (Docker restarts
the docs app and Caddy by itself). Run the new UserData on it, from a Session Manager shell as root:

```sh
TOKEN=$(curl -sX PUT http://169.254.169.254/latest/api/token -H 'X-aws-ec2-metadata-token-ttl-seconds: 300')
curl -s -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/user-data > /root/user-data.sh
bash /root/user-data.sh
```

It is safe to run again (it formats nothing that has a filesystem and overwrites only its own files). It
rewrites the Caddyfile and reloads Caddy, redeploys the docs app from `latest`, starts Postgres and NATS (the
parameters exist), and tries `deploy.sh flow latest`, which fails until step 4 pushes an image. Check:

```sh
cat /opt/mcpdocs/Caddyfile
docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}'     # app, caddy, postgres, nats
systemctl list-timers flow-pg-backup.timer
curl -s https://mcpdocs.freeflow.im/api/health
```

Caddy now asks for a certificate for `app.freeflow.im`, which fails until the DNS points here; its log says so
every so often. That is expected and costs the docs hosts nothing. Do steps 2 to 6 within a few days so it is not
failing for weeks.

## 3. GitHub

Set the repository variables on `freeflow-im/flow` (the first two may already be there for the docs workflow):

```sh
gh variable set AWS_DEPLOY_ROLE_ARN --repo freeflow-im/flow --body <DeployRoleArn>
gh variable set AWS_INSTANCE_ID --repo freeflow-im/flow --body <InstanceId>
gh variable set AWS_FLOW_ECR_REPOSITORY --repo freeflow-im/flow --body <FlowRepositoryUri>
```

From now on a push to main that touches the server, web or shared packages deploys to **both** Railway and AWS.
That is fine: the AWS copy is not public until the DNS switch, and Railway keeps serving.

## 4. First deploy, on an empty database

```sh
gh workflow run flow-aws-deploy.yml --repo freeflow-im/flow --ref main
gh run watch --repo freeflow-im/flow $(gh run list --repo freeflow-im/flow --workflow flow-aws-deploy.yml --limit 1 --json databaseId --jq '.[0].databaseId')
```

The server boots on an empty Postgres and runs every migration. On the instance:

```sh
docker ps --filter name=flow                       # (healthy)
docker exec flow node -e "fetch('http://127.0.0.1:8787/healthz').then(r => r.text()).then(console.log)"
aws logs tail /flow/app --region us-west-2 --since 10m   # from your machine
```

To use it from a browser before the DNS points here, forward a local port to the container through Session
Manager (no certificate, no DNS, nothing public):

```sh
IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' flow)   # on the instance
aws ssm start-session --region us-west-2 --target <InstanceId> --document-name AWS-StartPortForwardingSessionToRemoteHost \
  --parameters "host=$IP,portNumber=8787,localPortNumber=8787"                        # on your machine
open http://localhost:8787
```

## 5. Rehearsal: a copy of the data

Do this at least once before the real window; it is the same procedure as the final copy and tells you how long
it takes. All on the instance, as root. The box's `postgres` container has the Postgres 17 client tools, so
`pg_dump` runs there and connects out to the source.

```sh
SRC='<Railway app service DATABASE_URL>'     # Neon: the direct endpoint, with sslmode=require
B=/data/backups/postgres

# Dump (custom format: pg_restore can list it, filter it and restore it in one transaction).
docker exec postgres pg_dump -Fc --no-owner --no-privileges -d "$SRC" > $B/railway.dump

# Extensions in the dump. Flow's schema needs only citext (migration 0000), which the box's Postgres has. Anything
# else (Neon adds none to an application database, but check) must exist here or be left out with -L.
docker exec -i postgres pg_restore -l < $B/railway.dump | grep ' EXTENSION '

# Replace the box's database with the copy. Flow must not be running: it would hold connections and write.
docker stop -t 60 flow
docker exec postgres psql -U flow -d postgres -c 'DROP DATABASE flow WITH (FORCE)' -c 'CREATE DATABASE flow OWNER flow'
docker exec -i postgres pg_restore -U flow -d flow --no-owner --no-privileges --exit-on-error --single-transaction < $B/railway.dump
```

`pg_restore` rather than a plain-SQL dump into `psql`: it stops at the first error (`--exit-on-error`) and leaves
nothing behind when it does (`--single-transaction`), `--no-owner --no-privileges` drops Neon's roles and grants
(the box has one role, `flow`, which owns everything), and `-l`/`-L` let you see and edit what is restored. The
nightly dumps on the box are plain SQL, because restoring those is one `psql` command.

Compare exact row counts, table by table:

```sh
cat > $B/counts.sql <<'SQL'
SELECT format('SELECT %L, count(*) FROM public.%I', table_name, table_name)
FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name
\gexec
SQL
docker exec -i postgres psql -At -d "$SRC" < $B/counts.sql > $B/counts.source
docker exec -i postgres psql -At -U flow -d flow < $B/counts.sql > $B/counts.box
diff $B/counts.source $B/counts.box && echo "row counts match ($(wc -l < $B/counts.box) tables)"
```

During a rehearsal Railway keeps writing, so a few busy tables (messages, sessions, presence) may differ by the
writes made between the dump and the count; in the final copy (step 6) they must match exactly.

Start Flow on the copy and check it with the port forward from step 4:

```sh
/opt/mcpdocs/deploy.sh flow latest
```

- Sign in with a real account's password (not an emailed link: the email driver is `dev`, and links name
  `app.freeflow.im`, which is still Railway).
- **Open an old channel and read old messages and attachments' names.** This is the check that `FLOW_DATA_KEY`
  is right; a wrong key signs in fine and shows nothing readable. Images and files load through the read-only R2
  token; uploads fail, as they should.
- Note how long the dump and restore took: that is most of the write-freeze in step 6.

Leave the copy in place; step 6 replaces it.

## 6. The switch

1. **Lower the TTL** of the `app` record in Cloudflare to 60 seconds a day ahead (it is DNS only, grey cloud).
2. **Announce the window** (sign-in and messages stop for its length).
3. **Freeze Railway.** Flow has no read-only mode, so stop its writer: remove the `app` service's active deployment
   in the Railway dashboard (or `railway down --service app`). Railway's project, variables and Neon are not
   otherwise touched, which is what makes the rollback simple. Check that nothing else writes:
   ```sh
   docker exec postgres psql -d "$SRC" -Atc "SELECT usename, application_name, state FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()"
   ```
4. **Final copy:** the dump, the restore and the row counts from step 5, exactly. The counts must match with no
   difference at all.
5. **Real values** for the rehearsal overrides, then deploy:
   ```sh
   put FLOW_EMAIL_DRIVER cloudflare
   put FLOW_PUSH_DRIVER apns
   put CLOUDFLARE_ACCESS_KEY_ID <Railway's>
   put CLOUDFLARE_SECRET_ACCESS_KEY <Railway's>
   ```
   ```sh
   /opt/mcpdocs/deploy.sh flow latest     # on the instance; prints "deployed flow latest"
   ```
   `latest` is the image of main's last Flow deploy, the same commit Railway was running if both deployed the
   last push: compare `docker exec flow printenv GIT_COMMIT_SHA` with `railway deployment list --service app`.
   Migrations newer than the dump apply at boot.
6. **DNS:** in Cloudflare, replace the `app` CNAME (Railway's target) with an **A record to the stack's
   `PublicIp`**, DNS only (grey cloud: Caddy answers the certificate challenge itself, and WebSockets go straight
   to it). Leave `_railway-verify.app` until the retirement.
7. **Certificate:** once `dig +short app.freeflow.im` returns the instance's address, Caddy gets the certificate
   on its next attempt. Watch for it on the instance with `docker logs --since 10m caddy 2>&1 | grep -i
   'app.freeflow.im'` ("certificate obtained successfully"). If it is still backing off from the failures before
   the switch, `docker exec caddy caddy reload --config /etc/caddy/Caddyfile --force` makes it try now (or
   `docker restart caddy`, a two-second blip for the docs hosts too). Clients that resolve the new address before
   the certificate is there see a TLS error for that minute; the low TTL keeps the window short.
8. **Retired host names.** `FLOW_REDIRECT_FROM_HOSTS` only helps for a host name whose DNS points at *this*
   instance; Railway's own `app-production-556c.up.railway.app` keeps pointing at Railway, where nothing runs
   now, so it simply stops answering, which is right (redirecting it from a running Railway service would keep
   `/v1` writes going to the stale database). If an old custom name (such as `app.flowtoo.org`) is still in use,
   point it at the instance too, add it to `FlowDomainName` (a stack update, so a restart) and put it in
   `/flow/FLOW_REDIRECT_FROM_HOSTS`. Otherwise leave the parameter unset.

## 7. Verify

From outside, against the real name:

```sh
curl -s https://app.freeflow.im/healthz                       # {"ok":true}
curl -sI https://app.freeflow.im/ | grep -i '^server'          # Caddy (Railway says railway-edge)
curl -sI https://app.freeflow.im/download/mac/appcast.xml      # 200, or a redirect to R2
curl -sI https://app.freeflow.im/download/mac                  # a redirect to the DMG on R2
```

Then, as people would:

- **Sign in** on the web with a password, with Google, and on iOS with Apple; request a sign-in link by email and
  check that it arrives and names `https://app.freeflow.im`.
- **A message over the socket:** two clients (web and macOS, say) in the same channel; each sees the other's
  message appear without reloading. Old messages read normally (the key, again).
- **A file upload to R2:** attach an image on the web (presigned upload straight to R2, so this also checks the
  bucket's CORS) and open it from another client.
- **A huddle:** start one from one client and join from another. If LiveKit Cloud sends webhooks, their URL names
  `app.freeflow.im`, so they follow the DNS; check `/flow/app` for them.
- **Push:** a message to someone on iOS arrives as a notification.
- **The macOS app's update feed:** Check for Updates in the macOS app finds the current version (the appcast and
  the DMG come from R2 through the server, so nothing moved).
- **Logs:** `aws logs tail /flow/app --region us-west-2 --follow` for errors in the first hour.
- **Backups:** `systemctl start flow-pg-backup.service; ls -l /data/backups/postgres` on the instance makes the
  first nightly dump now.

What only the operator can verify, because it needs production credentials, data or DNS: everything in this
section and in steps 2 to 6. The PR checked the image and the scripts on a laptop: the image builds, boots against
a scratch Postgres and NATS, serves `/healthz` and the web client, signs up and delivers a message over the
socket; `deploy.sh flow` and `deploy.sh <tag>` run end to end against stand-ins for ECR and SSM; the dump,
restore and row-count commands above move a Postgres 16 database into the box's Postgres 17 with identical counts
and readable messages. Not checked: the stack update itself, IAM and the GitHub OIDC trust, the workflow's push to
ECR, the awslogs driver, Caddy's certificate for `app.freeflow.im`, `pg_dump` against Neon, the real data and key,
and R2, LiveKit, APNs and Cloudflare email from the instance's address.

## Rollback

Until the DNS changes, there is nothing to roll back: start Railway's `app` service again if it was stopped.

After the switch, within the window: point the `app` record back at Railway's CNAME target (read it from the
Railway domain settings), redeploy Railway's `app` service, and stop the box's copy (`docker stop -t 60 flow`) so
nothing keeps writing to it. Railway and Neon were not changed, so this is the state before the window. Anything
written on AWS since the switch is not in Neon; decide within the first hour, because after that rolling back
means losing those writes (or dumping them from the box and restoring them into Neon, the same procedure in the
other direction), and rolling forward is cheaper.

## A week later: retire Railway

Once a week has passed with no rollback:

- Delete the Railway project `flow` (the `app` and `nats` services, and `slack-connector` if phase 0.5 left it).
- Neon: take a final dump onto the box (`/data/backups/postgres`, which the snapshots keep for 14 days) and delete
  the `flow-usw` project, or keep it a while longer as a cold copy; the operator's call.
- Remove the `_railway-verify.app` TXT record.
- A follow-up PR: delete `railway.json`; replace Railway in `BUILD.md`, `DEPLOYMENT.md`, `docs/ops/DEPLOYMENT.md`
  (its architecture, variables and DNS sections) and `CLAUDE.md` ("merging to `main` deploys the server + web
  client (Railway)"); drop `RAILWAY_GIT_COMMIT_SHA` from `packages/web/vite.config.ts` (the image passes the
  commit as `BUILD_SHA`).

## Later

RDS is the upgrade path if the database should outlive the instance on its own: set `/flow/DATABASE_URL` to it,
dump and restore as above, and the box's `postgres` container can go.
