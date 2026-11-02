# The hosted Workspace app's image for AWS, built from the repository root (the pnpm workspace, so the lockfile
# is there): `docker build -f packages/docs/deploy/aws/Dockerfile .`. Node from packages/docs/.node-version, git
# for app-change jobs, Chromium for PDFs, and the dev dependencies kept so those jobs can typecheck, test and
# rebuild in the container.
FROM node:24.22.1-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git chromium fonts-liberation ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# The workspace's pnpm, pinned by the root package.json's packageManager field.
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

WORKDIR /app

# Electron is a dev dependency for the desktop app only.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
# Every workspace manifest, so the frozen lockfile matches, then only this package's dependencies.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
COPY packages/agent-bridge/package.json packages/agent-bridge/
COPY packages/docs/package.json packages/docs/
COPY packages/docs/vendor packages/docs/vendor
COPY packages/suite-bar/package.json packages/suite-bar/
COPY apps/desktop/package.json apps/desktop/
RUN pnpm install --frozen-lockfile --filter @flow/docs

COPY packages/docs packages/docs
# The suite bar's sources: the client imports them (it draws the bar only when hosted in the suite).
COPY packages/suite-bar packages/suite-bar
RUN pnpm --filter @flow/docs build

WORKDIR /app/packages/docs

# The commit the image was built from, where an app-change job starts its git checkout (server/agent/worker.ts).
ARG GIT_COMMIT_SHA
ENV GIT_COMMIT_SHA=$GIT_COMMIT_SHA \
  NODE_ENV=production \
  DATA_DIR=/data \
  CHROMIUM_PATH=/usr/bin/chromium \
  HOST=0.0.0.0 \
  PORT=3001

EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD node -e "fetch('http://127.0.0.1:3001/api/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

# The supervisor (what `pnpm start` runs), started directly so it gets the platform's signals.
CMD ["node", "server/supervise.ts"]
