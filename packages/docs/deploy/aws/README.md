# MCP Docs and Flow on AWS

`template.yaml` is a CloudFormation stack (us-west-2, stack `mcpdocs`) for the FreeFlow suite's hosted apps on one
EC2 instance, behind Caddy, which gets the HTTPS certificate for each host name itself and routes by host:

- **MCP Docs** (the Workspace app): container `app` (`deploy/aws/Dockerfile`), on `DomainName` and `OtherDomains`.
  Its log is the CloudWatch group `/mcpdocs/app`.
- **Flow** (the Chat app): container `flow` (`packages/server/deploy/aws/Dockerfile`), on `FlowDomainName`, with
  `postgres` (Postgres 17, data at `/data/postgres`) and `nats` (NATS 2.10, core only) containers on the same docker
  network, neither published on a host port. Its log is `/flow/app`. A systemd timer dumps the database every night
  at 09:30 UTC to `/data/backups/postgres/<date>.sql.gz` and keeps the newest 14. Moving Flow here from Railway is
  `docs/ops/FLOW_TO_AWS.md`.

Both images are built from the repository root. The data (`/data`: SQLite, files, Postgres and its dumps, Caddy's
certificates) is on its own EBS volume, snapshotted daily and kept for 14 days; the volume is kept if the stack is
deleted. Shell access is Session Manager (`aws ssm start-session --target <instance>`).

`/opt/mcpdocs/deploy.sh` runs one app's image: `deploy.sh docs <tag>` or `deploy.sh flow <tag>` (a bare
`deploy.sh <tag>` is the docs app, the form the first version of the script took), each pulling its image from
its ECR repository, reading its own parameters (`/mcpdocs/` or `/flow/`) and replacing its container; Flow's gets
SIGTERM and a minute to drain. `deploy.sh services` starts only Caddy, Postgres and NATS. Deploys take turns
(a lock), since the two workflows can run at once.

## Set up

1. Create the stack `mcpdocs` from `template.yaml`, with `GitHubOidcProviderArn` set to the account's
   `token.actions.githubusercontent.com` provider.
2. Point the domain's A record at the `PublicIp` output. Caddy gets the certificate once it resolves. With
   `UseElasticIp=false` (the region's Elastic IP quota is full) the address is the instance's own, which changes
   if the instance is stopped and started or replaced; turning it on later gives a new one for the record.
3. Add the app's secrets as SecureString parameters named `/mcpdocs/<VARIABLE>` (see `.env.example`):
   `ANTHROPIC_API_KEY` at least; a mail provider (`RESEND_API_KEY` or the Cloudflare pair, with `MAIL_FROM`) for
   sign-up and password reset emails; `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` for Google sign-in, with
   `https://<domain>/api/auth/google/callback` added to the OAuth client. `APP_URL`, `SECURE_COOKIES`,
   `DATA_DIR` and `GITHUB_REPO` are set by `deploy.sh` and the image. `npm run aws:secret -- <NAME> ...` copies
   variables from the local `.env`.
4. Set the repository variables `AWS_DEPLOY_ROLE_ARN`, `AWS_INSTANCE_ID` and `AWS_ECR_REPOSITORY` (the stack's
   outputs). Since the move into the suite the server's image (`.github/workflows/flow-aws-deploy.yml`) carries
   the Workspace app; the standalone `docs-aws-deploy.yml` was removed on 2026-11-03.
5. Flow's secrets are SecureString parameters named `/flow/<VARIABLE>` (the list, with where each value comes
   from, is in `docs/ops/FLOW_TO_AWS.md`), including `/flow/POSTGRES_PASSWORD` for the box's Postgres
   (`openssl rand -hex 32`); `deploy.sh` sets `DATABASE_URL`, `NATS_URL`, `HOST` and `PORT`. The repository
   variable `AWS_FLOW_ECR_REPOSITORY` (the `FlowRepositoryUri` output) turns on `.github/workflows/flow-aws-deploy.yml`.

A changed parameter takes effect on the next deploy, or at once with `/opt/mcpdocs/deploy.sh docs latest` (or
`flow latest`) on the instance.

**UserData runs only on the instance's first boot.** A stack update that changes it (a new Caddyfile or
`deploy.sh`) stops and starts the instance but leaves the old scripts in place; run the new UserData on the
instance afterwards (it is safe to run again), as `docs/ops/FLOW_TO_AWS.md` step 2 shows. Make a change set
before any update and check that `Instance` is not replaced: `LatestAmi` is resolved again on every update, so pin
it to the running instance's AMI the way that step does.

App-change jobs (the assistant changing the app) need `GITHUB_TOKEN`; they merge into the same repository's
main, which deploys again.
