import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['desktop/**/*.test.ts'],
    setupFiles: ['test/windowsTemp.ts'],
    // Windows machines (the release's build) are slower to start a server and touch files.
    testTimeout: process.platform === 'win32' ? 20_000 : 5_000,
  },
});
