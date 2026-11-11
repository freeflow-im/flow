# The FreeFlow suite's image for AWS (packages/docs/deploy/aws/template.yaml runs it as the `flow` container), built
# from the repository root (the pnpm workspace, so the lockfile is there):
#   docker build -f packages/server/deploy/aws/Dockerfile .
# One Node process serving Flow's REST API, the WebSocket gateway and the web client (packages/web/dist) on port 8787,
# and, when WORKSPACE_DATA_DIR is set, the Workspace app (packages/docs: its API under /api, its client under
# /workspace, the ChatGPT plugin) inside it (packages/server/src/workspace.ts). Migrations run at boot. It needs
# DATABASE_URL, NATS_URL, FLOW_DATA_KEY and FLOW_WEB_URL (DEPLOYMENT.md §4); the Workspace app's own settings are
# listed in docs/ops/DEPLOYMENT.md. Node from packages/docs/.node-version. Chromium is for the Workspace app's PDFs.

# --- Build: shared, the server and every app's client (APP_MANIFESTS) with their dev dependencies (and the suite bar the clients bundle) ---
# The client lists below are generated from the manifests (packages/edge/scripts/clients.mjs write; CI checks them).
FROM node:24.22.1-bookworm-slim AS build

# The workspace's pnpm, pinned by the root package.json's packageManager field.
RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

WORKDIR /app

ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
# Every workspace manifest, so the frozen lockfile matches, then these packages' dependencies.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/agent-bridge/package.json packages/agent-bridge/
COPY packages/docs/vendor packages/docs/vendor
COPY packages/suite-bar/package.json packages/suite-bar/
COPY apps/desktop/package.json apps/desktop/
# clients:manifests begin (node packages/edge/scripts/clients.mjs write)
COPY packages/web/package.json packages/web/
COPY packages/docs/package.json packages/docs/
COPY packages/mail/package.json packages/mail/
COPY packages/calendar/package.json packages/calendar/
COPY packages/home/package.json packages/home/
COPY packages/contacts/package.json packages/contacts/
COPY packages/admin/package.json packages/admin/
# clients:manifests end
# clients:install begin (node packages/edge/scripts/clients.mjs write)
RUN pnpm install --frozen-lockfile --filter @flow/server... --filter @flow/web... --filter @flow/docs... --filter @flow/mail... --filter @flow/calendar... --filter @flow/home... --filter @flow/contacts... --filter @flow/admin...
# clients:install end

# The web build reads the changelog (FEATURES.md, through scripts/build-features.mjs) and the agent skill from the
# repository root.
COPY scripts/build-features.mjs scripts/build-features.d.mts scripts/
COPY changelog changelog
COPY .claude/skills/flow-agent-member .claude/skills/flow-agent-member
COPY packages/shared packages/shared
COPY packages/edge/scripts/clients.mjs packages/edge/scripts/
COPY packages/server packages/server
# The suite bar's sources, bundled into both clients (nothing of it is needed at run time).
COPY packages/suite-bar packages/suite-bar
# Every client's sources. The server serves the web client and the Workspace app's; the others only the edge Worker
# does, from this image's copy (deploy-edge.yml copies the dists out).
# clients:sources begin (node packages/edge/scripts/clients.mjs write)
COPY packages/web packages/web
COPY packages/docs packages/docs
COPY packages/mail packages/mail
COPY packages/calendar packages/calendar
COPY packages/home packages/home
COPY packages/contacts packages/contacts
COPY packages/admin packages/admin
# clients:sources end

# The build tag the web client shows (vite.config.ts reads BUILD_SHA first; there is no .git in the build context).
# Each client is built for its manifest's basePath (BASE_PATH; the Docs app's is /docs/), the list read from
# the manifests by packages/edge/scripts/clients.mjs once shared is built.
ARG GIT_COMMIT_SHA
RUN set -e \
  && pnpm --filter @flow/shared build \
  && pnpm --filter @flow/server build \
  && node packages/edge/scripts/clients.mjs build > /tmp/clients \
  && while read -r pkg base; do \
       BUILD_SHA=$(printf '%.7s' "${GIT_COMMIT_SHA:-dev}") BASE_PATH="$base" pnpm --filter "$pkg" build; \
     done < /tmp/clients

# --- Run: the production dependencies and the built output, in the repository's layout ------------------------------
FROM node:24.22.1-bookworm-slim

# Chromium for the Workspace app's PDFs (CHROMIUM_PATH below).
RUN apt-get update \
  && apt-get install -y --no-install-recommends chromium fonts-liberation ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable && corepack prepare pnpm@10.33.0 --activate

WORKDIR /app

ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/shared/package.json packages/shared/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
COPY packages/agent-bridge/package.json packages/agent-bridge/
COPY packages/docs/package.json packages/docs/
COPY packages/docs/vendor packages/docs/vendor
COPY packages/suite-bar/package.json packages/suite-bar/
COPY apps/desktop/package.json apps/desktop/
RUN pnpm install --frozen-lockfile --prod --filter @flow/server... --filter @flow/docs... && pnpm store prune

# What the server reads at run time, at the paths it resolves them from (src/app.ts, src/services/help.ts,
# src/services/agentAvatars.ts): the web client, the help pages, the changelog behind "What's New", the avatars.
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/server/dist packages/server/dist
COPY --from=build /app/packages/web/dist packages/web/dist
# Not served from here: kept in the image for the edge Worker's deploy to copy out (deploy-edge.yml).
# clients:dists begin (node packages/edge/scripts/clients.mjs write)
COPY --from=build /app/packages/mail/dist packages/mail/dist
COPY --from=build /app/packages/calendar/dist packages/calendar/dist
COPY --from=build /app/packages/home/dist packages/home/dist
COPY --from=build /app/packages/contacts/dist packages/contacts/dist
COPY --from=build /app/packages/admin/dist packages/admin/dist
# clients:dists end
COPY --from=build /app/FEATURES.md ./
COPY packages/server/assets packages/server/assets
COPY packages/server/scripts packages/server/scripts
COPY scripts/build-features.mjs scripts/
COPY changelog changelog
COPY docs/help docs/help

# The Workspace app runs from its TypeScript sources (Node strips the types; src/workspace.ts imports
# packages/docs/server/app.ts by path): its server, the code it shares with its client, the client's sources (the
# plugin's tools run the editors' code on the server), the feature pages' content, the plugin's server, and the built
# client and plugin web view.
COPY packages/docs/server packages/docs/server
COPY packages/docs/shared packages/docs/shared
COPY packages/docs/client packages/docs/client
COPY packages/docs/content packages/docs/content
COPY packages/docs/plugin/server packages/docs/plugin/server
COPY --from=build /app/packages/docs/dist/client packages/docs/dist/client
COPY --from=build /app/packages/docs/plugin/dist/web packages/docs/plugin/dist/web

# The server runs as `node`, so what it may write goes under /data (deploy.sh mounts /data/flow there, and the
# Workspace app's data directory at /data/workspace): the local blob driver's files (production uses R2) and the dev
# email and push drivers' outboxes. FLOW_DATA_KEY must be set: the fallback key file under packages/server/.keys is
# not writable here, on purpose, so the server fails at boot rather than invent a key.
RUN mkdir -p /data && chown node:node /data

ARG GIT_COMMIT_SHA
ENV GIT_COMMIT_SHA=$GIT_COMMIT_SHA \
  NODE_ENV=production \
  HOST=0.0.0.0 \
  PORT=8787 \
  FLOW_FILE_DIR=/data/files \
  FLOW_EMAIL_OUTBOX=/data/emails \
  FLOW_PUSH_OUTBOX=/data/push \
  CHROMIUM_PATH=/usr/bin/chromium

USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s \
  CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

# Started directly (not through pnpm) so the server gets SIGTERM and drains (src/index.ts).
CMD ["node", "packages/server/dist/index.js"]
