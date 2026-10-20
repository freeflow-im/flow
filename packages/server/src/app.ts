import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import formbody from '@fastify/formbody';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { registerRoutes } from './routes/index.js';
import { registerSlackCompat } from './slackcompat/index.js';
import { config } from './config.js';
import { registerBrowserPolicy } from './lib/browserPolicy.js';

export function buildApp(): FastifyInstance {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    // DELETE /v1/me/devices/:token carries the device's push token in the
    // path. An APNs token is 64 hex characters; an FCM registration token is
    // ~160, past Fastify's default of 100, which answers 414 before the route
    // ever runs. DeviceTokenParam allows up to 4096.
    maxParamLength: 4096,
  });
  registerBrowserPolicy(app);
  void app.register(formbody); // Slack SDKs send application/x-www-form-urlencoded
  void app.register(multipart, {
    // server-buffered path keeps the small cap; big files go via presign→R2
    limits: { fileSize: config.maxServerUploadBytes, files: 1, fields: 4 },
  });
  // Raw-bytes catch-all for the local-driver presigned-upload fallback
  // (PUT /v1/files/:id/content arrives as image/png, application/pdf, …).
  // Only kicks in when no specific parser (json/form/multipart) matches —
  // except text/plain, whose built-in string parser we override to bytes too
  // (nothing else consumes text bodies; Slack-compat is form/multipart).
  const rawBody = { parseAs: 'buffer', bodyLimit: config.maxFileBytes } as const;
  app.addContentTypeParser('*', rawBody, (_req, body, done) => done(null, body));
  app.addContentTypeParser('text/plain', rawBody, (_req, body, done) => done(null, body));

  // Retired-hostname redirect (phase17 §13). Both the old and new hostnames
  // resolve to this one service, so the redirect has to key off the Host
  // header. `onRequest` runs before routing and before any body is parsed, so
  // a redirected request costs nothing downstream.
  //
  // /v1 and /api are deliberately exempt. A 302 on a POST is replayed as a GET
  // by most clients, and the WebSocket upgrade at /v1/ws cannot follow a
  // redirect at all — redirecting those would make old native clients go
  // quiet instead of failing visibly. They keep working on the old hostname
  // until its DNS is dropped, at which point everything stops together.
  // /download/* is NOT exempt: that is how an installed macOS app finds the
  // new appcast and migrates itself, and Sparkle follows redirects.
  const retiredHosts = config.redirectFromHosts;
  if (retiredHosts.length) {
    const canonical = config.webUrlBase.replace(/\/+$/, '');
    // Guard against a misconfiguration that would redirect the canonical host
    // to itself — an infinite loop that would take the whole service down.
    const canonicalHost = (() => {
      try {
        return new URL(canonical).hostname.toLowerCase();
      } catch {
        return '';
      }
    })();
    const hosts = retiredHosts.filter((h) => h !== canonicalHost);
    if (hosts.length !== retiredHosts.length) {
      app.log.warn(
        { canonicalHost },
        'FLOW_REDIRECT_FROM_HOSTS names the canonical host; ignoring that entry',
      );
    }
    if (hosts.length) {
      app.addHook('onRequest', async (req, reply) => {
        // req.hostname excludes the port in Fastify 5, but strip defensively.
        const host = (req.hostname ?? '').toLowerCase().split(':')[0] ?? '';
        if (!hosts.includes(host)) return;
        if (req.url.startsWith('/v1') || req.url.startsWith('/api')) return;
        return reply.redirect(`${canonical}${req.url}`, 302);
      });
      app.log.info({ hosts, canonical }, 'redirecting retired hostnames');
    }
  }

  registerRoutes(app);
  registerSlackCompat(app); // Slack Web API compat surface at /api/* (phase4.md §1)

  // Web client (phase2.md §7): the production build is served as static files
  // by this same process — the local deployment stays one process. In dev the
  // Vite server proxies to us instead, so a missing dist/ is fine.
  const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
  if (fs.existsSync(path.join(webDist, 'index.html'))) {
    void app.register(fastifyStatic, { root: webDist, wildcard: false });
    // Static policy page at a clean URL (the App Store privacy-policy field
    // wants a stable public link; /privacy.html works too via fastifyStatic).
    app.get('/privacy', (_req, reply) => reply.sendFile('privacy.html'));
    // SPA fallback: any non-API GET renders the app shell (/v1 = native REST,
    // /api = Slack-compat surface — both must 404 as JSON, never index.html)
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/v1') && !req.url.startsWith('/api')) {
        return reply.sendFile('index.html');
      }
      return reply.status(404).send({ error: { code: 'not_found', message: 'not found' } });
    });
    app.log.info({ webDist }, 'serving web client');
  }
  return app;
}
