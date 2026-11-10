import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { calendarMock } from './mock/plugin';

// FreeFlow Calendar is served under /calendar (packages/edge: src/routes/pages.ts serves its page, scripts/assemble.mjs
// files its build under public/calendar). In dev, /v1 goes to the local API (CALENDAR_API, default the edge Worker's
// `wrangler dev`), or, with CALENDAR_MOCK=1, to the sample calendars in mock/ (no server at all; CALENDAR_MOCK=empty
// starts with no account).
export default defineConfig({
  base: '/calendar/',
  plugins: [react(), tailwindcss(), ...(process.env.CALENDAR_MOCK ? [calendarMock()] : [])],
  // One React: the suite bar (packages/suite-bar) is bundled from its sources.
  resolve: { dedupe: ['react', 'react-dom'] },
  server: {
    port: Number(process.env.PORT ?? 5186),
    strictPort: true,
    // /v1 is the Calendar API; /api and /docs are the Docs assistant (the panel talks to the organization's Docs), as Mail's dev server proxies them.
    ...(process.env.CALENDAR_MOCK ? {} : { proxy: { '/v1': { target: process.env.CALENDAR_API ?? 'http://127.0.0.1:8787', ws: true }, '/api': process.env.CALENDAR_API ?? 'http://127.0.0.1:8787', '/docs': process.env.CALENDAR_API ?? 'http://127.0.0.1:8787' } }),
  },
});
