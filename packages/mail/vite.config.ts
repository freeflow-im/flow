import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { mailMock } from './mock/plugin';

// FreeFlow Mail is served under /mail (packages/edge: src/routes/pages.ts serves its page, scripts/assemble.mjs files
// its build under public/mail). In dev, /v1 (and Docs' /api and /docs, for attachment previews) go to the local API
// (MAIL_API, default the edge Worker's `wrangler dev`),
// or, with MAIL_MOCK=1, to the sample mailbox in mock/ (no server at all).
export default defineConfig({
  base: '/mail/',
  plugins: [react(), tailwindcss(), ...(process.env.MAIL_MOCK ? [mailMock()] : [])],
  // One React: the suite bar (packages/suite-bar) is bundled from its sources.
  resolve: { dedupe: ['react', 'react-dom'] },
  // Compose (and with it TipTap) loads lazily; pre-bundled up front, so the dev server does not discover it mid-session
  // and reload with a second copy of React.
  optimizeDeps: { include: ['@tiptap/react', '@tiptap/starter-kit', '@tiptap/extensions'] },
  server: {
    port: Number(process.env.PORT ?? 5185),
    strictPort: true,
    ...(process.env.MAIL_MOCK ? {} : { proxy: { '/v1': { target: process.env.MAIL_API ?? 'http://127.0.0.1:8787', ws: true }, '/api': process.env.MAIL_API ?? 'http://127.0.0.1:8787', '/docs': process.env.MAIL_API ?? 'http://127.0.0.1:8787' } }),
  },
});
