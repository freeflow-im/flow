# Deploy: install Meet in the clients build

- [qa] `build-clients.yml` installs `@flow/meet`, so the deploy can build it (the #838 deploy failed on Meet's missing types).
- [qa] The clients artifact uploads `packages/meet/dist`, so the AWS image and the Worker get the Meet app.
