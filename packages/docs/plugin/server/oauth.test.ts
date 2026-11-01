import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthService, hashPassword } from '../../server/auth.ts';
import { openDb } from '../../server/db.ts';
import { FileHub } from './files.ts';
import { createPluginServer } from './http.ts';
import { DEVICE_GRANT, OAuthServer, redirectMatches } from './oauth.ts';

const CLIENT_DOC_URL = 'https://chatgpt.example/oauth/client.json';
const REDIRECT = 'https://chatgpt.example/connector/callback';

let dir: string;
let base: string;
let close: () => Promise<void>;
let oauth: OAuthServer;

/** Serves the client metadata document; everything else is refused. */
const fakeFetch: typeof fetch = async (input) => {
  const url = typeof input === 'string' ? input : (input as URL).toString();
  if (url === CLIENT_DOC_URL) return new Response(JSON.stringify({ client_id: CLIENT_DOC_URL, client_name: 'ChatGPT', redirect_uris: [REDIRECT] }), { headers: { 'content-type': 'application/json' } });
  return new Response('nope', { status: 404 });
};

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'docs-oauth-'));
  const db = openDb(path.join(dir, 'app.db'));
  db.prepare('INSERT INTO users (id, email, password_hash, email_verified_at, created_at) VALUES (?, ?, ?, ?, ?)').run('u1', 'a@example.com', await hashPassword('secret-pw'), new Date().toISOString(), new Date().toISOString());
  const hub = new FileHub({ db, dataDir: dir, publicUrl: null });
  await hub.init();
  await hub.forUser('u1').createDoc('Mine', 'Hello.\n');
  oauth = new OAuthServer({ db: new DatabaseSync(path.join(dir, 'plugin.db')), issuer: 'https://plugin.example', resource: 'https://plugin.example/mcp', auth: new AuthService(db), profile: (id) => hub.profile(id), fetchFn: fakeFetch });
  const server = createPluginServer({ hub, oauth, publicUrl: null, webDir: dir, production: true });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => new Promise((r) => server.close(() => r()));
});

afterEach(async () => {
  await close();
  await rm(dir, { recursive: true, force: true });
});

const form = (body: Record<string, string>) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString(), redirect: 'manual' as const });
const mcp = (token: string | null, body: unknown, endpoint = '/mcp') =>
  fetch(`${base}${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });

/** The whole browser side of the code flow with PKCE, as ChatGPT would drive it. */
async function obtainCode(opts: { clientId?: string; verifier: string; signIn?: (pendingId: string) => Promise<void>; resource?: string } = { verifier: 'v' }) {
  const clientId = opts.clientId ?? CLIENT_DOC_URL;
  const challenge = createHash('sha256').update(opts.verifier).digest('base64url');
  const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', scope: 'files:read files:write', state: 'st8', resource: opts.resource ?? 'https://plugin.example/mcp' });
  const page = await fetch(`${base}/oauth/authorize?${q}`);
  expect(page.status).toBe(200);
  const htmlText = await page.text();
  // No mailer here, so nobody can be sent a verification link: creating an account is not offered.
  expect(htmlText).not.toContain('Create an account');
  const pendingId = /name="p" value="([^"]+)"/.exec(htmlText)![1];
  if (opts.signIn) await opts.signIn(pendingId);
  else {
    const login = await fetch(`${base}/oauth/login`, form({ p: pendingId, email: 'a@example.com', password: 'secret-pw' }));
    expect(login.status).toBe(302);
    expect(login.headers.get('location')).toBe(`/oauth/consent?p=${encodeURIComponent(pendingId)}`);
  }
  const consent = await fetch(`${base}/oauth/consent?p=${pendingId}`);
  expect(await consent.text()).toContain('a@example.com');
  const decision = await fetch(`${base}/oauth/decision`, form({ p: pendingId, allow: 'yes' }));
  expect(decision.status).toBe(302);
  const back = new URL(decision.headers.get('location')!);
  expect(back.origin + back.pathname).toBe(REDIRECT);
  expect(back.searchParams.get('state')).toBe('st8');
  expect(back.searchParams.get('iss')).toBe('https://plugin.example');
  return { code: back.searchParams.get('code')!, clientId };
}

describe('OAuth', () => {
  it('publishes discovery documents at every path ChatGPT probes', async () => {
    for (const p of ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp', '/mcp/.well-known/oauth-protected-resource']) {
      const r = await fetch(base + p).then((r) => r.json());
      expect(r).toMatchObject({ resource: 'https://plugin.example/mcp', authorization_servers: ['https://plugin.example'] });
    }
    for (const p of ['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration', '/.well-known/oauth-authorization-server/mcp']) {
      const r = await fetch(base + p).then((r) => r.json());
      expect(r).toMatchObject({ issuer: 'https://plugin.example', code_challenge_methods_supported: ['S256'], client_id_metadata_document_supported: true, authorization_response_iss_parameter_supported: true });
    }
  });

  it('refuses the MCP endpoint without a token, pointing at the resource metadata', async () => {
    const r = await mcp(null, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toContain('resource_metadata="https://plugin.example/.well-known/oauth-protected-resource/mcp"');
    const bad = await mcp('nope', { jsonrpc: '2.0', id: 1, method: 'tools/list' });
    expect(bad.headers.get('www-authenticate')).toContain('error="invalid_token"');
  });

  it('serves a newer version of the tools at /mcp/v2 as a resource of its own, with the same accounts', async () => {
    for (const p of ['/.well-known/oauth-protected-resource/mcp/v2', '/mcp/v2/.well-known/oauth-protected-resource']) {
      expect(await fetch(base + p).then((r) => r.json())).toMatchObject({ resource: 'https://plugin.example/mcp/v2', authorization_servers: ['https://plugin.example'] });
    }
    expect((await fetch(`${base}/.well-known/oauth-protected-resource/mcp/v9`)).status).toBe(404);
    const refused = await mcp(null, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, '/mcp/v2');
    expect(refused.status).toBe(401);
    expect(refused.headers.get('www-authenticate')).toContain('resource_metadata="https://plugin.example/.well-known/oauth-protected-resource/mcp/v2"');

    const { code } = await obtainCode({ verifier: 'versioned-verifier-1234567890', resource: 'https://plugin.example/mcp/v2' });
    const tokens = await fetch(`${base}/oauth/token`, form({ grant_type: 'authorization_code', code, code_verifier: 'versioned-verifier-1234567890', redirect_uri: REDIRECT, client_id: CLIENT_DOC_URL, resource: 'https://plugin.example/mcp/v2' })).then((r) => r.json());
    const names = async (endpoint: string) => ((await mcp(tokens.access_token, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, endpoint).then((r) => r.json())).result.tools as { name: string }[]).map((t) => t.name);
    expect(await names('/mcp/v2')).toContain('read_file');
    expect(await names('/mcp')).not.toContain('read_file');
    expect((await mcp(tokens.access_token, { jsonrpc: '2.0', id: 1, method: 'tools/list' }, '/mcp/v9')).status).toBe(404);
    // A resource that is not one of the endpoints is refused.
    const challenge = createHash('sha256').update('x').digest('base64url');
    const other = await fetch(`${base}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: CLIENT_DOC_URL, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', resource: 'https://plugin.example/mcp/other' })}`, { redirect: 'manual' });
    expect(new URL(other.headers.get('location')!).searchParams.get('error')).toBe('invalid_target');
  });

  it('runs the code flow with a client metadata document and PKCE, then serves that account', async () => {
    const { code } = await obtainCode({ verifier: 'the-verifier-value-1234567890' });
    const wrong = await fetch(`${base}/oauth/token`, form({ grant_type: 'authorization_code', code, code_verifier: 'wrong', redirect_uri: REDIRECT, client_id: CLIENT_DOC_URL }));
    expect(wrong.status).toBe(400);
    expect((await wrong.json()).error).toBe('invalid_grant');
    const ok = await fetch(`${base}/oauth/token`, form({ grant_type: 'authorization_code', code, code_verifier: 'the-verifier-value-1234567890', redirect_uri: REDIRECT, client_id: CLIENT_DOC_URL, resource: 'https://plugin.example/mcp' }));
    expect(ok.status).toBe(200);
    const tokens = (await ok.json()) as { access_token: string; refresh_token: string; token_type: string; scope: string };
    expect(tokens.token_type).toBe('Bearer');
    expect(tokens.scope).toBe('files:read files:write');
    const files = await mcp(tokens.access_token, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_files', arguments: {} } }).then((r) => r.json());
    expect((files.result.structuredContent.files as { title: string }[]).map((f) => f.title)).toEqual(['Mine']);
    const profile = await mcp(tokens.access_token, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_profile', arguments: {} } }).then((r) => r.json());
    expect(profile.result.structuredContent).toEqual({ id: 'a@example.com', email: 'a@example.com', name: 'a@example.com' });
    // The code is single use; replaying it kills what it issued.
    const replay = await fetch(`${base}/oauth/token`, form({ grant_type: 'authorization_code', code, code_verifier: 'the-verifier-value-1234567890', redirect_uri: REDIRECT }));
    expect(replay.status).toBe(400);
    expect((await mcp(tokens.access_token, { jsonrpc: '2.0', id: 3, method: 'tools/list' })).status).toBe(401);
  });

  it('rotates refresh tokens and revokes a family on reuse or revocation', async () => {
    const { code } = await obtainCode({ verifier: 'another-verifier-value-123456' });
    const first = (await fetch(`${base}/oauth/token`, form({ grant_type: 'authorization_code', code, code_verifier: 'another-verifier-value-123456' })).then((r) => r.json())) as { access_token: string; refresh_token: string };
    const second = await fetch(`${base}/oauth/token`, form({ grant_type: 'refresh_token', refresh_token: first.refresh_token })).then((r) => r.json());
    expect(second.access_token).not.toBe(first.access_token);
    expect((await mcp(second.access_token, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(200);
    const reuse = await fetch(`${base}/oauth/token`, form({ grant_type: 'refresh_token', refresh_token: first.refresh_token }));
    expect(reuse.status).toBe(400);
    expect((await mcp(second.access_token, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(401);
    const { code: code2 } = await obtainCode({ verifier: 'third-verifier-value-1234567' });
    const third = (await fetch(`${base}/oauth/token`, form({ grant_type: 'authorization_code', code: code2, code_verifier: 'third-verifier-value-1234567' })).then((r) => r.json())) as { access_token: string; refresh_token: string };
    expect((await fetch(`${base}/oauth/revoke`, form({ token: third.refresh_token }))).status).toBe(200);
    expect((await mcp(third.access_token, { jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(401);
  });

  it('lets an app on this computer come back on any port, and only there', () => {
    const registered = 'http://localhost/callback';
    expect(redirectMatches(registered, 'http://localhost:53712/callback')).toBe(true);
    expect(redirectMatches(registered, 'http://localhost/callback')).toBe(true);
    expect(redirectMatches('http://127.0.0.1/callback', 'http://127.0.0.1:8080/callback')).toBe(true);
    for (const other of ['http://localhost:53712/other', 'http://127.0.0.1:53712/callback', 'http://localhost.evil.example:53712/callback', 'https://localhost:53712/callback', 'http://user@localhost:53712/callback', 'http://localhost:53712/callback?x=1', 'not a url']) {
      expect(redirectMatches(registered, other)).toBe(false);
    }
    // Anything that is not a loopback address must match exactly.
    expect(redirectMatches('https://claude.example/cb', 'https://claude.example:8443/cb')).toBe(false);
    expect(redirectMatches('https://claude.example/cb', 'https://claude.example/cb')).toBe(true);
  });

  it('registers clients dynamically and checks their redirect URIs', async () => {
    const reg = await fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Claude', redirect_uris: ['https://claude.example/cb'], token_endpoint_auth_method: 'none' }) });
    expect(reg.status).toBe(201);
    const client = (await reg.json()) as { client_id: string };
    const bad = await fetch(`${base}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: 'https://evil.example/cb', code_challenge: 'x', code_challenge_method: 'S256' })}`);
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain('not registered');
    const page = await fetch(`${base}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: 'https://claude.example/cb', code_challenge: 'x', code_challenge_method: 'S256' })}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('Claude');
  });

  it('sends parameter problems back to a genuine client as redirects, and rejects wrong passwords and denials', async () => {
    const noPkce = await fetch(`${base}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: CLIENT_DOC_URL, redirect_uri: REDIRECT, state: 's' })}`, { redirect: 'manual' });
    expect(noPkce.status).toBe(302);
    const loc = new URL(noPkce.headers.get('location')!);
    expect(loc.searchParams.get('error')).toBe('invalid_request');
    expect(loc.searchParams.get('state')).toBe('s');
    const q = new URLSearchParams({ response_type: 'code', client_id: CLIENT_DOC_URL, redirect_uri: REDIRECT, code_challenge: 'c', code_challenge_method: 'S256' });
    const pendingId = /name="p" value="([^"]+)"/.exec(await fetch(`${base}/oauth/authorize?${q}`).then((r) => r.text()))![1];
    const wrong = await fetch(`${base}/oauth/login`, form({ p: pendingId, email: 'a@example.com', password: 'nope' }));
    expect(await wrong.text()).toContain('Wrong email or password');
    const consentTooEarly = await fetch(`${base}/oauth/consent?p=${pendingId}`).then((r) => r.text());
    expect(consentTooEarly).toContain('expired');
    await fetch(`${base}/oauth/login`, form({ p: pendingId, email: 'a@example.com', password: 'secret-pw' }));
    const deny = await fetch(`${base}/oauth/decision`, form({ p: pendingId, allow: 'no' }));
    expect(new URL(deny.headers.get('location')!).searchParams.get('error')).toBe('access_denied');
  });
});

describe('Device sign-in', () => {
  const V2 = 'https://plugin.example/mcp/v2';
  const list = { jsonrpc: '2.0', id: 1, method: 'tools/list' };

  /** Registers as mcp-remote --device-code does: device and refresh grants, and a loopback redirect it never uses. */
  async function register() {
    const reg = await fetch(`${base}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'mcp-remote', redirect_uris: ['http://localhost:4123/oauth/callback'], grant_types: [DEVICE_GRANT, 'refresh_token'], token_endpoint_auth_method: 'none' }) });
    expect(reg.status).toBe(201);
    const client = (await reg.json()) as { client_id: string; grant_types: string[] };
    expect(client.grant_types).toEqual([DEVICE_GRANT, 'refresh_token']);
    return client.client_id;
  }
  const start = (clientId: string, resource = V2) => fetch(`${base}/oauth/device_authorization`, form({ client_id: clientId, scope: 'files:read files:write', resource }));
  const poll = (clientId: string, deviceCode: string) => fetch(`${base}/oauth/token`, form({ grant_type: DEVICE_GRANT, device_code: deviceCode, client_id: clientId, resource: V2 }));
  /** The person's side: enter the code, sign in, allow or deny. Returns where the decision sent the browser. */
  async function approve(userCode: string, allow = true) {
    const entered = await fetch(`${base}/oauth/device`, form({ code: userCode.toLowerCase().replace('-', ' ') }));
    const pendingId = /name="p" value="([^"]+)"/.exec(await entered.text())![1];
    await fetch(`${base}/oauth/login`, form({ p: pendingId, email: 'a@example.com', password: 'secret-pw' }));
    const consent = await fetch(`${base}/oauth/consent?p=${pendingId}`).then((r) => r.text());
    expect(consent).toContain('Only allow this if you started this sign-in yourself');
    expect(consent).toContain('"mcp-remote" is the name the agent gave itself');
    const decision = await fetch(`${base}/oauth/decision`, form({ p: pendingId, allow: allow ? 'yes' : 'no' }));
    return decision.headers.get('location');
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it('is advertised in the authorization server metadata', async () => {
    const r = await fetch(`${base}/.well-known/oauth-authorization-server`).then((r) => r.json());
    expect(r.device_authorization_endpoint).toBe('https://plugin.example/oauth/device_authorization');
    expect(r.grant_types_supported).toContain(DEVICE_GRANT);
  });

  it('signs an agent in with a code the person enters, for /mcp/v2 only', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    const clientId = await register();
    const issued = await start(clientId).then((r) => r.json());
    expect(issued).toMatchObject({ verification_uri: 'https://plugin.example/oauth/device', expires_in: 600, interval: 5 });
    expect(issued.user_code).toMatch(/^[B-Z]{4}-[B-Z]{4}$/);
    expect(issued).not.toHaveProperty('verification_uri_complete');

    const pending = await poll(clientId, issued.device_code);
    expect(pending.status).toBe(400);
    expect((await pending.json()).error).toBe('authorization_pending');
    expect((await poll(clientId, issued.device_code).then((r) => r.json())).error).toBe('slow_down');

    expect(await approve(issued.user_code)).toBe('/oauth/device/done?ok=1');
    expect(await fetch(`${base}/oauth/device/done?ok=1`).then((r) => r.text())).toContain('Agent connected');
    vi.setSystemTime(Date.now() + 10_000);
    const tokens = await poll(clientId, issued.device_code).then((r) => r.json());
    expect(tokens.token_type).toBe('Bearer');
    // A week, not the code flow's hour: an agent working by hand may never refresh.
    expect(tokens.expires_in).toBe(7 * 24 * 60 * 60);
    expect((await mcp(tokens.access_token, list, '/mcp/v2')).status).toBe(200);
    // Version 1 is what ChatGPT reviewed: a device sign-in never reaches it, and is told where to go.
    const v1 = await mcp(tokens.access_token, list, '/mcp');
    expect(v1.status).toBe(401);
    expect(await v1.json()).toMatchObject({ error: 'unauthorized', reason: 'wrong_endpoint', error_description: 'This access token is for https://plugin.example/mcp/v2; send your requests there.' });
    // The device code is spent.
    vi.setSystemTime(Date.now() + 10_000);
    expect((await poll(clientId, issued.device_code).then((r) => r.json())).error).toBe('invalid_grant');
    // Refreshed tokens stay bound to /mcp/v2.
    const refreshed = await fetch(`${base}/oauth/token`, form({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, resource: V2 })).then((r) => r.json());
    expect((await mcp(refreshed.access_token, list, '/mcp/v2')).status).toBe(200);
    expect((await mcp(refreshed.access_token, list, '/mcp')).status).toBe(401);

    // After the week, the refusal says to refresh (not to sign in again), and refreshing works.
    vi.setSystemTime(Date.now() + 8 * 24 * 60 * 60 * 1000);
    const late = await mcp(refreshed.access_token, list, '/mcp/v2');
    expect(late.status).toBe(401);
    expect(late.headers.get('www-authenticate')).toContain('error_description="This access token has expired.');
    const why = await late.json();
    expect(why.reason).toBe('expired');
    expect(why.error_description).toContain('POST https://plugin.example/oauth/token as a form with grant_type=refresh_token');
    const again = await fetch(`${base}/oauth/token`, form({ grant_type: 'refresh_token', refresh_token: refreshed.refresh_token, client_id: clientId })).then((r) => r.json());
    expect((await mcp(again.access_token, list, '/mcp/v2')).status).toBe(200);
    // The other refusals name themselves too.
    const reason = async (token: string | null) => (await (await mcp(token, list, '/mcp/v2')).json()).reason;
    expect(await reason(null)).toBe('no_token');
    expect(await reason('nope')).toBe('unknown_token');
    expect(await reason(again.refresh_token)).toBe('refresh_token_sent');
    expect(await reason(refreshed.access_token)).toBe('expired');
    oauth.disconnectAgent('u1', oauth.connectedAgents('u1')[0].id);
    expect(await reason(again.access_token)).toBe('revoked');
  });

  it('refuses /mcp as the resource, and tells the agent when the person declines or the code expires', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    const clientId = await register();
    for (const resource of ['https://plugin.example/mcp', 'https://plugin.example/other', '']) {
      const r = await start(clientId, resource);
      expect(r.status).toBe(400);
      expect((await r.json()).error).toBe('invalid_target');
    }
    expect((await start('nobody').then((r) => r.json())).error).toBe('invalid_client');

    const denied = await start(clientId).then((r) => r.json());
    expect(await approve(denied.user_code, false)).toBe('/oauth/device/done');
    expect((await poll(clientId, denied.device_code).then((r) => r.json())).error).toBe('access_denied');

    const late = await start(clientId).then((r) => r.json());
    vi.setSystemTime(Date.now() + 11 * 60 * 1000);
    expect((await poll(clientId, late.device_code).then((r) => r.json())).error).toBe('expired_token');
    expect(await fetch(`${base}/oauth/device`, form({ code: late.user_code })).then((r) => r.text())).toContain("That code isn&#39;t right");
  });

  it('stops an address that keeps entering wrong codes', async () => {
    const clientId = await register();
    const issued = await start(clientId).then((r) => r.json());
    for (let i = 0; i < 10; i++) expect(await fetch(`${base}/oauth/device`, form({ code: 'BBBB-BBBB' })).then((r) => r.text())).toContain("That code isn&#39;t right");
    expect(await fetch(`${base}/oauth/device`, form({ code: issued.user_code })).then((r) => r.text())).toContain('Too many wrong codes');
  });
});
