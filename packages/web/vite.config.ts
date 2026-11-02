import { execSync } from 'node:child_process';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Build tag = the short commit SHA of the deployed build, shown at the foot of
// the workspace menu (read as the `__BUILD__` global; see src/vite-env.d.ts).
// Resolution order, so every environment shows the real commit:
//   1. `BUILD_SHA` env — explicit override (CI).
//   2. local git (`git rev-parse --short HEAD`) — dev machines / any checkout.
//   3. `RAILWAY_GIT_COMMIT_SHA` — Railway's Railpack build has no `.git`, so the
//      git call throws; Railway injects the deploy's commit SHA as a build-time
//      env var (shortened to 7 chars).
//   4. `dev` — no git and no env (bare `vite build` outside a checkout).
function buildSha(): string {
  if (process.env.BUILD_SHA) return process.env.BUILD_SHA;
  try {
    return execSync('git rev-parse --short HEAD').toString().trim();
  } catch {
    const sha = process.env.RAILWAY_GIT_COMMIT_SHA;
    return sha ? sha.slice(0, 7) : 'dev';
  }
}

// Dev: Vite serves the SPA and proxies API + WS to the local backend so the
// client is same-origin in both dev and prod (prod = Fastify static serving).
export default defineConfig({
  plugins: [react(), tailwindcss()],
  // One React: the suite bar (packages/suite-bar) is bundled from its sources, and its own dev copy must not load.
  resolve: { dedupe: ['react', 'react-dom'] },
  define: {
    __BUILD__: JSON.stringify(buildSha()),
  },
  server: {
    port: 5173,
    proxy: {
      '/v1': {
        target: 'http://127.0.0.1:8787',
        ws: true, // /v1/ws WebSocket upgrade
      },
      '/healthz': 'http://127.0.0.1:8787',
    },
  },
});
