# One toolchain and one package manager for the workspace

- `[server]` `[web]` `[bridge]` `[desktop]` A pnpm catalog in `pnpm-workspace.yaml` pins TypeScript 7, Vite 8, Vitest 5, `@vitejs/plugin-react` 6, `@types/node` 26 and Electron 44 for every package (the versions `packages/docs` arrived with); web's Tailwind moves to 4.3 for Vite 8. One typing fix in the agent bridge for the stricter worker `error` event.
- `[qa]` `packages/docs` drops its npm lockfile: the desktop release workflow installs with pnpm at the root, its Docker image builds from the repository root with the workspace lockfile (`docs-aws-deploy.yml` context is now `.`, with a root `.dockerignore`), and its scripts say `pnpm`.
