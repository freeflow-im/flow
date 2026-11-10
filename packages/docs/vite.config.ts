/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'client',
  // The suite serves the client under /docs (BASE_PATH=/docs/ when building for it); standalone, the root.
  base: process.env.BASE_PATH ?? '/',
  plugins: [react()],
  // One React: the suite bar (packages/suite-bar) is bundled from its sources, and its own dev copy must not load.
  resolve: { dedupe: ['react', 'react-dom'] },
  server: {
    port: Number(process.env.PORT ?? 5173),
    // Keep the browser's Host header so OAuth redirect URIs built by the server point at this dev server.
    // The API is the standalone app's own server (pnpm dev); DOCS_API points at the suite's Worker instead (BUILD.md, "Local
    // development"), which also answers /v1 (the suite bar, sign-in) and the WebSocket.
    proxy: Object.fromEntries(['/api', '/v1', '/privacy', '/terms', '/support', '/llms.txt', '/features', '/sitemap.xml', '/robots.txt'].map((p) => [p, { target: process.env.DOCS_API ?? 'http://localhost:3001', changeOrigin: false, ws: true }])),
  },
  build: { outDir: '../dist/client', emptyOutDir: true },
  test: {
    root: '.',
    include: ['shared/**/*.test.ts', 'server/**/*.test.ts', 'client/src/**/*.test.ts', 'plugin/**/*.test.ts'],
    setupFiles: ['test/windowsTemp.ts'],
    // Windows machines (the release's build) are slower to start a server and touch files.
    testTimeout: process.platform === 'win32' ? 20_000 : 5_000,
    // Repositories created by the git tests start on "main", and keep their files' line endings, whatever the
    // machine's git config says.
    // Tests expect the default assistant model, whatever AGENT_MODEL the machine running them sets.
    env: { AGENT_MODEL: '', GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'init.defaultBranch', GIT_CONFIG_VALUE_0: 'main', GIT_CONFIG_KEY_1: 'core.autocrlf', GIT_CONFIG_VALUE_1: 'false' },
  },
});
