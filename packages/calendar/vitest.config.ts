import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// The views are in the browser's zone: the tests run in one with daylight time, so a change of offset is covered.
process.env.TZ = 'America/New_York';

export default defineConfig({
  plugins: [react()],
  test: { include: ['src/**/*.test.{ts,tsx}', 'mock/**/*.test.ts'], environment: 'jsdom', env: { TZ: 'America/New_York' } },
});
