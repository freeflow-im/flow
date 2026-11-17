// `flow-agent-bridge app-guard` — the reverse proxy that sits in front of an
// agent-hosted web app so only authenticated Flow channel members reach it
// (docs/design/MINI_APPS.md § "Guard"). The agent tunnels *this* port, never
// the app's.
//
// Three request shapes, in order:
//
//   ?flow_token=…    verify offline against the configured secret(s), burn the
//                    jti, mint a session cookie, 302 to the same URL without
//                    the token. The token is a door key: one use, ≤5 minutes.
//   session cookie   proxy to the upstream with X-Flow-* identity headers taken
//                    from the server-side session — never from the request.
//   anything else    401, one line of HTML. No redirect into Flow: the artifact
//                    is the way in, and a framed app cannot drive an OAuth-style
//                    bounce anyway.
//
// Nothing decodable lives in the browser — the cookie is an opaque random id
// into an in-memory map. A guard restart therefore logs everyone out, and the
// clients re-mint invisibly on next open (spec risk #3, accepted).
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import type { Duplex } from 'node:stream';
import { JtiStore, decodeAppSecret, verifyAppTokenAny, type AppTokenPayload } from './app-token.js';

/** Session lifetime. Long enough to use an app for a working day, short enough
 * that a removed member's access dies without any membership plumbing. */
export const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

export const SESSION_COOKIE = 'flow_app_session';

/** The query parameter the client appends when opening the artifact. */
export const TOKEN_PARAM = 'flow_token';

/** Everything the app is told about the viewer. Straight off the verified
 * token — the app sees identity it cannot be lied to about. */
export interface GuardSession {
  userId: string;
  displayName: string;
  isAgent: boolean;
  /** An app artifact's viewer (token version 1). */
  artifactId?: string;
  channelId?: string;
  /** An installed app's viewer, from its tab (token version 2, docs/specs/user-apps.md §6.2). */
  app?: string;
  accountId?: string;
  workspaceId: string;
  expiresAt: number; // epoch ms
}

export interface AppGuardOptions {
  /** Where the real app listens, e.g. `http://localhost:3000`. */
  upstream: string;
  /** base64url secrets from `create_artifact` — one per artifact, and one app
   * can be pinned in several channels (spec risk #5). */
  secrets: string[];
  /** Injectable for tests. */
  now?: () => Date;
  /** Log line sink; defaults to stderr so stdout stays clean. */
  log?: (line: string) => void;
}

const UNAUTHORIZED_HTML = '<!doctype html><meta charset="utf-8"><title>Flow</title><p>Open this app from its Flow channel.\n';

/** Parse a Cookie header into a name → value map. Tolerant: a malformed pair is
 * skipped, not fatal. */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (name) out[name] = part.slice(eq + 1).trim();
  }
  return out;
}

/** Drop our own session cookie from what the upstream sees — it is the guard's
 * bookkeeping, not the app's, and the app has no way to use it. Other cookies
 * (the app's own) pass through untouched. */
function stripSessionCookie(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const kept = header
    .split(';')
    .filter((p) => p.slice(0, p.indexOf('=') > 0 ? p.indexOf('=') : p.length).trim() !== SESSION_COOKIE)
    .map((p) => p.trim())
    .filter(Boolean);
  return kept.length ? kept.join('; ') : undefined;
}

/**
 * The headers the upstream receives: the client's, minus anything `X-Flow-*`
 * (so a viewer cannot claim to be someone else) and minus the session cookie,
 * plus the identity we verified. Order matters only in that the strip happens
 * first — the identity headers are always the guard's own.
 */
export function upstreamHeaders(inbound: http.IncomingHttpHeaders, session: GuardSession): http.IncomingHttpHeaders {
  const out: http.IncomingHttpHeaders = {};
  for (const [k, v] of Object.entries(inbound)) {
    if (k.toLowerCase().startsWith('x-flow-')) continue;
    out[k] = v;
  }
  const cookie = stripSessionCookie(inbound.cookie);
  if (cookie) out.cookie = cookie;
  else delete out.cookie;
  out['x-flow-user-id'] = session.userId;
  out['x-flow-user-name'] = session.displayName;
  if (session.artifactId) out['x-flow-artifact-id'] = session.artifactId;
  if (session.channelId) out['x-flow-channel-id'] = session.channelId;
  if (session.app) out['x-flow-app'] = session.app;
  if (session.accountId) out['x-flow-account-id'] = session.accountId;
  out['x-flow-workspace-id'] = session.workspaceId;
  out['x-flow-is-agent'] = session.isAgent ? 'true' : 'false';
  return out;
}

/** The same URL with the one-time token removed — where the 302 points, so the
 * token makes exactly one appearance in the address bar (spec risk #2). */
export function cleanUrl(rawUrl: string): string {
  const u = new URL(rawUrl, 'http://guard.invalid');
  u.searchParams.delete(TOKEN_PARAM);
  return `${u.pathname}${u.search}${u.hash}`;
}

export class AppGuard {
  readonly server: http.Server;
  private readonly secrets: Buffer[];
  private readonly upstream: URL;
  private readonly jtis = new JtiStore();
  private readonly sessions = new Map<string, GuardSession>();
  private readonly now: () => Date;
  private readonly log: (line: string) => void;

  constructor(opts: AppGuardOptions) {
    if (opts.secrets.length === 0) throw new Error('app-guard needs at least one secret');
    this.secrets = opts.secrets.map(decodeAppSecret);
    this.upstream = new URL(opts.upstream);
    if (this.upstream.protocol !== 'http:' && this.upstream.protocol !== 'https:') {
      throw new Error(`--upstream must be http(s), got ${opts.upstream}`);
    }
    this.now = opts.now ?? (() => new Date());
    this.log = opts.log ?? ((l) => console.error(l));
    this.server = http.createServer((req, res) => this.handle(req, res));
    this.server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket as Duplex, head));
  }

  listen(port: number, host = '0.0.0.0'): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, () => {
        this.server.removeListener('error', reject);
        resolve();
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.server.closeAllConnections?.();
      this.server.close(() => resolve());
    });
  }

  /** Live session count — for tests and the periodic log line. */
  get sessionCount(): number {
    return this.sessions.size;
  }

  /** The session this request carries, or null. Expired sessions are dropped on
   * sight so the map cannot grow past its 8-hour window. */
  private sessionFor(req: http.IncomingMessage): GuardSession | null {
    const id = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!id) return null;
    const s = this.sessions.get(id);
    if (!s) return null;
    if (s.expiresAt <= this.now().getTime()) {
      this.sessions.delete(id);
      return null;
    }
    return s;
  }

  /** Turn a verified token into a session. Returns the cookie value. */
  private openSession(payload: AppTokenPayload): string {
    const id = randomBytes(32).toString('base64url');
    this.sessions.set(id, {
      userId: payload.userId,
      displayName: payload.displayName,
      isAgent: payload.isAgent,
      workspaceId: payload.workspaceId,
      ...(payload.v === 1 ? { artifactId: payload.artifactId, channelId: payload.channelId } : { app: payload.app, accountId: payload.accountId }),
      expiresAt: this.now().getTime() + SESSION_TTL_MS,
    });
    return id;
  }

  private unauthorized(res: http.ServerResponse): void {
    res.writeHead(401, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(UNAUTHORIZED_HTML),
    });
    res.end(UNAUTHORIZED_HTML);
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const rawUrl = req.url ?? '/';
    const token = new URL(rawUrl, 'http://guard.invalid').searchParams.get(TOKEN_PARAM);

    if (token) {
      const payload = verifyAppTokenAny(this.secrets, token, this.now());
      // A replayed jti is treated exactly like a bad token: the guard says
      // nothing about *why*, because the difference is only interesting to
      // someone probing it.
      if (!payload || !this.jtis.burn(payload.jti, payload.exp, this.now())) {
        this.log(`app-guard: rejected token (${payload ? 'replayed' : 'invalid or expired'})`);
        return this.unauthorized(res);
      }
      const id = this.openSession(payload);
      this.log(`app-guard: session opened for ${payload.displayName} <${payload.userId}>`);
      res.writeHead(302, {
        location: cleanUrl(rawUrl),
        // SameSite=None because the web client frames the app cross-origin;
        // that requires Secure, which is fine — the tunnel is https.
        'set-cookie': `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
        'cache-control': 'no-store',
      });
      res.end();
      return;
    }

    const session = this.sessionFor(req);
    if (!session) return this.unauthorized(res);
    this.proxy(req, res, session);
  }

  private proxy(req: http.IncomingMessage, res: http.ServerResponse, session: GuardSession): void {
    const target = new URL(req.url ?? '/', this.upstream);
    const proxied = http.request(
      {
        protocol: this.upstream.protocol,
        hostname: this.upstream.hostname,
        port: this.upstream.port,
        method: req.method,
        path: `${target.pathname}${target.search}`,
        headers: upstreamHeaders(req.headers, session),
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    proxied.on('error', (err: Error) => {
      this.log(`app-guard: upstream error: ${err.message}`);
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('upstream unavailable\n');
    });
    req.pipe(proxied);
  }

  /**
   * WebSocket (and any other) upgrades get the same cookie check, then a raw
   * two-way pipe. Live apps need it; the Task Board polls today, but designing
   * it out would be a trap for the next app.
   */
  private handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const session = this.sessionFor(req);
    if (!session) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      return void socket.destroy();
    }
    // Bytes the client already sent past the request headers belong to the
    // tunnelled stream, so put them back before the pipe is wired up.
    if (head?.length) socket.unshift(head);
    const target = new URL(req.url ?? '/', this.upstream);
    const proxied = http.request({
      protocol: this.upstream.protocol,
      hostname: this.upstream.hostname,
      port: this.upstream.port,
      method: req.method,
      path: `${target.pathname}${target.search}`,
      headers: upstreamHeaders(req.headers, session),
    });
    proxied.on('upgrade', (upRes, upSocket, upHead) => {
      const headers = Object.entries(upRes.headers)
        .flatMap(([k, v]) => (Array.isArray(v) ? v.map((one) => `${k}: ${one}`) : [`${k}: ${v as string}`]))
        .join('\r\n');
      socket.write(`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage}\r\n${headers}\r\n\r\n`);
      if (upHead?.length) upSocket.unshift(upHead);
      upSocket.on('error', () => socket.destroy());
      socket.on('error', () => upSocket.destroy());
      upSocket.pipe(socket).pipe(upSocket);
    });
    proxied.on('error', (err: Error) => {
      this.log(`app-guard: upstream upgrade error: ${err.message}`);
      socket.destroy();
    });
    // An upgrade request carries no body — send the head and wait.
    proxied.end();
  }
}

/** Split `FLOW_APP_SECRET` into secrets: comma, space or newline separated so a
 * `.env` line and a shell export both work. */
export function parseSecretList(raw: string | undefined): string[] {
  return (raw ?? '').split(/[\s,]+/).filter(Boolean);
}
