import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/meet/',
  plugins: [react()],
  test: { include: ['src/**/*.test.{ts,tsx}'], environment: 'jsdom' },
});
