// The app-guard proxy end to end (docs/design/MINI_APPS.md, issue #370): a real
// upstream on an ephemeral port, a real guard in front of it, real requests
// through it. Anything the guard lets through is recorded by the upstream, so
// "unauthenticated traffic never reaches the app" is asserted rather than
// assumed.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { createHmac, randomBytes } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';
import { AppGuard, SESSION_COOKIE, cleanUrl, parseSecretList, upstreamHeaders } from '../src/app-guard.js';
import { APP_TOKEN_TTL_SECONDS, type AppTokenPayload } from '../src/app-token.js';
import { AppGuardUsageError, parseAppGuardArgs, runAppGuard } from '../src/app-guard-cli.js';

const SECRET = randomBytes(32);
const SECRET_B64 = SECRET.toString('base64url');

let jtiSeq = 0;
function mint(secret: Buffer = SECRET, over: Partial<AppTokenPayload> = {}): string {
  const iat = Math.floor(Date.now() / 1000);
  const p: AppTokenPayload = {
    v: 1,
    artifactId: 'art-1',
    channelId: 'chan-1',
    workspaceId: 'ws-1',
    userId: 'user-1',
    displayName: 'Scott',
    isAgent: false,
    iat,
    exp: iat + APP_TOKEN_TTL_SECONDS,
    jti: `jti-${++jtiSeq}`,
    ...over,
  };
  const json = Buffer.from(JSON.stringify(p), 'utf8');
  const mac = createHmac('sha256', secret).update(json).digest();
  return `${json.toString('base64url')}.${mac.toString('base64url')}`;
}

/** Every request the upstream saw — the proof that the guard blocked what it
 * claims to block. */
const seen: Array<{ url: string; headers: http.IncomingHttpHeaders }> = [];
let upstream: http.Server;
let guard: AppGuard;
let base: string;

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    seen.push({ url: req.url ?? '', headers: req.headers });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ url: req.url, headers: req.headers }));
  });
  const wss = new WebSocketServer({ server: upstream });
  wss.on('connection', (ws, req) => {
    seen.push({ url: req.url ?? '', headers: req.headers });
    ws.send(`hello ${req.headers['x-flow-user-name'] as string}`);
  });
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
  const upPort = (upstream.address() as { port: number }).port;

  guard = new AppGuard({ upstream: `http://127.0.0.1:${upPort}`, secrets: [SECRET_B64], log: () => {} });
  await guard.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${(guard.server.address() as { port: number }).port}`;
});

afterAll(async () => {
  await guard.close();
  await new Promise<void>((r) => upstream.close(() => r()));
});

/** Walk one token through the front door and return its session cookie. */
async function openSession(token: string): Promise<string> {
  const res = await fetch(`${base}/app?flow_token=${encodeURIComponent(token)}`, { redirect: 'manual' });
  expect(res.status).toBe(302);
  const setCookie = res.headers.get('set-cookie') ?? '';
  const value = /flow_app_session=([^;]+)/.exec(setCookie)?.[1];
  expect(value).toBeTruthy();
  return `${SESSION_COOKIE}=${value!}`;
}

describe('app-guard: the front door', () => {
  it('swaps a valid token for a session cookie and 302s to the clean url', async () => {
    const before = seen.length;
    const token = mint();
    const res = await fetch(`${base}/dash?tab=1&flow_token=${encodeURIComponent(token)}`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/dash?tab=1');
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/^flow_app_session=/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=None');
    // the token exchange itself never touches the app
    expect(seen.length).toBe(before);
  });

  it('rejects a replay of the same token', async () => {
    const token = mint();
    expect((await fetch(`${base}/?flow_token=${token}`, { redirect: 'manual' })).status).toBe(302);
    const replay = await fetch(`${base}/?flow_token=${token}`, { redirect: 'manual' });
    expect(replay.status).toBe(401);
    expect(replay.headers.get('set-cookie')).toBeNull();
  });

  it('rejects an expired token and a bad signature', async () => {
    const iat = Math.floor(Date.now() / 1000) - 3600;
    const expired = mint(SECRET, { iat, exp: iat + APP_TOKEN_TTL_SECONDS });
    expect((await fetch(`${base}/?flow_token=${expired}`, { redirect: 'manual' })).status).toBe(401);
    const forged = mint(randomBytes(32));
    expect((await fetch(`${base}/?flow_token=${forged}`, { redirect: 'manual' })).status).toBe(401);
  });

  it('401s an unauthenticated request with one line of html, and the app never sees it', async () => {
    const before = seen.length;
    const res = await fetch(`${base}/secret`, { redirect: 'manual' });
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    expect(await res.text()).toContain('Open this app from its Flow channel.');
    expect(seen.length).toBe(before);
  });

  it('401s an unknown or stale session cookie', async () => {
    const before = seen.length;
    const res = await fetch(`${base}/`, { headers: { cookie: `${SESSION_COOKIE}=made-up` }, redirect: 'manual' });
    expect(res.status).toBe(401);
    expect(seen.length).toBe(before);
  });
});

describe('app-guard: proxying', () => {
  it('forwards to the upstream with identity headers from the session', async () => {
    const cookie = await openSession(mint(SECRET, { displayName: 'Ada', userId: 'u-ada', isAgent: true }));
    const res = await fetch(`${base}/api/thing?q=1`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { url: string; headers: Record<string, string> };
    expect(body.url).toBe('/api/thing?q=1');
    expect(body.headers['x-flow-user-id']).toBe('u-ada');
    expect(body.headers['x-flow-user-name']).toBe('Ada');
    expect(body.headers['x-flow-artifact-id']).toBe('art-1');
    expect(body.headers['x-flow-channel-id']).toBe('chan-1');
    expect(body.headers['x-flow-is-agent']).toBe('true');
  });

  it('strips inbound X-Flow-* so a viewer cannot claim another identity', async () => {
    const cookie = await openSession(mint());
    const res = await fetch(`${base}/`, {
      headers: {
        cookie,
        'X-Flow-User-Id': 'attacker',
        'x-flow-user-name': 'Admin',
        'X-Flow-Is-Agent': 'true',
        'X-Flow-Something-Else': 'nope',
      },
    });
    const body = (await res.json()) as { headers: Record<string, string> };
    expect(body.headers['x-flow-user-id']).toBe('user-1');
    expect(body.headers['x-flow-user-name']).toBe('Scott');
    expect(body.headers['x-flow-is-agent']).toBe('false');
    expect(body.headers['x-flow-something-else']).toBeUndefined();
  });

  it('keeps the guard session cookie away from the app, but passes the app’s own', async () => {
    const cookie = await openSession(mint());
    const res = await fetch(`${base}/`, { headers: { cookie: `${cookie}; theme=dark` } });
    const body = (await res.json()) as { headers: Record<string, string> };
    expect(body.headers.cookie).toBe('theme=dark');
  });

  it('passes the method and body through', async () => {
    const cookie = await openSession(mint());
    const res = await fetch(`${base}/submit`, { method: 'POST', headers: { cookie }, body: 'hello' });
    expect(res.status).toBe(200);
    expect((await res.json() as { url: string }).url).toBe('/submit');
  });
});

describe('app-guard: websockets', () => {
  it('proxies an upgrade with a valid session and rejects one without', async () => {
    const cookie = await openSession(mint(SECRET, { displayName: 'Ada', userId: 'u-ada' }));
    const greeting = await new Promise<string>((resolve, reject) => {
      const ws = new WebSocket(`${base.replace('http', 'ws')}/live`, { headers: { cookie } });
      ws.on('message', (m) => {
        resolve(m.toString());
        ws.close();
      });
      ws.on('error', reject);
    });
    expect(greeting).toBe('hello Ada');

    const before = seen.length;
    const err = await new Promise<Error>((resolve) => {
      const ws = new WebSocket(`${base.replace('http', 'ws')}/live`);
      ws.on('error', resolve);
      ws.on('open', () => resolve(new Error('opened without a session')));
    });
    expect(err.message).toMatch(/401/);
    expect(seen.length).toBe(before);
  });
});

describe('app-guard: configuration', () => {
  it('accepts a list of secrets — one app pinned in several channels', async () => {
    const other = randomBytes(32);
    const g = new AppGuard({
      upstream: base, // irrelevant: we only exercise the front door
      secrets: [SECRET_B64, other.toString('base64url')],
      log: () => {},
    });
    await g.listen(0, '127.0.0.1');
    const at = `http://127.0.0.1:${(g.server.address() as { port: number }).port}`;
    const res = await fetch(`${at}/?flow_token=${mint(other, { channelId: 'chan-2' })}`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect((await fetch(`${at}/?flow_token=${mint(randomBytes(32))}`, { redirect: 'manual' })).status).toBe(401);
    await g.close();
  });

  it('refuses to start with no secret or a non-http upstream', () => {
    expect(() => new AppGuard({ upstream: 'http://x', secrets: [] })).toThrow(/secret/);
    expect(() => new AppGuard({ upstream: 'ftp://x', secrets: [SECRET_B64] })).toThrow(/http/);
  });

  it('splits FLOW_APP_SECRET on commas and whitespace', () => {
    expect(parseSecretList('a,b c\nd')).toEqual(['a', 'b', 'c', 'd']);
    expect(parseSecretList(undefined)).toEqual([]);
    expect(parseSecretList('  ')).toEqual([]);
  });
});

describe('app-guard: helpers', () => {
  it('cleanUrl removes only the token', () => {
    expect(cleanUrl('/a/b?flow_token=x')).toBe('/a/b');
    expect(cleanUrl('/a?keep=1&flow_token=x&also=2')).toBe('/a?keep=1&also=2');
    expect(cleanUrl('/?flow_token=x#frag')).toBe('/#frag');
  });

  it('upstreamHeaders is strip-then-set, never the other way round', () => {
    const h = upstreamHeaders({ 'x-flow-user-id': 'spoof', accept: 'text/html' }, {
      userId: 'real',
      displayName: 'Real',
      isAgent: false,
      artifactId: 'a',
      channelId: 'c',
      expiresAt: Date.now() + 1000,
    });
    expect(h['x-flow-user-id']).toBe('real');
    expect(h.accept).toBe('text/html');
  });
});

describe('app-guard: cli', () => {
  it('takes the upstream and port from flags and the secrets from the environment', () => {
    const o = parseAppGuardArgs(['--upstream', 'http://localhost:3000', '--port', '8788'], {
      FLOW_APP_SECRET: `${SECRET_B64},${randomBytes(32).toString('base64url')}`,
    });
    expect(o).toMatchObject({ upstream: 'http://localhost:3000', port: 8788, host: '0.0.0.0' });
    expect(o.secrets).toHaveLength(2);
  });

  it('defaults the port to 8788', () => {
    expect(parseAppGuardArgs(['--upstream', 'http://x'], { FLOW_APP_SECRET: SECRET_B64 }).port).toBe(8788);
  });

  it('explains itself rather than starting half-configured', () => {
    expect(() => parseAppGuardArgs([], { FLOW_APP_SECRET: SECRET_B64 })).toThrow(AppGuardUsageError);
    expect(() => parseAppGuardArgs(['--upstream', 'http://x'], {})).toThrow(/FLOW_APP_SECRET/);
    expect(() => parseAppGuardArgs(['--upstream', 'http://x', '--port', 'nope'], { FLOW_APP_SECRET: SECRET_B64 })).toThrow(
      /port/,
    );
  });
});

describe('app-guard: startup failures', () => {
  it('reports an unusable secret as a usage error', async () => {
    await expect(runAppGuard(['--upstream', 'http://127.0.0.1:1'], { FLOW_APP_SECRET: '!' })).rejects.toThrow(
      AppGuardUsageError,
    );
  });

  it('reports a busy port as a usage error, not a stack trace', async () => {
    const blocker = http.createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', () => r()));
    const port = (blocker.address() as { port: number }).port;
    await expect(
      runAppGuard(['--upstream', 'http://127.0.0.1:1', '--port', String(port), '--host', '127.0.0.1'], {
        FLOW_APP_SECRET: SECRET_B64,
      }),
    ).rejects.toThrow(AppGuardUsageError);
    await new Promise<void>((r) => blocker.close(() => r()));
  });
});

describe('app-guard: an installed app’s tab (token version 2, user-apps.md §6.2)', () => {
  function mintV2(secret: Buffer = SECRET): string {
    const iat = Math.floor(Date.now() / 1000);
    const p = { v: 2, app: 'taskboard', workspaceId: 'ws-1', userId: 'u-ben', accountId: 'acct-ben', displayName: 'Ben', isAgent: false, iat, exp: iat + APP_TOKEN_TTL_SECONDS, jti: `jti-${++jtiSeq}` };
    const json = Buffer.from(JSON.stringify(p), 'utf8');
    return `${json.toString('base64url')}.${createHmac('sha256', secret).update(json).digest().toString('base64url')}`;
  }

  it('opens a session and tells the app which app, account and organization', async () => {
    const cookie = await openSession(mintV2());
    const res = await fetch(`${base}/board`, { headers: { cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { headers: Record<string, string> };
    expect(body.headers['x-flow-user-id']).toBe('u-ben');
    expect(body.headers['x-flow-app']).toBe('taskboard');
    expect(body.headers['x-flow-account-id']).toBe('acct-ben');
    expect(body.headers['x-flow-workspace-id']).toBe('ws-1');
    expect(body.headers['x-flow-artifact-id']).toBeUndefined();
  });

  it('refuses a version 2 token signed with another secret', async () => {
    const res = await fetch(`${base}/?flow_token=${encodeURIComponent(mintV2(randomBytes(32)))}`, { redirect: 'manual' });
    expect(res.status).toBe(401);
  });
});
