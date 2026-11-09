import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// FreeFlow Admin is served under /admin (its manifest in @flow/shared: the Worker's page route and the assembler read
// it). In dev, /v1 goes to the local API (ADMIN_API, default the edge Worker's `wrangler dev`).
export default defineConfig({
  base: '/admin/',
  plugins: [react(), tailwindcss()],
  // One React: the suite bar (packages/suite-bar) is bundled from its sources.
  resolve: { dedupe: ['react', 'react-dom'] },
  server: {
    port: Number(process.env.PORT ?? 5188),
    strictPort: true,
    proxy: { '/v1': process.env.ADMIN_API ?? 'http://127.0.0.1:8787' },
  },
});
