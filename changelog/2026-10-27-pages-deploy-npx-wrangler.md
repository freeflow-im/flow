# Fix marketing site deploys: run wrangler with npx

- [web] `deploy-home.yml` and `deploy-landing.yml` call `npx wrangler pages deploy` instead of `cloudflare/wrangler-action`, which failed trying to `pnpm add wrangler` at the workspace root. Both workflows now also run when their own file changes.
