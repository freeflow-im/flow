import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { calendarMock } from './mock/plugin';

// FreeFlow Calendar is served under /calendar (packages/edge: src/routes/pages.ts serves its page, scripts/assemble.mjs
// files its build under public/calendar). In dev, /v1 goes to the local API (CALENDAR_API, default the edge Worker's
// `wrangler dev`), or, with CALENDAR_MOCK=1, to the sample calendars in mock/ (no server at all; CALENDAR_MOCK=empty
// starts with no account).
/** The guest scheduler's page in dev: /calendar/book/<token> is book.html, as the Worker serves it (manifest `file`). */
const bookPage = (): Plugin => ({
  name: 'calendar-book-page',
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      if (req.url && /^\/calendar\/book\/[^.]*$/.test(req.url.split('?')[0]!)) req.url = `/calendar/book.html${req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''}`;
      next();
    });
  },
});

export default defineConfig({
  base: '/calendar/',
  plugins: [react(), tailwindcss(), bookPage(), ...(process.env.CALENDAR_MOCK ? [calendarMock()] : [])],
  // Two pages: the app (index.html) and the guest scheduler's public page (book.html, docs/specs/guest-scheduler.md §4).
  build: { rollupOptions: { input: { main: fileURLToPath(new URL('index.html', import.meta.url)), book: fileURLToPath(new URL('book.html', import.meta.url)) } } },
  // One React: the suite bar (packages/suite-bar) is bundled from its sources.
  resolve: { dedupe: ['react', 'react-dom'] },
  server: {
    port: Number(process.env.PORT ?? 5186),
    strictPort: true,
    // /v1 is the Calendar API; /api and /docs are the Docs assistant (the panel talks to the organization's Docs), as Mail's dev server proxies them.
    ...(process.env.CALENDAR_MOCK ? {} : { proxy: { '/v1': { target: process.env.CALENDAR_API ?? 'http://127.0.0.1:8787', ws: true }, '/api': process.env.CALENDAR_API ?? 'http://127.0.0.1:8787', '/docs': process.env.CALENDAR_API ?? 'http://127.0.0.1:8787' } }),
  },
});
