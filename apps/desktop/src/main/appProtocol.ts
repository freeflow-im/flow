// `app://flow/` — the origin the bundled web client is served from
// (docs/specs/desktop-electron.md, "Loading the web client").
//
// Registered as a standard, secure scheme before the app is ready, so the
// renderer has a real origin: localStorage works, `fetch` and WebSockets to
// the Flow server are ordinary cross-origin requests with `Origin: app://flow`,
// and the server admits that origin the way it admits a native client.
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { protocol } from 'electron';
import { DESKTOP_ORIGIN } from '@flow/shared';
import { contentTypeFor, isAssetPath } from './lib/mime.js';

export const APP_SCHEME = 'app';
export const APP_HOST = 'flow';

/** Must run before `app.whenReady()`. */
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([{
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  }]);
}

/** What the document may load. The web client is self-contained (fonts and
 * styles inline, mermaid bundled); it talks to any Flow server over https/wss
 * (http/ws for a loopback dev server), shows media
 * from presigned storage URLs, and frames artifacts and mini apps. Google's
 * sign-in script is deliberately absent: the shell signs in through the
 * system browser. */
const DOCUMENT_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' https: http: data: blob:",
  "media-src 'self' https: http: blob:",
  "font-src 'self' data:",
  "connect-src 'self' https: http: wss: ws: blob: data:",
  "frame-src 'self' https: http: blob: data:",
  "worker-src 'self' blob:",
  // PDF previews are an <embed> of an object URL (the browser's own viewer).
  "object-src 'self' blob:",
  "base-uri 'self'",
].join('; ');

/** Serve the built web client from `webRoot`. Call after the app is ready. */
export function serveWebClient(webRoot: string): void {
  const root = path.resolve(webRoot);
  protocol.handle(APP_SCHEME, (request) => {
    const url = new URL(request.url);
    if (url.host !== APP_HOST) return new Response('not found', { status: 404 });
    let pathname: string;
    try { pathname = decodeURIComponent(url.pathname); } catch { return new Response('bad request', { status: 400 }); }
    // A route (`/`, `/invite/x`) is the SPA; a file path is that file.
    const relative = isAssetPath(pathname) ? pathname : '/index.html';
    const file = path.resolve(root, `.${relative}`);
    // Never step outside the bundle, however the path was spelled.
    if (file !== root && !file.startsWith(root + path.sep)) return new Response('forbidden', { status: 403 });
    if (!existsSync(file) || !statSync(file).isFile()) return new Response('not found', { status: 404 });
    const headers: Record<string, string> = {
      'content-type': contentTypeFor(file),
      'cache-control': relative === '/index.html' ? 'no-store' : 'public, max-age=31536000, immutable',
    };
    if (relative === '/index.html') {
      headers['content-security-policy'] = DOCUMENT_CSP;
      headers['x-content-type-options'] = 'nosniff';
    }
    const body = Readable.toWeb(createReadStream(file)) as unknown as ReadableStream;
    return new Response(body, { status: 200, headers });
  });
}

/** Is this navigation target the bundled client? Used to keep the window
 * on the app and send everything else to the system browser. */
export function isAppUrl(url: string): boolean {
  return url === DESKTOP_ORIGIN || url.startsWith(`${DESKTOP_ORIGIN}/`);
}
