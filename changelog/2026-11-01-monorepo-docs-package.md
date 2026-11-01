# MCP Docs joins the repository as packages/docs

- `[server]` `[web]` The former `freeflow-im/mcp-docs` repository is `packages/docs` (git subtree, history kept), the Workspace app of the FreeFlow suite (`docs/specs/freeflow-suite.md`, phase 1). It is `@flow/docs` in the pnpm workspace: `pnpm -r build` and `pnpm test` now cover it, and CI typechecks it.
- `[qa]` Its deploys are root workflows: `docs-aws-deploy.yml` (the hosted app, on pushes to main touching `packages/docs/**`, once the AWS repository variables are set here) and `docs-desktop-release.yml` (`desktop-v*` tags, still on the package's own npm lockfile). No behaviour changes in either app.
