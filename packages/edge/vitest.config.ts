import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // The Docs code's `#runtime/*` imports (packages/docs, docs/specs/docs-core.md §3.1) resolve to their Workers side here, as in the bundle.
    conditions: ['workerd'],
    alias: {
      'cloudflare:workers': fileURLToPath(new URL('./test/cloudflare-workers.ts', import.meta.url)),
      'cloudflare:sockets': fileURLToPath(new URL('./test/cloudflare-sockets.ts', import.meta.url)),
    },
  },
  ssr: { resolve: { conditions: ['workerd'] } },
});
