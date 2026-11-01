// Sign-in for agents using the desktop app's MCP server (main.js serves it on a fixed port): OAuth 2.1 as MCP
// clients expect it (Claude Code, say). The client finds this server from the 401 on /mcp, registers itself,
// and opens /oauth/authorize in the browser. The person approves it in the app, in a native dialog, not on
// the web page: another program on the computer could press a button on a page, not the app's dialog. The
// page waits for the answer and then sends the browser on to the client with a code, which the client trades
// (with its PKCE verifier) for a token. Each agent has its own tokens, kept in a file only the user can read,
// so each can be disconnected.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const ACCESS_MS = 30 * 24 * 60 * 60 * 1000;
const CODE_MS = 5 * 60 * 1000;
const PENDING_MS = 10 * 60 * 1000;

const sha = (s) => createHash('sha256').update(s).digest('base64url');
const newSecret = () => randomBytes(32).toString('base64url');

/** A name a client gave itself, fit to show: one short line. */
export function clientName(name) {
  const clean = String(name ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return clean || 'An agent';
}

/** Where an authorization may send its code: back to a program on this computer (a loopback address or an app's own scheme). */
export function allowedRedirect(uri) {
  let u;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.protocol === 'http:') return ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (u.protocol === 'https:') return false;
  // A custom scheme (cursor://, vscode://) opens an app on this computer; never a script.
  return /^[a-z][a-z0-9+.-]*:$/.test(u.protocol) && !['javascript:', 'data:', 'file:', 'blob:', 'about:'].includes(u.protocol);
}

/** The redirect address for a code (or an error), with the client's state. */
function withParams(uri, params) {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
  return u.toString();
}

export class LocalOAuth {
  /**
   * @param {{ file: string, issuer: string, approve: (name: string) => Promise<boolean>, now?: () => number }} opts
   * `issuer` is the server's origin (http://127.0.0.1:<port>); `approve` asks the person.
   */
  constructor(opts) {
    this.file = opts.file;
    this.issuer = opts.issuer;
    this.approve = opts.approve;
    this.now = opts.now ?? Date.now;
    /** Authorizations waiting for the person, by id. */
    this.pending = new Map();
    /** Codes not yet traded for a token, by code. */
    this.codes = new Map();
    this.state = { clients: {}, access: {}, refresh: {} };
    try {
      const saved = JSON.parse(readFileSync(this.file, 'utf8'));
      this.state = { clients: saved.clients ?? {}, access: saved.access ?? {}, refresh: saved.refresh ?? {} };
    } catch {
      // None yet.
    }
  }

  save() {
    const now = this.now();
    for (const [k, v] of Object.entries(this.state.access)) if (v.expires < now) delete this.state.access[k];
    writeFileSync(this.file, JSON.stringify(this.state), { mode: 0o600 });
  }

  /** The MCP endpoint's metadata (RFC 9728): where to sign in. */
  get resourceMetadataUrl() {
    return `${this.issuer}/.well-known/oauth-protected-resource`;
  }

  /** The agents approved, with the time each was. */
  clients() {
    const signedIn = new Set([...Object.values(this.state.access), ...Object.values(this.state.refresh)].map((t) => t.clientId));
    return Object.entries(this.state.clients)
      .filter(([id, c]) => c.approved && signedIn.has(id))
      .map(([id, c]) => ({ id, name: c.name, approved: c.approved }));
  }

  /** Disconnect one agent: its tokens stop working, and it must be approved again. False if there is no such agent. */
  revoke(id) {
    if (!this.state.clients[id]) return false;
    delete this.state.clients[id];
    for (const tokens of [this.state.access, this.state.refresh]) for (const [k, t] of Object.entries(tokens)) if (t.clientId === id) delete tokens[k];
    for (const [code, c] of this.codes) if (c.clientId === id) this.codes.delete(code);
    this.save();
    return true;
  }

  /** Disconnect every agent: their tokens stop working, and each must be approved again. */
  revokeAll() {
    this.state = { clients: {}, access: {}, refresh: {} };
    this.codes.clear();
    this.save();
  }

  /** The agent an Authorization header is from, or null. */
  verify(header) {
    const token = /^Bearer\s+(.+)$/i.exec(header ?? '')?.[1]?.trim();
    if (!token) return null;
    const t = this.state.access[sha(token)];
    if (!t || t.expires < this.now()) return null;
    return this.state.clients[t.clientId]?.name ?? null;
  }

  /** True for the paths this serves. */
  handles(pathname) {
    return pathname.startsWith('/oauth/') || /^(\/mcp)?\/\.well-known\/(oauth-protected-resource|oauth-authorization-server|openid-configuration)(\/mcp)?$/.test(pathname);
  }

  /** Answer one request on a path this handles. */
  async handle(req, res) {
    const url = new URL(req.url ?? '/', this.issuer);
    const p = url.pathname;
    const json = (status, body) => res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }).end(JSON.stringify(body));
    const page = (status, title, body, script = '') =>
      res
        .writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'" })
        .end(
          `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>body{font:15px/1.5 -apple-system,system-ui,sans-serif;color:#202124;max-width:520px;margin:15vh auto;padding:0 20px}h1{font-size:22px;font-weight:500}p{color:#5f6368}</style></head><body><h1>${esc(title)}</h1>${body}${script ? `<script>${script}</script>` : ''}</body></html>`,
        );

    if (/oauth-protected-resource/.test(p) && req.method === 'GET') {
      return json(200, { resource: `${this.issuer}/mcp`, authorization_servers: [this.issuer], bearer_methods_supported: ['header'], resource_name: 'MCP Docs' });
    }
    if (/(oauth-authorization-server|openid-configuration)/.test(p) && req.method === 'GET') {
      return json(200, {
        issuer: this.issuer,
        authorization_endpoint: `${this.issuer}/oauth/authorize`,
        token_endpoint: `${this.issuer}/oauth/token`,
        registration_endpoint: `${this.issuer}/oauth/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      });
    }

    // Dynamic client registration (RFC 7591): any program may register; nothing works until the person approves it.
    if (p === '/oauth/register' && req.method === 'POST') {
      // JSON only: a web page cannot send it to this address without the browser asking first (CORS), and it is not let.
      if (!String(req.headers['content-type'] ?? '').includes('application/json')) return json(415, { error: 'invalid_request', error_description: 'Send the registration as JSON.' });
      const body = await readBody(req);
      const uris = Array.isArray(body?.redirect_uris) ? body.redirect_uris.filter((u) => typeof u === 'string') : [];
      if (!uris.length || !uris.every(allowedRedirect)) return json(400, { error: 'invalid_redirect_uri', error_description: 'Redirect addresses must be on this computer (http://localhost or http://127.0.0.1, or an app’s own scheme).' });
      const id = newSecret().slice(0, 22);
      const name = clientName(body.client_name);
      this.state.clients[id] = { name, redirectUris: uris, created: new Date(this.now()).toISOString() };
      this.save();
      return json(201, { client_id: id, client_name: name, redirect_uris: uris, token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] });
    }

    if (p === '/oauth/authorize' && req.method === 'GET') {
      const q = Object.fromEntries(url.searchParams);
      let client = this.state.clients[q.client_id];
      // An agent registered before the app's data was removed (an uninstall) still signs in with the id it was given:
      // it is taken in again at its address on this computer, and the person is asked, as for any new agent.
      if (!client && typeof q.client_id === 'string' && /^[\w.-]{8,100}$/.test(q.client_id) && typeof q.redirect_uri === 'string' && allowedRedirect(q.redirect_uri)) {
        client = this.state.clients[q.client_id] = { name: 'An agent that was connected before', redirectUris: [q.redirect_uri], created: new Date(this.now()).toISOString() };
        this.save();
      }
      // A request that names no known client or address is never sent anywhere: the address may not be the client's.
      if (!client) return page(400, 'Unknown agent', '<p>This sign-in link is from an agent the app does not know. Start the connection again from the agent.</p>');
      const redirect = q.redirect_uri ?? (client.redirectUris.length === 1 ? client.redirectUris[0] : undefined);
      if (!redirect || !client.redirectUris.includes(redirect)) return page(400, 'Wrong address', '<p>This sign-in link does not match the agent that registered. Start the connection again from the agent.</p>');
      const fail = (error, description) => {
        res.writeHead(302, { location: withParams(redirect, { error, error_description: description, state: q.state }) }).end();
      };
      if (q.response_type !== 'code') return fail('unsupported_response_type', 'Only the code flow is supported.');
      if (!q.code_challenge || q.code_challenge_method !== 'S256') return fail('invalid_request', 'PKCE with S256 is required.');
      const id = newSecret();
      const pending = { clientId: q.client_id, redirect, challenge: q.code_challenge, state: q.state, expires: this.now() + PENDING_MS, result: null };
      this.pending.set(id, pending);
      // The page waits for the person's answer in the app, then goes on to the agent.
      this.approve(client.name).then(
        (ok) => {
          if (!ok) return (pending.result = withParams(redirect, { error: 'access_denied', error_description: 'The connection was not allowed.', state: q.state }));
          const code = newSecret();
          this.codes.set(code, { clientId: q.client_id, redirect, challenge: q.code_challenge, expires: this.now() + CODE_MS });
          client.approved = new Date(this.now()).toISOString();
          this.save();
          pending.result = withParams(redirect, { code, state: q.state });
        },
        () => (pending.result = withParams(redirect, { error: 'server_error', state: q.state })),
      );
      return page(
        200,
        `Connect “${client.name}” to MCP Docs`,
        '<p id="msg">Allow or deny the connection in the MCP Docs app. This page goes on by itself when you answer.</p>',
        `const go=async()=>{try{const r=await fetch('/oauth/wait?p=${encodeURIComponent(id)}');const j=await r.json();if(j.redirect){document.getElementById('msg').textContent=j.denied?'Not allowed. You can close this page.':'Connected. You can close this page and go back to the agent.';location.href=j.redirect;return}if(j.gone){document.getElementById('msg').textContent='This request has expired. Start the connection again from the agent.';return}}catch{}setTimeout(go,1000)};go();`,
      );
    }

    if (p === '/oauth/wait' && req.method === 'GET') {
      const id = url.searchParams.get('p') ?? '';
      const pending = this.pending.get(id);
      if (!pending || pending.expires < this.now()) {
        this.pending.delete(id);
        return json(200, { gone: true });
      }
      if (!pending.result) return json(200, { waiting: true });
      this.pending.delete(id);
      return json(200, { redirect: pending.result, denied: pending.result.includes('error=access_denied') });
    }

    if (p === '/oauth/token' && req.method === 'POST') {
      const body = await readBody(req);
      const bad = (description) => json(400, { error: 'invalid_grant', error_description: description });
      if (body?.grant_type === 'authorization_code') {
        const code = this.codes.get(String(body.code ?? ''));
        this.codes.delete(String(body.code ?? ''));
        if (!code || code.expires < this.now()) return bad('The code is unknown, used or expired.');
        if (body.client_id && body.client_id !== code.clientId) return bad('The code is for another client.');
        if (body.redirect_uri && body.redirect_uri !== code.redirect) return bad('The redirect address does not match.');
        if (!body.code_verifier || !safeEqual(sha(String(body.code_verifier)), code.challenge)) return bad('The code verifier does not match.');
        return json(200, this.issue(code.clientId));
      }
      if (body?.grant_type === 'refresh_token') {
        const key = sha(String(body.refresh_token ?? ''));
        const r = this.state.refresh[key];
        if (!r || !this.state.clients[r.clientId] || (body.client_id && body.client_id !== r.clientId)) return bad('The refresh token is unknown or was revoked.');
        delete this.state.refresh[key];
        return json(200, this.issue(r.clientId));
      }
      return json(400, { error: 'unsupported_grant_type' });
    }

    return json(404, { error: 'not_found' });
  }

  /** New tokens for an approved client. */
  issue(clientId) {
    const access = newSecret();
    const refresh = newSecret();
    this.state.access[sha(access)] = { clientId, expires: this.now() + ACCESS_MS };
    this.state.refresh[sha(refresh)] = { clientId };
    this.save();
    return { access_token: access, token_type: 'Bearer', expires_in: Math.round(ACCESS_MS / 1000), refresh_token: refresh };
  }
}

function safeEqual(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** A request's JSON or form body (token requests are forms, registration is JSON). */
async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 64 * 1024) return null;
    chunks.push(c);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  const type = String(req.headers['content-type'] ?? '');
  try {
    if (type.includes('application/json')) return JSON.parse(text);
    return Object.fromEntries(new URLSearchParams(text));
  } catch {
    return null;
  }
}
