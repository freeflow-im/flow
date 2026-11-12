# Clients built once; the Worker deploys without waiting for AWS

- `[qa]` New `build-clients.yml` builds every app's client once per commit; `flow-aws-deploy.yml` hands the artifact to the edge Worker's deploy at once and to the server image (`--build-context prebuilt`), so a client change is live on the Worker in minutes instead of after the image and the instance. A push-triggered `deploy-edge` leaves a commit that `flow-aws-deploy` deploys to that run, so old clients are never put back.
