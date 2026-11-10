# Flow to AWS: phase 1.5 of the FreeFlow suite

Status: Brief for implementation · 2026-11-01 · from `docs/specs/freeflow-suite.md` §3.4 and §8.
Platforms: server, web (hosting only; no product change).

## Outcome

The Flow server (`packages/server`, serving `packages/web/dist`) runs on the AWS stack that already hosts
the Workspace app (`packages/docs/deploy/aws/template.yaml`): one EC2 Graviton instance, Caddy for HTTPS, an
EBS data volume at `/data`, images in ECR, deploys by a GitHub workflow through Systems Manager. Postgres 16
and NATS 2.10 run as containers on the same instance with Postgres's data on the data volume. Railway is
retired after the cut-over. Everything in this phase ships as code and a runbook; **the cut-over itself (data
move, DNS) is done by the operator following the runbook, not by this PR.**

## What exists

- `packages/docs/deploy/aws/template.yaml` (350 lines): the stack. Read it whole. Its UserData writes
  `/opt/mcpdocs/Caddyfile` and `/opt/mcpdocs/deploy.sh`; `deploy.sh <tag>` pulls the docs image from ECR,
  reads every SSM SecureString under `/mcpdocs/` into `/opt/mcpdocs/app.env`, and runs the `app` container
  on the `mcpdocs` docker network with `/data/app` mounted at `/data`, plus a `caddy` container (2.10.2) with
  `/data/caddy`. The instance role may read `/mcpdocs*` parameters. Parameters: `InstanceType` (default
  `t4g.medium`), `DomainName` (`mcpdocs.freeflow.im`), `OtherDomains` (`docs.freeflow.im`), `UseElasticIp`,
  `GitHubOidcProviderArn`. Outputs: the deploy role ARN, instance id, ECR repository.
- `packages/docs/deploy/aws/README.md`: how the stack is set up and how secrets are added.
- `.github/workflows/docs-aws-deploy.yml`: builds `packages/docs/deploy/aws/Dockerfile` from the repository
  root on `ubuntu-24.04-arm`, pushes to ECR, runs `deploy.sh <sha>` via `aws ssm send-command`. Gated on the
  repository variables `AWS_DEPLOY_ROLE_ARN`, `AWS_INSTANCE_ID`, `AWS_ECR_REPOSITORY`.
- `packages/docs/deploy/aws/Dockerfile`: the pattern for a pnpm-workspace image (copy every manifest, frozen
  install filtered to one package, build, run with Node 24).
- The Flow server today: `DEPLOYMENT.md` (self-hosting: one Node process, Postgres 16+, NATS 2.10, env vars,
  the `FLOW_DATA_KEY` warning), `BUILD.md` ("Server + web client" and Railway), `railway.json` (build
  `pnpm -r --filter '!@flow/desktop' build`, start `node packages/server/dist/index.js`, healthcheck
  `/healthz`). The server serves `packages/web/dist` itself (`packages/server/src/app.ts`), runs migrations
  on boot, listens on `PORT` (8787) and `HOST`, and needs `DATABASE_URL`, `NATS_URL`, `FLOW_DATA_KEY`,
  `FLOW_WEB_URL`, plus the optional groups in `packages/server/src/config.ts` (R2 storage, LiveKit, Cloudflare
  email, Google, Apple, push, `FLOW_ALLOWED_WEB_ORIGINS`, `FLOW_HANDOFF_RETURN_URLS`,
  `FLOW_REDIRECT_FROM_HOSTS`). `/download/mac` and the Sparkle appcast come from R2 through the server, so
  no local files are involved.
- Local verification: `packages/infra/docker-compose.yml` runs Postgres on host port 5442 and NATS on 4222.

## Deliverables

1. **A Flow server image.** `packages/server/deploy/aws/Dockerfile`, built from the repository root like the
   docs one: Node 24 (match `packages/docs/.node-version`), pnpm from corepack, every workspace manifest
   copied, `pnpm install --frozen-lockfile --filter @flow/server... --filter @flow/web...` (shared, server
   and web with their dependencies), build shared, web and server, `node packages/server/dist/index.js`,
   `HEALTHCHECK` on `/healthz`, `HOST=0.0.0.0`, `PORT=8787`. Keep the image to what the server needs at run
   time where that is simple; do not spend the PR on size.
2. **The stack runs both apps.** Extend `template.yaml` (keep it one template; the docs app's behaviour must
   not change):
   - A second ECR repository and output for the Flow image, and the deploy role may push to it.
   - `InstanceType` default `t4g.large` (the box now holds Postgres, NATS and two apps).
   - A `FlowDomainName` parameter (default `app.freeflow.im`) and Caddy routing by host: the docs hosts to
     `app:3001` as now, the Flow host to `flow:8787` (WebSockets pass through Caddy unchanged).
   - Postgres 16 and NATS 2.10 containers started by `deploy.sh` (and on boot) on the same docker network,
     Postgres's data at `/data/postgres`, NATS without JetStream, neither published on a host port. The
     Postgres superuser password is an SSM parameter; `DATABASE_URL` for the Flow container points at the
     `postgres` container by name.
   - `deploy.sh` grows a second argument or a second script: `deploy.sh docs <tag>` and
     `deploy.sh flow <tag>` (pick one shape and document it), each pulling its image, reading its own SSM
     path (`/mcpdocs/` and `/flow/`), and restarting its container with `--stop-timeout` long enough for the
     Flow server's draining. The instance role reads `/flow*` parameters too.
   - A nightly `pg_dump` to `/data/backups/postgres/<date>.sql.gz`, kept 14 days (the EBS snapshots cover the
     volume; the dump is what a restore to a fresh Postgres needs). A cron entry written by UserData is fine.
   - CloudWatch log group `/flow/app` for the Flow container, like `/mcpdocs/app`.
3. **A deploy workflow** `.github/workflows/flow-aws-deploy.yml`: on push to main touching
   `packages/server/**`, `packages/web/**`, `packages/shared/**`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`
   and the workflow; same shape as `docs-aws-deploy.yml` with the Flow repository variable
   (`AWS_FLOW_ECR_REPOSITORY`) and `deploy.sh flow <sha>`. Gated the same way.
4. **The cut-over runbook** `docs/ops/FLOW_TO_AWS.md`, step by step, for the operator: update the stack
   (parameters, the new SSM parameters under `/flow/` listed by name with where each value comes from, Railway's
   variables included; `FLOW_DATA_KEY` copied exactly, with the warning from DEPLOYMENT.md), first deploy of the
   Flow image with `FLOW_WEB_URL` still Railway's, `pg_dump` from Railway's Postgres and restore on the box
   (commands, the `pg_restore`/`psql` choice, the `citext` extension, how to check row counts), the switch:
   put Railway in maintenance or read-only, final dump and restore, DNS `app.freeflow.im` to the instance
   (Caddy gets the certificate; what to check), `FLOW_REDIRECT_FROM_HOSTS` if a Railway hostname should
   redirect, verification (sign-in, a message over the socket, a file upload to R2, a huddle, `/healthz`,
   the macOS app's update feed), rollback (DNS back; Railway was never changed), and the retirement a week
   later (delete the Railway project, remove `railway.json`, update BUILD.md and DEPLOYMENT.md's Railway
   section). Name what cannot be verified without the operator.
5. **Docs.** `BUILD.md` ("Server + web client" and the Railway text), `DEPLOYMENT.md` §7 (Railway) replaced
   by a pointer to the runbook and the stack, `packages/docs/deploy/aws/README.md` (the stack now hosts
   both; secrets under `/flow/` too), a `changelog/2026-11-01-flow-to-aws.md` entry per `changelog/README.md`.
   Leave `railway.json` in place; the runbook's last step removes it.

## Constraints

- **No live changes.** Do not call AWS, Railway, DNS or any production system. Do not install anything
  globally. The operator runs the runbook.
- Verify what can be verified here: `docker build -f packages/server/deploy/aws/Dockerfile .` on this
  machine (arm64) and run the container against the compose Postgres and NATS
  (`DATABASE_URL=postgres://flow:flow_dev@host.docker.internal:5442/flow`,
  `NATS_URL=nats://host.docker.internal:4222`, a fresh `FLOW_DATA_KEY` from `openssl rand -base64 32`,
  `FLOW_WEB_URL=http://127.0.0.1:8787`, a scratch database name so the dev database is untouched) and check
  `/healthz` and that `/` serves the web client. Lint the template with `cfn-lint` only if it is already
  installed; otherwise check it by reading. Run `pnpm -r build` and `pnpm test` before opening the PR (the
  agent-bridge test "falls back to killing the process group" is known to fail under parallel load; rerun
  that file alone if it does).
- Follow `CLAUDE.md` (Flow working conventions): one `changelog/` file, the PR client-impact checklist
  (all five unticked is the honest answer here), key rulings already in `decision_log.md`.
- Work in a separate git worktree, not in `~/flow` (two servers run from there): for example
  `git worktree add ~/flow-aws suite/flow-aws` from `~/flow`, then `pnpm install` there. Commit on
  `suite/flow-aws`, push it, and open the PR against `main` on `freeflow-im/flow` with
  `gh pr create --repo freeflow-im/flow --head suite/flow-aws`. End the commit message and the PR
  description with the attribution lines this session uses (see `git log -3` on main for the form).

## Out of scope

The one-process merge of the two servers (phase 2), the identity merge, the suite bar, moving the docs app's
SQLite to Postgres, RDS. The runbook may note RDS as the later option in one line.
