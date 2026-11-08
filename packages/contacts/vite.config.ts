import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// FreeFlow Contacts is served under /contacts (its manifest in @flow/shared: the Worker's page route and the assembler read
// it). In dev, /v1 goes to the local API (CONTACTS_API, default the edge Worker's `wrangler dev`).
export default defineConfig({
  base: '/contacts/',
  plugins: [react(), tailwindcss()],
  // One React: the suite bar (packages/suite-bar) is bundled from its sources.
  resolve: { dedupe: ['react', 'react-dom'] },
  server: {
    port: Number(process.env.PORT ?? 5187),
    strictPort: true,
    proxy: { '/v1': process.env.CONTACTS_API ?? 'http://127.0.0.1:8787' },
  },
});
