/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'client',
  plugins: [react()],
  server: {
    port: 5173,
    // Keep the browser's Host header so OAuth redirect URIs built by the server point at this dev server.
    proxy: Object.fromEntries(['/api', '/privacy', '/terms', '/support', '/llms.txt', '/features', '/sitemap.xml', '/robots.txt'].map((p) => [p, { target: 'http://localhost:3001', changeOrigin: false }])),
  },
  build: { outDir: '../dist/client', emptyOutDir: true },
  test: {
    root: '.',
    include: ['shared/**/*.test.ts', 'server/**/*.test.ts', 'client/src/**/*.test.ts', 'plugin/**/*.test.ts', 'desktop/**/*.test.ts'],
    setupFiles: ['test/windowsTemp.ts'],
    // Windows machines (the release's build) are slower to start a server and touch files.
    testTimeout: process.platform === 'win32' ? 20_000 : 5_000,
    // Repositories created by the git tests start on "main", and keep their files' line endings, whatever the
    // machine's git config says.
    // Tests expect the default assistant model, whatever AGENT_MODEL the machine running them sets.
    env: { AGENT_MODEL: '', GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'init.defaultBranch', GIT_CONFIG_VALUE_0: 'main', GIT_CONFIG_KEY_1: 'core.autocrlf', GIT_CONFIG_VALUE_1: 'false' },
  },
});
