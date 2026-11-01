# The hosted app's image for AWS, built from the repository root: `docker build -f deploy/aws/Dockerfile .`: Node from
# .node-version, git for app-change jobs, Chromium for PDFs, and the dev dependencies kept so those jobs can
# typecheck, test and rebuild in the container.
FROM node:24.22.1-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git chromium fonts-liberation ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Electron is a dev dependency for the desktop app only.
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
COPY package.json package-lock.json ./
COPY vendor ./vendor
RUN npm ci

COPY . .
RUN npm run build

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

# The supervisor (what `npm start` runs), started directly so it gets the platform's signals.
CMD ["node", "server/supervise.ts"]
