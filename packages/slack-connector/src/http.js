import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import { isBundledClientOrigin } from '@flow/shared';
import { Fault, MAX_FILE_BYTES } from './connector.js';

export function createConnectorServer(connector) {
  return createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const respond = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    try {
      const path = new URL(req.url, connector.publicOrigin).pathname;
      const origin = req.headers.origin;
      // The desktop app's renderer (docs/specs/desktop-electron.md) and the
      // Android shell (docs/design/ANDROID.md) are bundled clients like the
      // native apps and are admitted without configuration; they still get
      // CORS headers because Chromium checks them.
      const desktop = isBundledClientOrigin(origin);
      if (origin && !desktop && !connector.clientOrigins.includes(origin)) throw new Fault('client_origin_not_allowed', 403);
      if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
        res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
        // Retry-After is not CORS-safelisted; without this a browser client
        // sees a 429 but not the wait, and would have to guess.
        res.setHeader('Access-Control-Expose-Headers', 'Retry-After');
      }
      if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
      if (path === '/oauth/callback' && req.method === 'GET') {
        const params = new URL(req.url, connector.publicOrigin).searchParams;
        for (const key of ['state', 'code', 'error']) if (params.getAll(key).length > 1) throw new Fault('invalid_callback');
        const result = await connector.callback(Object.fromEntries(params));
        // A native client's authorization ends by returning to its URL scheme
        // (#546). Only the operation id travels in the URL; the handoff is
        // redeemed by polling with the private verifier, as on the web.
        if (connector.isNativeOrigin(result.clientOrigin)) {
          res.writeHead(302, { location: `${result.clientOrigin}/connected?operationId=${encodeURIComponent(result.operationId)}` });
          res.end();
          return;
        }
        const nonce = randomBytes(18).toString('base64');
        res.setHeader('Content-Security-Policy', `default-src 'none'; script-src 'nonce-${nonce}'; frame-ancestors 'none'; base-uri 'none'`);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        const data = JSON.stringify({ type: 'flow-slack-handoff', operationId: result.operationId, handoff: result.handoff }).replace(/</g, '\\u003c');
        const target = JSON.stringify(result.clientOrigin).replace(/</g, '\\u003c');
        res.end(`<!doctype html><title>Slack authorization</title><p>Authorization returned. You can close this window.</p><script nonce="${nonce}">history.replaceState(null,'','/oauth/callback');if(window.opener)window.opener.postMessage(${data},${target});</script>`);
        return;
      }
      // A Slack upload is the one raw-bytes body (up to the file cap); every
      // other request body is small JSON.
      if (path === '/v1/files' && req.method === 'POST') {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          if (size > MAX_FILE_BYTES) throw new Fault('file_too_large', 413);
          chunks.push(chunk);
        }
        const query = new URL(req.url, connector.publicOrigin).searchParams;
        const credential = req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]+)$/)?.[1];
        respond(200, await connector.upload(credential, { channel: query.get('channel'), name: query.get('name'), type: req.headers['content-type'], bytes: Buffer.concat(chunks) }));
        return;
      }
      let raw = Buffer.alloc(0);
      for await (const chunk of req) {
        if (raw.length + chunk.length > 64 * 1024) throw new Fault('body_too_large', 413);
        raw = Buffer.concat([raw, chunk]);
      }
      if (path === '/slack/events' && req.method === 'POST') { respond(200, connector.event(raw, req.headers['x-slack-request-timestamp'], req.headers['x-slack-signature'])); return; }
      let body = {};
      if (raw.length) {
        if (!req.headers['content-type']?.startsWith('application/json')) throw new Fault('json_required', 415);
        try { body = JSON.parse(raw.toString()); } catch { throw new Fault('invalid_json'); }
        if (!body || Array.isArray(body) || typeof body !== 'object') throw new Fault('invalid_json');
      }
      const credential = req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]+)$/)?.[1];
      if (path === '/health' && req.method === 'GET') { respond(200, { ok: true }); return; }
      // A browser proves its origin with the Origin header. A native client
      // sends none; it may name a configured `flow://` client origin instead,
      // which is not an authentication claim either way — the verifier is.
      // The desktop app sends its own Origin but returns through the native
      // `flow://slack` route, like the macOS app.
      const claimsClient = () => origin === body.clientOrigin || ((!origin || desktop) && connector.isNativeOrigin(body.clientOrigin));
      if (path === '/v1/oauth/start' && req.method === 'POST') {
        if (!claimsClient()) throw new Fault('origin_mismatch', 403);
        respond(200, connector.start(body)); return;
      }
      if (path === '/v1/oauth/poll' && req.method === 'POST') {
        if (!claimsClient()) throw new Fault('origin_mismatch', 403);
        respond(200, connector.poll(body)); return;
      }
      if (path === '/v1/oauth/exchange' && req.method === 'POST') {
        if (!claimsClient()) throw new Fault('origin_mismatch', 403);
        respond(200, connector.exchange(body)); return;
      }
      if (path === '/v1/connection' && req.method === 'GET') { respond(200, await connector.info(credential)); return; }
      if (path === '/v1/session' && req.method === 'DELETE') { connector.disconnect(credential); respond(200, { ok: true }); return; }
      if (path === '/v1/grant' && req.method === 'DELETE') { connector.removeGrant(credential); respond(200, { ok: true }); return; }
      if (path === '/v1/messages' && req.method === 'POST') { respond(200, await connector.send(credential, body)); return; }
      if (path === '/v1/events' && req.method === 'GET') { respond(200, { events: connector.events(credential) }); return; }
      // Public-API baseline (#545). Read routes take their parameters from the
      // query string; mutations take JSON bodies. Every route is credential-bound
      // and capability-checked by the connector; a missing scope is 403
      // `missing_scopes`, a parked rate budget is 429 with Retry-After.
      const query = new URL(req.url, connector.publicOrigin).searchParams;
      if (path === '/v1/workspace' && req.method === 'GET') { respond(200, await connector.workspace(credential)); return; }
      if (path === '/v1/conversations' && req.method === 'GET') { respond(200, { conversations: await connector.conversations(credential) }); return; }
      const userRoute = req.method === 'GET' && /^\/v1\/users\/([A-Z0-9]+)$/.exec(path);
      if (userRoute) { respond(200, await connector.user(credential, userRoute[1])); return; }
      if (path === '/v1/members' && req.method === 'GET') { respond(200, { members: await connector.members(credential) }); return; }
      if (path === '/v1/history' && req.method === 'GET') { respond(200, await connector.history(credential, { channel: query.get('channel'), cursor: query.get('cursor'), limit: query.get('limit') })); return; }
      if (path === '/v1/replies' && req.method === 'GET') { respond(200, await connector.replies(credential, { channel: query.get('channel'), ts: query.get('ts'), cursor: query.get('cursor') })); return; }
      if (path === '/v1/search' && req.method === 'GET') { respond(200, await connector.search(credential, { query: query.get('q'), cursor: query.get('cursor') })); return; }
      if (path === '/v1/stream' && req.method === 'GET') { respond(200, connector.stream(credential, query.get('since'))); return; }
      if (path === '/v1/messages' && req.method === 'PATCH') { respond(200, await connector.update(credential, body)); return; }
      if (path === '/v1/messages' && req.method === 'DELETE') { respond(200, await connector.remove(credential, body)); return; }
      if (path === '/v1/reactions' && req.method === 'POST') { respond(200, await connector.reaction(credential, body)); return; }
      if (path === '/v1/me' && req.method === 'PATCH') { respond(200, await connector.setStatus(credential, body)); return; }
      if (path === '/v1/read' && req.method === 'POST') { respond(200, await connector.markRead(credential, body)); return; }
      // File bytes (image previews, downloads) and custom emoji images, on the
      // same paths a Flow server serves, so clients reuse their file loading.
      // There is never a direct URL: the bytes come through here.
      const fileRoute = req.method === 'GET' && /^\/v1\/files\/([^/]+)(\/thumb)?(\/url)?$/.exec(path);
      if (fileRoute) {
        const id = decodeURIComponent(fileRoute[1]);
        if (fileRoute[3]) { connector.session(credential); respond(200, { url: null, expiresInSeconds: 0 }); return; }
        const file = id.startsWith('emoji:') ? await connector.emojiImage(credential, id.slice(6))
          : id.startsWith('team-icon:') ? await connector.teamIcon(credential, id.slice(10))
          : await connector.file(credential, { id, variant: fileRoute[2] ? 'thumb' : 'original' });
        sendFile(res, file);
        return;
      }
      const emojiRoute = req.method === 'GET' && /^\/v1\/workspaces\/([A-Z0-9]+)\/emoji$/.exec(path);
      if (emojiRoute) { respond(200, { emoji: await connector.emoji(credential, emojiRoute[1]) }); return; }
      throw new Fault('not_found', 404);
    } catch (error) {
      if (res.headersSent) { res.destroy(); return; }
      // Never serialize Slack responses, URLs, request bodies, or exception text.
      if (error.retryAfter) res.setHeader('Retry-After', String(error.retryAfter));
      respond(error instanceof Fault ? error.status : 500, { error: error instanceof Fault ? error.code : 'connector_error' });
    }
  });
}

/** Stream downloaded bytes to the client. Images render inline; anything else
 * is an attachment, and nothing served here may run as a document. */
function sendFile(res, { contentType, length, body, name }) {
  const inline = contentType.startsWith('image/') && contentType !== 'image/svg+xml';
  res.writeHead(200, {
    'content-type': inline ? contentType : 'application/octet-stream',
    'cache-control': 'private, max-age=86400',
    'content-security-policy': "default-src 'none'; sandbox",
    'content-disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(name)}`,
    ...(length ? { 'content-length': String(length) } : {}),
  });
  if (!body) { res.end(); return; }
  let sent = 0;
  const stream = Readable.fromWeb(body);
  stream.on('data', chunk => { sent += chunk.length; if (sent > MAX_FILE_BYTES) stream.destroy(); });
  stream.on('error', () => res.destroy());
  stream.on('close', () => { if (sent > MAX_FILE_BYTES) res.destroy(); });
  stream.pipe(res);
}
