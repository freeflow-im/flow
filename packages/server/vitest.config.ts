import { defineConfig } from 'vitest/config';

// Setup hooks (beforeAll/afterAll) migrate a scratch database and build the whole app, Workspace included. On a
// busy CI runner, with every file running in parallel against one postgres, that can pass vitest's default 10 s:
// test/workspace.test.ts' setup took 9.3 s on a passing run and timed out on others. Tests keep the default limit.
export default defineConfig({
  test: {
    hookTimeout: 60_000,
  },
});
