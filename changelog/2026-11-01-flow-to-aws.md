# Flow server image and AWS deploy, with the Railway cut-over runbook

- `[server]` A Docker image for the server and web client (`packages/server/deploy/aws/Dockerfile`), deployed by
  `flow-aws-deploy.yml` to the Workspace app's AWS stack, which now also runs Flow's Postgres and NATS.
- `[server]` The move from Railway is done by hand with `docs/ops/FLOW_TO_AWS.md`; production stays on Railway
  until its DNS step.
