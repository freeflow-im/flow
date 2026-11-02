# The Flow server's image for AWS (packages/docs/deploy/aws/template.yaml runs it as the `flow` container), built
# from the repository root (the pnpm workspace, so the lockfile is there):
#   docker build -f packages/server/deploy/aws/Dockerfile .
# One Node process serving the REST API, the WebSocket gateway and the web client (packages/web/dist) on port 8787;
# migrations run at boot. It needs DATABASE_URL, NATS_URL, FLOW_DATA_KEY and FLOW_WEB_URL (DEPLOYMENT.md §4).
# Node from packages/docs/.node-version, like the Workspace app's image.

# --- Build: shared, web and server with their dev dependencies ----------------------------------------------------
FROM node:24.22.1-bookworm-slim AS build

# The workspace's pnpm, pinned by the root package.json's packageManager field.
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

WORKDIR /app

ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
# Every workspace manifest, so the frozen lockfile matches, then only shared, server and web's dependencies.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
COPY packages/agent-bridge/package.json packages/agent-bridge/
COPY packages/docs/package.json packages/docs/
COPY apps/desktop/package.json apps/desktop/
RUN pnpm install --frozen-lockfile --filter @flow/server... --filter @flow/web...

# The web build reads the changelog (FEATURES.md, through scripts/build-features.mjs) and the agent skill from the
# repository root.
COPY scripts/build-features.mjs scripts/build-features.d.mts scripts/
COPY changelog changelog
COPY .claude/skills/flow-agent-member .claude/skills/flow-agent-member
COPY packages/shared packages/shared
COPY packages/server packages/server
COPY packages/web packages/web

# The build tag the web client shows (vite.config.ts reads BUILD_SHA first; there is no .git in the build context).
ARG GIT_COMMIT_SHA
RUN pnpm --filter @flow/shared build \
  && BUILD_SHA=$(printf '%.7s' "${GIT_COMMIT_SHA:-dev}") pnpm --filter @flow/web build \
  && pnpm --filter @flow/server build

# --- Run: the server's production dependencies and the built output, in the repository's layout --------------------
FROM node:24.22.1-bookworm-slim

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

WORKDIR /app

ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
COPY packages/agent-bridge/package.json packages/agent-bridge/
COPY packages/docs/package.json packages/docs/
COPY apps/desktop/package.json apps/desktop/
RUN pnpm install --frozen-lockfile --prod --filter @flow/server... && pnpm store prune

# What the server reads at run time, at the paths it resolves them from (src/app.ts, src/services/help.ts,
# src/services/agentAvatars.ts): the web client, the help pages, the changelog behind "What's New", the avatars.
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/server/dist packages/server/dist
COPY --from=build /app/packages/web/dist packages/web/dist
COPY --from=build /app/FEATURES.md ./
COPY packages/server/assets packages/server/assets
COPY scripts/build-features.mjs scripts/
COPY changelog changelog
COPY docs/help docs/help

# The server runs as `node`, so what it may write goes under /data (deploy.sh mounts /data/flow there): the local blob
# driver's files (production uses R2) and the dev email and push drivers' outboxes. FLOW_DATA_KEY must be set: the
# fallback key file under packages/server/.keys is not writable here, on purpose, so the server fails at boot rather
# than invent a key.
RUN mkdir -p /data && chown node:node /data

ARG GIT_COMMIT_SHA
ENV GIT_COMMIT_SHA=$GIT_COMMIT_SHA \
  NODE_ENV=production \
  HOST=0.0.0.0 \
  PORT=8787 \
  FLOW_FILE_DIR=/data/files \
  FLOW_EMAIL_OUTBOX=/data/emails \
  FLOW_PUSH_OUTBOX=/data/push

USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

# Started directly (not through pnpm) so the server gets SIGTERM and drains (src/index.ts).
CMD ["node", "packages/server/dist/index.js"]
