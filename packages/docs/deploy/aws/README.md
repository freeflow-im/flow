# MCP Docs on AWS

`template.yaml` is a CloudFormation stack (us-west-2) for the hosted app on one EC2 instance: the app's container
(`deploy/aws/Dockerfile`, built from the repository root) behind Caddy, which gets the HTTPS certificate for the domain itself. The data (`/data`:
SQLite, files, Caddy's certificates) is on its own EBS volume, snapshotted daily and kept for 14 days; the volume
is kept if the stack is deleted. Shell access is Session Manager (`aws ssm start-session --target <instance>`),
the app's log is the CloudWatch group `/mcpdocs/app`.

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
   outputs). Each push to main then deploys (`.github/workflows/aws-deploy.yml`); run the workflow by hand for
   the first one.

A changed parameter takes effect on the next deploy, or at once with `/opt/mcpdocs/deploy.sh latest` on the
instance.

App-change jobs (the assistant changing the app) need `GITHUB_TOKEN`; they merge into the same repository's
main, which deploys again.
