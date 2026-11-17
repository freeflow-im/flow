import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// FreeFlow Meet is served under /meet (its manifest in @flow/shared: the Worker's page route and the assembler read it).
// In dev, /v1 and /api go to the local suite (MEET_API, default the edge Worker's `pnpm dev:suite`).
export default defineConfig({
  base: '/meet/',
  plugins: [react(), tailwindcss()],
  // One React: the suite bar (packages/suite-bar) is bundled from its sources.
  resolve: { dedupe: ['react', 'react-dom'] },
  server: {
    port: Number(process.env.PORT ?? 5190),
    strictPort: true,
    // /chat: the room's Chat tab frames Chat's page for the meeting's chat (src/lib/chat.ts).
    proxy: { '/v1': { target: process.env.MEET_API ?? 'http://127.0.0.1:8787', ws: true }, '/api': process.env.MEET_API ?? 'http://127.0.0.1:8787', '/chat': process.env.MEET_API ?? 'http://127.0.0.1:8787' },
  },
});
