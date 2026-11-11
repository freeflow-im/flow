// The plugin hosted in the suite on a host of its own (http.ts, PluginHandoff): its sign-in page sends the browser to
// /oauth/sign-in, which forwards it to the suite's cross-host sign-in; /oauth/handoff trades the key it comes back with
// for a session on this host.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../server/app.ts';

const KEY = 'k'.repeat(43);
const redeem = vi.fn(async (key: string) => (key === KEY ? 'user-1' : null));
let dir: string;
let host: ReturnType<typeof Fastify>;

beforeAll(async () => {
  // The app logs from background work (start-up, store tidying) that can outlive the last test; a log arriving while
  // vitest tears the worker down fails the whole run ("Closing rpc while onUserConsoleLog was pending"). Kept local.
  for (const level of ['log', 'info', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => {});
  dir = mkdtempSync(path.join(tmpdir(), 'docs-handoff-'));
  host = Fastify();
  await buildApp({
    dataDir: dir,
    blob: null,
    pdf: null,
    agent: { jobs: false },
    plugin: { publicUrl: 'https://docs.test', webDir: dir },
    host: {
      app: host,
      basePath: '/docs',
      authenticate: async () => null,
      signOut: async () => {},
      userForCookie: async (header) => (header?.includes('sid=tok-1') ? 'user-1' : null),
      signInUrl: '/oauth/sign-in',
      handoff: {
        signIn: (h, next) => `https://app.test/api/auth/cross-host?host=${encodeURIComponent(h)}&next=${encodeURIComponent(next)}`,
        redeem,
        sessionCookie: async (userId) => `sid=tok-${userId.slice(-1)}; Path=/; HttpOnly`,
      },
      isMember: async () => false,
      organizationsOf: async () => [],
    },
  });
  await host.ready();
});

afterAll(async () => {
  await host.close();
  // Let work started by the last request settle before the worker goes.
  await new Promise((r) => setTimeout(r, 50));
  rmSync(dir, { recursive: true, force: true });
});

async function pendingSignIn() {
  const reg = await host.inject({ method: 'POST', url: '/oauth/register', headers: { 'content-type': 'application/json' }, payload: { client_name: 'ChatGPT', redirect_uris: ['https://chatgpt.test/cb'] } });
  const q = new URLSearchParams({ response_type: 'code', client_id: reg.json().client_id, redirect_uri: 'https://chatgpt.test/cb', code_challenge: 'c', code_challenge_method: 'S256' });
  return host.inject({ method: 'GET', url: `/oauth/authorize?${q}`, headers: { host: 'docs.test' } });
}

describe('the plugin\'s sign-in handed across from the suite\'s host', () => {
  it('sends a visitor to /oauth/sign-in here, which forwards them to the suite\'s cross-host sign-in with the way back', async () => {
    const page = await pendingSignIn();
    expect(page.statusCode).toBe(200);
    const link = /href="(\/oauth\/sign-in\?next=[^"]+)"/.exec(page.body)?.[1];
    expect(link).toBeDefined();
    const r = await host.inject({ method: 'GET', url: link!.replace(/&amp;/g, '&'), headers: { host: 'docs.test' } });
    expect(r.statusCode).toBe(302);
    const to = new URL(r.headers.location as string);
    expect(to.origin + to.pathname).toBe('https://app.test/api/auth/cross-host');
    expect(to.searchParams.get('host')).toBe('docs.test');
    expect(to.searchParams.get('next')).toMatch(/^\/oauth\/resume\?p=/);
  });

  it('refuses a way back that is not one of its own pages', async () => {
    for (const next of ['https://evil.test/', '//evil.test/oauth/x', '/docs', '']) {
      const r = await host.inject({ method: 'GET', url: `/oauth/sign-in?next=${encodeURIComponent(next)}` });
      expect(r.statusCode, next).toBe(400);
    }
  });

  it('trades the key for a session on this host and goes on to the page the person was on', async () => {
    const page = await pendingSignIn();
    const pendingId = /\/oauth\/resume\?p=([A-Za-z0-9_-]+)/.exec(page.body)![1];
    const next = `/oauth/resume?p=${pendingId}`;
    const r = await host.inject({ method: 'GET', url: `/oauth/handoff?key=${KEY}&next=${encodeURIComponent(next)}` });
    expect(r.statusCode).toBe(302);
    expect(r.headers.location).toBe(next);
    expect(r.headers['set-cookie']).toBe('sid=tok-1; Path=/; HttpOnly');
    expect(redeem).toHaveBeenCalledWith(KEY);
    // Back on the resume page with that cookie, the suite's session is seen and the flow goes on to consent.
    const resumed = await host.inject({ method: 'GET', url: next, headers: { cookie: 'sid=tok-1' } });
    expect(resumed.statusCode).toBe(302);
    expect(resumed.headers.location).toBe(`/oauth/consent?p=${pendingId}`);
  });

  it('says the sign-in has expired for a key that is unknown, used or malformed', async () => {
    for (const key of ['x'.repeat(43), 'short', '']) {
      const r = await host.inject({ method: 'GET', url: `/oauth/handoff?key=${key}&next=${encodeURIComponent('/oauth/resume?p=abc')}` });
      expect(r.statusCode, key).toBe(400);
      expect(r.body).toContain('expired');
      expect(r.headers['set-cookie']).toBeUndefined();
    }
  });
});
