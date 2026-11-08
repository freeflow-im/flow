# Deploy builds the clients from the manifests (platform phase 6.6)

- `[server]` `packages/edge/scripts/clients.mjs` lists the clients from `APP_MANIFESTS`; the server image builds them in a loop over it and `deploy-edge.yml` copies them out of the image the same way, so Contacts now ships.
- `[server]` The Dockerfile's COPY lines and `flow-aws-deploy.yml`'s `paths:` filter are generated blocks (`clients.mjs write`); an edge test fails when they lag the manifests.
