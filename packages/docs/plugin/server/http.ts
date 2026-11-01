// The plugin's HTTP server: OAuth discovery and endpoints, the MCP endpoint (streamable HTTP, stateless, per
// user), document images, the built app's assets, and a health check. index.ts reads the environment and
// starts it; tests start it on a free port.
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { PREVIEW_FILE_TYPES } from '../../shared/types.ts';
import type { FileHub } from './files.ts';
import { createMcpServer, instructionsFor, MCP_VERSIONS, SERVER_CAPABILITIES, serverInfo, type Bundle, type McpOptions, type McpVersion } from './mcp.ts';
import { importLimit, ToolError } from './files.ts';
import { OAuthError, type OAuthServer } from './oauth.ts';
import { adaptTransport, discoverResult, isDiscover, isStateless, presentAsSdkVersion, readJson } from './stateless.ts';

export interface PluginServerOptions {
  hub: FileHub;
  /** OAuth, or null for development mode where every request acts as devUserId. */
  oauth: OAuthServer | null;
  devUserId?: string;
  publicUrl: string | null;
  /** Directory with the built app (app.js, app.css). */
  webDir: string;
  production: boolean;
  /** Log request bodies on the MCP endpoint. */
  logBodies?: boolean;
  /** When hosted inside the app: the account already signed in to the app in this browser, from its cookie. */
  sessionUser?: (req: http.IncomingMessage) => string | null;
  mcp?: Partial<McpOptions>;
}

/** The plugin's request handler: which paths it owns, and how to serve them. */
export interface PluginHandler {
  handles(pathname: string): boolean;
  handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void>;
}

/** Paths the plugin serves; anything else belongs to whoever hosts it. */
/** The version of the tools an MCP path serves: /mcp is version 1 (what ChatGPT reviewed), /mcp/v<n> version n. */
export function mcpVersion(p: string): McpVersion | null {
  if (p === '/mcp') return 1;
  const n = Number(/^\/mcp\/v(\d+)$/.exec(p)?.[1]);
  return (MCP_VERSIONS as readonly number[]).includes(n) ? (n as McpVersion) : null;
}

export const PLUGIN_PATH = /^(\/mcp(\/|$)|\/oauth\/|\/plugin\/|\/\.well-known\/(oauth-protected-resource|oauth-authorization-server|openid-configuration|openai-apps-challenge)(\/|$))/;

/** A standalone server for the plugin (development, or a host of its own). */
export function createPluginServer(opts: PluginServerOptions): http.Server {
  const handler = createPluginHandler(opts);
  return http.createServer((req, res) => void handler.handle(req, res));
}

export function createPluginHandler(opts: PluginServerOptions): PluginHandler {
  const { hub, oauth, publicUrl, production } = opts;

  /** The built app. Re-read on every request in development so rebuilds show up. */
  let cached: Bundle | null = null;
  const bundle = (): Bundle => {
    if (cached && production) return cached;
    const js = path.join(opts.webDir, 'app.js');
    const css = path.join(opts.webDir, 'app.css');
    if (!existsSync(js)) throw new Error(`The app is not built: run "npm run plugin:build" (looked for ${js}).`);
    const code = readFileSync(js, 'utf8');
    const styles = existsSync(css) ? readFileSync(css, 'utf8') : '';
    cached = { js: code, css: styles, hash: createHash('sha1').update(code).update(styles).digest('hex').slice(0, 10) };
    return cached;
  };

  const json = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers }).end(JSON.stringify(body));
  };
  const html = (res: http.ServerResponse, status: number, body: string) => {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(body);
  };
  const redirect = (res: http.ServerResponse, url: string) => {
    res.writeHead(302, { location: url, 'cache-control': 'no-store' }).end();
  };
  const oauthFailure = (res: http.ServerResponse, e: unknown) => {
    if (e instanceof OAuthError) return json(res, e.status, { error: e.code, error_description: e.message });
    throw e;
  };

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const p = url.pathname;
    if (!mcpVersion(p)) logRequest(req, res, undefined);
    // The local harness calls /mcp from the browser; ChatGPT calls it from its servers.
    if (!production) {
      res.setHeader('access-control-allow-origin', '*');
      res.setHeader('access-control-allow-headers', 'content-type, accept, authorization, mcp-session-id, mcp-protocol-version');
      res.setHeader('access-control-expose-headers', 'mcp-session-id, www-authenticate');
      if (req.method === 'OPTIONS') {
        res.writeHead(204).end();
        return;
      }
    }
    try {
      // OpenAI's proof that we own this domain, for the plugin's submission: the token it issued, as plain text.
      if (req.method === 'GET' && p === '/.well-known/openai-apps-challenge') {
        const token = process.env.OPENAI_APPS_CHALLENGE?.trim();
        res.writeHead(token ? 200 : 404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }).end(token || 'Not found');
        return;
      }
      // --- OAuth discovery (the paths ChatGPT probes: plain, with the /mcp suffix, and under /mcp) ---
      if (oauth && req.method === 'GET') {
        // A versioned endpoint (/mcp/v2) is a resource of its own, found the same ways.
        const prm = /^(\/mcp(?:\/v\d+)?)?\/\.well-known\/oauth-protected-resource(\/mcp(?:\/v\d+)?)?$/.exec(p);
        if (prm) {
          const endpoint = prm[2] ?? prm[1] ?? '/mcp';
          if (mcpVersion(endpoint)) return json(res, 200, oauth.protectedResourceMetadata(endpoint), { 'access-control-allow-origin': '*' });
        }
        if (/^(\/mcp(?:\/v\d+)?)?\/\.well-known\/(oauth-authorization-server|openid-configuration)(\/mcp(?:\/v\d+)?)?$/.test(p)) return json(res, 200, oauth.authorizationServerMetadata(), { 'access-control-allow-origin': '*' });
      }

      // --- OAuth endpoints ---
      if (oauth && p.startsWith('/oauth/')) {
        if (p === '/oauth/register' && req.method === 'POST') {
          try {
            return json(res, 201, oauth.register(await readJson(req)));
          } catch (e) {
            return oauthFailure(res, e);
          }
        }
        if (p === '/oauth/authorize' && req.method === 'GET') {
          try {
            const out = await oauth.authorize(Object.fromEntries(url.searchParams));
            if (out.kind === 'redirect') return redirect(res, out.url);
            // Already signed in to the app in this browser: straight to consent.
            const known = opts.sessionUser?.(req) ?? null;
            if (known) {
              oauth.setUser(out.pendingId, known);
              return redirect(res, `/oauth/consent?p=${encodeURIComponent(out.pendingId)}`);
            }
            return html(res, 200, oauth.signInPage(out.pendingId));
          } catch (e) {
            if (e instanceof OAuthError) return html(res, e.status, oauth.errorPage(e.message));
            throw e;
          }
        }
        if (p === '/oauth/login' && req.method === 'POST') {
          const form = await readForm(req);
          const r = await oauth.passwordLogin(form.p ?? '', form.email, form.password);
          if (!r.ok) return html(res, 200, oauth.signInPage(form.p ?? '', r.error));
          return redirect(res, `/oauth/consent?p=${encodeURIComponent(form.p ?? '')}`);
        }
        // --- Creating an account: email and password, then the emailed link, which comes back here ---
        if (p === '/oauth/signup' && req.method === 'GET') return html(res, 200, oauth.signUpPage(url.searchParams.get('p') ?? ''));
        if (p === '/oauth/signup' && req.method === 'POST') {
          const form = await readForm(req);
          const r = await oauth.signUp(form.p ?? '', form.email, form.password);
          if (!r.ok) return html(res, 200, oauth.signUpPage(form.p ?? '', r.error, form.email));
          return html(res, 200, oauth.checkEmailPage(form.p ?? '', r.email));
        }
        if (p === '/oauth/verify' && req.method === 'GET') return html(res, 200, oauth.verifyPage(url.searchParams.get('p') ?? '', url.searchParams.get('token') ?? ''));
        if (p === '/oauth/verify' && req.method === 'POST') {
          const form = await readForm(req);
          const r = oauth.verifyEmail(form.p, form.token);
          if ('error' in r) return html(res, 400, oauth.errorPage(r.error));
          return redirect(res, r.next);
        }
        if (p === '/oauth/google/start' && req.method === 'GET') {
          const to = oauth.googleStart(url.searchParams.get('p') ?? '', `${oauth.issuer}/oauth/google/callback`);
          if (!to) return html(res, 400, oauth.errorPage('Google sign-in is not available, or this sign-in link has expired.'));
          return redirect(res, to);
        }
        if (p === '/oauth/google/callback' && req.method === 'GET') {
          const r = await oauth.googleFinish(url.searchParams.get('state') ?? undefined, url.searchParams.get('code') ?? undefined, url.searchParams.get('error') ?? undefined);
          if ('error' in r) return html(res, 400, oauth.errorPage(r.error));
          return redirect(res, r.next);
        }
        if (p === '/oauth/consent' && req.method === 'GET') return html(res, 200, oauth.consentPage(url.searchParams.get('p') ?? ''));
        if (p === '/oauth/switch' && req.method === 'GET') {
          const pendingId = url.searchParams.get('p') ?? '';
          oauth.clearUser(pendingId);
          return html(res, 200, oauth.signInPage(pendingId));
        }
        if (p === '/oauth/decision' && req.method === 'POST') {
          const form = await readForm(req);
          try {
            return redirect(res, oauth.decide(form.p, form.allow === 'yes'));
          } catch (e) {
            if (e instanceof OAuthError) return html(res, e.status, oauth.errorPage(e.message));
            throw e;
          }
        }
        // --- Device sign-in (RFC 8628): the agent asks for a code, the person enters it on /oauth/device ---
        if (p === '/oauth/device_authorization' && req.method === 'POST') {
          try {
            const agent = String(req.headers['user-agent'] ?? '').slice(0, 80);
            return json(res, 200, await oauth.deviceAuthorization(await readForm(req), `${clientAddress(req)}${agent ? ` (${agent})` : ''}`));
          } catch (e) {
            return oauthFailure(res, e);
          }
        }
        if (p === '/oauth/device' && req.method === 'GET') return html(res, 200, oauth.devicePage());
        if (p === '/oauth/device' && req.method === 'POST') {
          const form = await readForm(req);
          const r = oauth.startDevice(form.code, clientAddress(req));
          if ('error' in r) return html(res, 200, oauth.devicePage(r.error));
          const known = opts.sessionUser?.(req) ?? null;
          if (known) {
            oauth.setUser(r.pendingId, known);
            return redirect(res, `/oauth/consent?p=${encodeURIComponent(r.pendingId)}`);
          }
          return html(res, 200, oauth.signInPage(r.pendingId));
        }
        if (p === '/oauth/device/done' && req.method === 'GET') return html(res, 200, oauth.deviceDonePage(url.searchParams.get('ok') === '1'));
        if (p === '/oauth/token' && req.method === 'POST') {
          try {
            return json(res, 200, oauth.token(await readForm(req)));
          } catch (e) {
            return oauthFailure(res, e);
          }
        }
        if (p === '/oauth/revoke' && req.method === 'POST') {
          oauth.revoke(await readForm(req));
          res.writeHead(200).end();
          return;
        }
        res.writeHead(404).end('Not found');
        return;
      }

      // --- MCP ---
      const version = mcpVersion(p);
      if (version) {
        let userId = opts.devUserId ?? null;
        if (oauth) {
          const who = oauth.authenticate(req.headers.authorization, p);
          if (!who) {
            // Says why, and how to get going again; logged, since a refusal is otherwise invisible here.
            const why = oauth.refusal(req.headers.authorization, p);
            console.log(`${new Date().toISOString().slice(11, 23)} ${req.method} ${p} -> 401 ${why.reason} [${String(req.headers['user-agent'] ?? '').slice(0, 24)}]`);
            res
              .writeHead(401, { 'www-authenticate': oauth.wwwAuthenticate(req.headers.authorization ? 'invalid_token' : undefined, p, why.description), 'content-type': 'application/json' })
              .end(JSON.stringify({ error: 'unauthorized', reason: why.reason, error_description: why.description }));
            return;
          }
          userId = who.userId;
        }
        if (!userId) throw new Error('No account to act as: set up OAuth or PLUGIN_USER_EMAIL.');
        const body = req.method === 'POST' ? await readJson(req) : undefined;
        logRequest(req, res, body);
        if (opts.logBodies) console.log('  <-', JSON.stringify(body)?.slice(0, 1500));
        // ChatGPT speaks MCP 2026-07-28 (sessionless: server/discover, no initialize); the SDK speaks 2025-11-25.
        if (isDiscover(body)) {
          const level = opts.mcp?.level;
          const caps = level === 'minimal' || level === 'tools' ? { tools: { listChanged: true } } : SERVER_CAPABILITIES;
          return json(res, 200, discoverResult(body, serverInfo(version, opts.mcp?.local), caps, instructionsFor(version, opts.mcp?.local)));
        }
        // A client on the newer version must get `resultType` on every result (Claude Code refuses a tool result without it).
        const stateless = isStateless(req, body);
        presentAsSdkVersion(req);
        const mcp = createMcpServer(hub.forUser(userId), { bundle, publicUrl, ...opts.mcp, version });
        const transport = adaptTransport(new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: !process.env.PLUGIN_SSE }), serverInfo(version, opts.mcp?.local), stateless || !!process.env.PLUGIN_RESULT_TYPE_ALL);
        res.on('close', () => {
          void transport.close();
          void mcp.close();
        });
        await mcp.connect(transport);
        await transport.handleRequest(req, res, body);
        return;
      }

      // --- Imports from the app: the bytes come straight from the iframe with a ticket from upload_ticket ---
      if (p === '/plugin/import') {
        // The app runs on an opaque origin inside ChatGPT, so this one route answers any origin.
        res.setHeader('access-control-allow-origin', '*');
        res.setHeader('access-control-allow-headers', 'content-type');
        if (req.method === 'OPTIONS') {
          res.writeHead(204).end();
          return;
        }
        if (req.method !== 'POST') {
          res.writeHead(405).end();
          return;
        }
        const ticket = hub.redeemTicket(url.searchParams.get('ticket'));
        if (!ticket) return json(res, 401, { error: 'The upload ticket is missing, used or expired. Try again.' });
        const { userId } = ticket;
        // Videos and PDFs may be larger than the files that are converted.
        const limit = importLimit(url.searchParams.get('name') ?? undefined);
        if (Number(req.headers['content-length'] ?? 0) > limit) return json(res, 413, { error: `This file must be under ${limit / 1024 / 1024} MB.` });
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const c of req) {
          size += (c as Buffer).length;
          if (size > limit) return json(res, 413, { error: `This file must be under ${limit / 1024 / 1024} MB.` });
          chunks.push(c as Buffer);
        }
        try {
          const service = hub.forUser(userId);
          const bytes = Buffer.concat(chunks);
          const name = url.searchParams.get('name') ?? undefined;
          // image=1: a picture for a document, slide or cell (an edit from the image editor), stored as one.
          if (url.searchParams.get('image')) return json(res, 200, { src: await service.storeImage(String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase(), bytes) });
          // replace=<id>: an edited picture from the image editor, saved over the stored one.
          const replace = url.searchParams.get('replace');
          if (replace) return json(res, 200, { file: await service.saveImage(replace, bytes) });
          // convert=1: an Excel file's tabs for the open spreadsheet (File → Import), not a new file.
          if (url.searchParams.get('convert')) return json(res, 200, await service.convertExcel(bytes, name));
          const r = await service.importFile(bytes, name, url.searchParams.get('title') ?? undefined, ticket.folder);
          service.setOpen({ kind: r.file.kind, id: r.file.id });
          return json(res, 200, r);
        } catch (e) {
          if (e instanceof ToolError) return json(res, 400, { error: e.message });
          throw e;
        }
      }

      // --- Stored files (PDFs, videos) for the app's viewer: the token in the address is the credential ---
      if (p.startsWith('/plugin/file/')) {
        // The PDF viewer reads the file with fetch from an opaque origin, in ranges.
        res.setHeader('access-control-allow-origin', '*');
        res.setHeader('access-control-allow-headers', 'range');
        res.setHeader('access-control-expose-headers', 'accept-ranges, content-length, content-range');
        if (req.method === 'OPTIONS') {
          res.writeHead(204).end();
          return;
        }
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405).end();
          return;
        }
        const f = hub.fileForLink(url.searchParams.get('t'), p.slice('/plugin/file/'.length));
        if (!f || !existsSync(f.file)) {
          res.writeHead(404).end('Not found');
          return;
        }
        const size = statSync(f.file).size;
        // Browsers that play QuickTime files (H.264) only do so when they are served as MP4. Anything that is
        // not a PDF, an image or a video is never served under its own type.
        const type = f.meta.type === 'video/quicktime' ? 'video/mp4' : PREVIEW_FILE_TYPES.includes(f.meta.type) ? f.meta.type : 'application/octet-stream';
        const head = { 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=3600', 'x-content-type-options': 'nosniff' };
        // A Range request gets just that part of the file, which is what lets a video player seek.
        const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ''));
        if (!range || (!range[1] && !range[2])) {
          res.writeHead(200, { ...head, 'content-length': size });
          if (req.method === 'HEAD') res.end();
          else createReadStream(f.file).pipe(res);
          return;
        }
        const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
        const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
        if (start > end || start >= size) {
          res.writeHead(416, { 'content-range': `bytes */${size}` }).end();
          return;
        }
        res.writeHead(206, { ...head, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 });
        if (req.method === 'HEAD') res.end();
        else createReadStream(f.file, { start, end }).pipe(res);
        return;
      }

      // --- Images and the app's assets ---
      if (p.startsWith('/plugin/img/') && req.method === 'GET') {
        const img = hub.imageFile(p.slice('/plugin/img/'.length));
        if (!img || !existsSync(img.file)) {
          res.writeHead(404).end('Not found');
          return;
        }
        // Read with fetch by the image editor, from the app's opaque origin (the id in the address is the secret).
        res.writeHead(200, { 'content-type': img.type, 'content-length': statSync(img.file).size, 'cache-control': 'private, max-age=86400', 'access-control-allow-origin': '*' });
        createReadStream(img.file).pipe(res);
        return;
      }
      if ((p === '/plugin/app.js' || p === '/plugin/app.css') && req.method === 'GET') {
        const b = bundle();
        const js = p === '/plugin/app.js';
        res.writeHead(200, { 'content-type': js ? 'text/javascript; charset=utf-8' : 'text/css; charset=utf-8', 'cache-control': production ? 'public, max-age=3600' : 'no-cache', 'access-control-allow-origin': '*' }).end(js ? b.js : b.css);
        return;
      }
      if (p === '/plugin/health') return json(res, 200, { ok: true, auth: oauth ? 'oauth' : 'dev' });
      res.writeHead(404).end('Not found');
    } catch (e) {
      console.error(e);
      if (!res.headersSent) json(res, 500, { error: (e as Error).message });
      else res.end();
    }
  };
  return { handles: (pathname) => PLUGIN_PATH.test(pathname), handle };
}

/** The address a request came from: the proxy's view of the client when behind one (Caddy on AWS), else the socket's. */
function clientAddress(req: http.IncomingMessage): string {
  const real = req.headers['x-real-ip'];
  const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim();
  return (typeof real === 'string' && real.trim()) || forwarded || req.socket.remoteAddress || 'unknown';
}

/** A form body (application/x-www-form-urlencoded) or a JSON body, as flat strings. */
async function readForm(req: http.IncomingMessage): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  if ((req.headers['content-type'] ?? '').includes('application/json')) {
    try {
      const j = JSON.parse(text) as Record<string, unknown>;
      return Object.fromEntries(Object.entries(j).filter(([, v]) => typeof v === 'string') as [string, string][]);
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(text));
}

/** One line per request in the log (and the start of the response body when it was not a 2xx). */
function logRequest(req: http.IncomingMessage, res: http.ServerResponse, body: unknown): void {
  const started = Date.now();
  const rpc = body && typeof body === 'object' ? (body as { method?: string; params?: { name?: string } }) : null;
  let tail = '';
  const write = res.write.bind(res);
  const end = res.end.bind(res);
  const keep = (chunk: unknown) => {
    if (tail.length < 400 && chunk) tail += String(chunk).slice(0, 400 - tail.length);
  };
  res.write = ((chunk: unknown, ...rest: unknown[]) => {
    keep(chunk);
    return (write as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof res.write;
  res.end = ((chunk?: unknown, ...rest: unknown[]) => {
    keep(chunk);
    return (end as (...a: unknown[]) => http.ServerResponse)(chunk, ...rest);
  }) as typeof res.end;
  res.on('finish', () => {
    const what = rpc?.method ? `${rpc.method}${rpc.params?.name ? ` ${rpc.params.name}` : ''}` : '';
    const ua = String(req.headers['user-agent'] ?? '').slice(0, 24);
    const ver = req.headers['mcp-protocol-version'] ? ` v=${String(req.headers['mcp-protocol-version'])}` : '';
    const problem = res.statusCode >= 300 && res.statusCode !== 302 ? ` | ${tail.replace(/\s+/g, ' ').slice(0, 200)}` : '';
    console.log(`${new Date().toISOString().slice(11, 23)} ${req.method} ${req.url} ${what} -> ${res.statusCode} ${Date.now() - started}ms [${ua}${ver}]${problem}`);
  });
}
