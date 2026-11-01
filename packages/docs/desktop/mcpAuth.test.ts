import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { allowedRedirect, clientName, LocalOAuth } from './mcpAuth.js';

let dir: string;
let server: http.Server;
let origin: string;
let auth: LocalOAuth;
let answer: boolean;
const asked: string[] = [];

beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'mcp-auth-'));
  answer = true;
  asked.length = 0;
  server = http.createServer((req, res) => void auth.handle(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  origin = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  auth = new LocalOAuth({
    file: path.join(dir, 'mcp-auth.json'),
    issuer: origin,
    approve: async (name: string) => {
      asked.push(name);
      return answer;
    },
  });
});

afterEach(async () => {
  await new Promise((r) => server.close(r));
  rmSync(dir, { recursive: true, force: true });
});

const REDIRECT = 'http://localhost:7777/callback';
const VERIFIER = 'a-verifier-of-enough-length-0123456789-abcdefghij';
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');

async function register(body: unknown = { client_name: 'Claude Code (mcp-docs)', redirect_uris: [REDIRECT] }) {
  return fetch(`${origin}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

/** Open the authorize page, wait for the person's answer, and return where the browser is sent. */
async function authorize(clientId: string, extra: Record<string, string> = {}) {
  const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: CHALLENGE, code_challenge_method: 'S256', state: 'xyz', ...extra });
  const page = await fetch(`${origin}/oauth/authorize?${q}`, { redirect: 'manual' });
  if (page.status === 302) return new URL(page.headers.get('location')!);
  const id = /wait\?p=([^']+)'/.exec(await page.text())![1];
  for (;;) {
    const r = (await (await fetch(`${origin}/oauth/wait?p=${id}`)).json()) as { redirect?: string; waiting?: boolean };
    if (r.redirect) return new URL(r.redirect);
    await new Promise((res) => setTimeout(res, 5));
  }
}

const token = (body: Record<string, string>) => fetch(`${origin}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body) });

describe('signing in agents to the desktop app', () => {
  it('tells a client where to sign in', async () => {
    const prm = await (await fetch(`${origin}/.well-known/oauth-protected-resource/mcp`)).json();
    expect(prm).toMatchObject({ resource: `${origin}/mcp`, authorization_servers: [origin] });
    const as = await (await fetch(`${origin}/.well-known/oauth-authorization-server`)).json();
    expect(as).toMatchObject({ authorization_endpoint: `${origin}/oauth/authorize`, token_endpoint: `${origin}/oauth/token`, registration_endpoint: `${origin}/oauth/register`, code_challenge_methods_supported: ['S256'] });
  });

  it('gives an agent the person approves its own token, which can be refreshed and revoked', async () => {
    const { client_id } = await (await register()).json();
    const back = await authorize(client_id);
    expect(asked).toEqual(['Claude Code (mcp-docs)']);
    expect(back.origin + back.pathname).toBe(REDIRECT);
    expect(back.searchParams.get('state')).toBe('xyz');
    const code = back.searchParams.get('code')!;

    const res = await token({ grant_type: 'authorization_code', code, code_verifier: VERIFIER, client_id, redirect_uri: REDIRECT });
    expect(res.status).toBe(200);
    const t = await res.json();
    expect(auth.verify(`Bearer ${t.access_token}`)).toBe('Claude Code (mcp-docs)');
    expect(auth.verify('Bearer nope')).toBeNull();
    // A code works once.
    expect((await token({ grant_type: 'authorization_code', code, code_verifier: VERIFIER, client_id })).status).toBe(400);

    const refreshed = await (await token({ grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id })).json();
    expect(auth.verify(`Bearer ${refreshed.access_token}`)).toBe('Claude Code (mcp-docs)');
    expect(auth.clients().map((c) => c.name)).toEqual(['Claude Code (mcp-docs)']);

    // Kept across restarts, in a file only the user can read, with no token in it as it was given.
    const file = path.join(dir, 'mcp-auth.json');
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600); // Windows has no such modes
    expect(readFileSync(file, 'utf8')).not.toContain(refreshed.access_token);
    const again = new LocalOAuth({ file, issuer: origin, approve: async () => true });
    expect(again.verify(`Bearer ${refreshed.access_token}`)).toBe('Claude Code (mcp-docs)');

    expect(auth.revoke('nope')).toBe(false);
    expect(auth.revoke(client_id)).toBe(true);
    expect(auth.verify(`Bearer ${refreshed.access_token}`)).toBeNull();
    expect(auth.clients()).toEqual([]);
    auth.revokeAll();
    expect(auth.clients()).toEqual([]);
  });

  it('sends a denied agent back with an error and no code', async () => {
    answer = false;
    const { client_id } = await (await register()).json();
    const back = await authorize(client_id);
    expect(back.searchParams.get('error')).toBe('access_denied');
    expect(back.searchParams.get('code')).toBeNull();
  });

  it('refuses a code without the right verifier', async () => {
    const { client_id } = await (await register()).json();
    const code = (await authorize(client_id)).searchParams.get('code')!;
    expect((await token({ grant_type: 'authorization_code', code, code_verifier: 'wrong', client_id })).status).toBe(400);
  });

  it('only sends codes back to this computer, to the address the client registered', async () => {
    expect((await register({ client_name: 'x', redirect_uris: ['https://evil.example/cb'] })).status).toBe(400);
    expect((await fetch(`${origin}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'client_name=x' })).status).toBe(415);
    const { client_id } = await (await register()).json();
    const q = new URLSearchParams({ response_type: 'code', client_id, redirect_uri: 'http://localhost:9999/other', code_challenge: CHALLENGE, code_challenge_method: 'S256' });
    const page = await fetch(`${origin}/oauth/authorize?${q}`, { redirect: 'manual' });
    expect(page.status).toBe(400);
    // Without PKCE the client is told so, and nobody is asked.
    const noPkce = await authorize(client_id, { code_challenge_method: 'plain' });
    expect(noPkce.searchParams.get('error')).toBe('invalid_request');
    expect(asked).toEqual([]);
  });

  it('takes in again an agent registered before the app forgot it, once the person allows it', async () => {
    // The id an agent was given before the app's data was removed (an uninstall and a new install).
    const back = await authorize('an-id-from-before-0123');
    expect(asked).toEqual(['An agent that was connected before']);
    const code = back.searchParams.get('code')!;
    const t = await (await token({ grant_type: 'authorization_code', code, code_verifier: VERIFIER, client_id: 'an-id-from-before-0123', redirect_uri: REDIRECT })).json();
    expect(auth.verify(`Bearer ${t.access_token}`)).toBe('An agent that was connected before');

    // Not one whose address is off this computer, and not without an address.
    const away = new URLSearchParams({ response_type: 'code', client_id: 'another-old-id-0123', redirect_uri: 'https://evil.example/cb', code_challenge: CHALLENGE, code_challenge_method: 'S256' });
    expect((await fetch(`${origin}/oauth/authorize?${away}`, { redirect: 'manual' })).status).toBe(400);
    const noAddress = new URLSearchParams({ response_type: 'code', client_id: 'another-old-id-0123', code_challenge: CHALLENGE, code_challenge_method: 'S256' });
    expect((await fetch(`${origin}/oauth/authorize?${noAddress}`, { redirect: 'manual' })).status).toBe(400);
    expect(asked).toHaveLength(1);
  });

  it('accepts only addresses on this computer, and names fit to show', () => {
    expect(allowedRedirect('http://127.0.0.1:5000/cb')).toBe(true);
    expect(allowedRedirect('http://localhost/cb')).toBe(true);
    expect(allowedRedirect('cursor://anysphere.cursor-retrieval/oauth')).toBe(true);
    expect(allowedRedirect('http://example.com/cb')).toBe(false);
    expect(allowedRedirect('https://localhost/cb')).toBe(false);
    expect(allowedRedirect('javascript:alert(1)')).toBe(false);
    expect(clientName('  Claude\nCode  ')).toBe('Claude Code');
    expect(clientName('')).toBe('An agent');
  });
});
