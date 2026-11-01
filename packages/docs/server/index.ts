import './env.ts';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { buildApp } from './app.ts';

const root = path.resolve(import.meta.dirname, '..');
const dataDir = path.resolve(process.env.DATA_DIR ?? path.join(root, 'data'));
const port = Number(process.env.PORT ?? 3001);
const production = process.env.NODE_ENV === 'production';

mkdirSync(dataDir, { recursive: true });

// The ChatGPT plugin is served from this server when PLUGIN_ENABLED=1 (its OAuth issuer and image origin is
// PLUGIN_PUBLIC_URL, defaulting to APP_URL; several, comma-separated, for a server reached on more than one host); `npm run build` builds its app into plugin/dist/web.
const pluginUrl = process.env.PLUGIN_PUBLIC_URL || process.env.APP_URL;
const app = await buildApp({
  dataDir,
  staticDir: production ? path.join(root, 'dist', 'client') : undefined,
  secureCookies: process.env.SECURE_COOKIES === '1',
  logger: true,
  plugin: process.env.PLUGIN_ENABLED === '1' && pluginUrl ? { publicUrl: pluginUrl, webDir: path.join(root, 'plugin', 'dist', 'web') } : undefined,
});

// In production (in a container) listen on all interfaces; locally stay on loopback.
await app.listen({ port, host: process.env.HOST ?? (production ? '0.0.0.0' : '127.0.0.1') });

// Close cleanly on redeploy/shutdown so in-flight saves finish and SQLite is checkpointed.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    app.log.info({ signal }, 'shutting down');
    app.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}

// An app-change job sends SIGUSR2 once new code is verified; under the supervisor (npm start) exit code 75
// means "start me again". In development node --watch restarts on file changes instead.
process.once('SIGUSR2', () => {
  app.log.info('restarting to load new code');
  app.close().then(
    () => process.exit(75),
    () => process.exit(75),
  );
});
