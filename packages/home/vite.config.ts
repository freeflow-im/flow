import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// FreeFlow Home is served under /home (its manifest in @flow/shared: the Worker's page route and the assembler read it).
// In dev, /v1 and /api go to the local suite (HOME_API, default the edge Worker's `pnpm dev:suite`).
export default defineConfig({
  base: '/home/',
  plugins: [react(), tailwindcss()],
  // One React: the suite bar (packages/suite-bar) is bundled from its sources.
  resolve: { dedupe: ['react', 'react-dom'] },
  server: {
    port: Number(process.env.PORT ?? 5189),
    strictPort: true,
    proxy: { '/v1': process.env.HOME_API ?? 'http://127.0.0.1:8787', '/api': process.env.HOME_API ?? 'http://127.0.0.1:8787' },
  },
});
