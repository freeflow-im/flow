import type { ImageEditRequest } from './imageEdit.ts';
import { OPENAI_MODELS } from '../shared/agent/protocol.ts';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildSlide, newId } from '../shared/deck.ts';
import { buildPptx } from '../shared/pptxExport.ts';
import { buildApp } from './app.ts';
import { buildDocx, mailbox, signUp } from './testing.ts';
import { resolver } from './webFetch.ts';

let dir: string;
let app: Awaited<ReturnType<typeof buildApp>>;

const box = mailbox();
const sentMail = box.sent;

/** What the stub image model was asked to edit. */
const imageEdits: ImageEditRequest[] = [];

beforeAll(async () => {
  // The default app must not pick up Google credentials from the environment.
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
  dir = mkdtempSync(path.join(tmpdir(), 'sheetsweb-test-'));
  app = await buildApp({ dataDir: dir, sendMail: box.send, appUrl: 'https://sheets.test', imageEditor: async (req) => (imageEdits.push(req), Buffer.from(`edited:${req.prompt}`)), checkAssistantKey: async () => {}, checkSearchKey: async (k) => (k === 'BSA-bad' ? 'Brave Search did not accept that API key.' : null) });
});

afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

function cookieFrom(res: { headers: Record<string, unknown> }): string {
  const sc = res.headers['set-cookie'];
  const first = Array.isArray(sc) ? sc[0] : String(sc);
  return first.split(';')[0];
}

describe('public pages', () => {
  it('serves the privacy policy, terms and support as plain HTML to anyone', async () => {
    const a = await buildApp({ dataDir: mkdtempSync(path.join(tmpdir(), 'legal-')) });
    try {
      for (const [p, heading] of [['/privacy', 'Privacy Policy'], ['/terms', 'Terms of Service'], ['/support', 'Support']]) {
        const res = await a.inject({ method: 'GET', url: p });
        expect(res.statusCode).toBe(200);
        expect(res.headers['content-type']).toContain('text/html');
        expect(res.body).toContain(`<h1>${heading}</h1>`);
        expect(res.body).toContain('mailto:');
      }
      // Without the plugin there is no MCP server to describe.
      const llms = await a.inject({ method: 'GET', url: '/llms.txt' });
      expect(llms.statusCode).toBe(200);
      expect(llms.headers['content-type']).toContain('text/markdown');
      expect(llms.body).toContain('# MCP Docs');
      expect(llms.body).not.toContain('/mcp/v2');
    } finally {
      await a.close();
    }
  });
});

describe('password reset', () => {
  it('emails a one-time link that sets a new password and signs the user in', async () => {
    await signUp(app, box, 'reset@x.com', 'oldpassword1');
    sentMail.length = 0;

    // Unknown address: same answer, no mail.
    let res = await app.inject({ method: 'POST', url: '/api/auth/forgot', payload: { email: 'nobody@x.com' } });
    expect(res.statusCode).toBe(200);
    expect(sentMail).toHaveLength(0);

    res = await app.inject({ method: 'POST', url: '/api/auth/forgot', payload: { email: 'Reset@x.com' } });
    expect(res.statusCode).toBe(200);
    expect(sentMail).toHaveLength(1);
    expect(sentMail[0].to).toBe('reset@x.com');
    const link = /https:\/\/sheets\.test\/reset\?token=([A-Za-z0-9_-]+)/.exec(sentMail[0].text);
    expect(link).not.toBeNull();
    const token = link![1];

    res = await app.inject({ method: 'GET', url: `/api/auth/reset?token=${token}` });
    expect(res.json()).toEqual({ email: 'reset@x.com' });
    res = await app.inject({ method: 'GET', url: '/api/auth/reset?token=bogus' });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: 'POST', url: '/api/auth/reset', payload: { token, password: 'short' } });
    expect(res.statusCode).toBe(400);
    res = await app.inject({ method: 'POST', url: '/api/auth/reset', payload: { token, password: 'newpassword1' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.email).toBe('reset@x.com');
    const cookie = cookieFrom(res);
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } })).json().user.email).toBe('reset@x.com');

    // The link works once; the old password is gone; the new one works.
    res = await app.inject({ method: 'POST', url: '/api/auth/reset', payload: { token, password: 'anotherpass1' } });
    expect(res.statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'reset@x.com', password: 'oldpassword1' } })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'reset@x.com', password: 'newpassword1' } })).statusCode).toBe(200);
  });

  it('limits reset requests per address', async () => {
    for (let i = 0; i < 5; i++) await app.inject({ method: 'POST', url: '/api/auth/forgot', payload: { email: 'limited@x.com' } });
    const res = await app.inject({ method: 'POST', url: '/api/auth/forgot', payload: { email: 'limited@x.com' } });
    expect(res.statusCode).toBe(429);
  });
});

describe('google sign-in', () => {
  /** A Google that accepts any code and reports this identity. */
  function fakeGoogle(info: Record<string, unknown>) {
    const tokenBodies: URLSearchParams[] = [];
    const fetchFn = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).startsWith('https://oauth2.googleapis.com/token')) {
        tokenBodies.push(new URLSearchParams(String(init?.body)));
        return Response.json({ access_token: 'at-1', id_token: 'x', token_type: 'Bearer' });
      }
      if (String(url).startsWith('https://openidconnect.googleapis.com/v1/userinfo')) {
        expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer at-1');
        return Response.json(info);
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;
    return { fetchFn, tokenBodies };
  }

  async function withGoogleApp(info: Record<string, unknown>, fn: (g: Awaited<ReturnType<typeof buildApp>>, tokenBodies: URLSearchParams[], gbox: ReturnType<typeof mailbox>) => Promise<void>) {
    const gdir = mkdtempSync(path.join(tmpdir(), 'sheetsweb-google-'));
    const { fetchFn, tokenBodies } = fakeGoogle(info);
    const gbox = mailbox();
    const g = await buildApp({ dataDir: gdir, sendMail: gbox.send, appUrl: 'https://sheets.test', google: { clientId: 'cid', clientSecret: 'sec', fetch: fetchFn } });
    try {
      await fn(g, tokenBodies, gbox);
    } finally {
      await g.close();
      rmSync(gdir, { recursive: true, force: true });
    }
  }

  /** Runs /start and returns what the callback needs: the state and the state cookie. */
  async function start(g: Awaited<ReturnType<typeof buildApp>>, next?: string) {
    const res = await g.inject({ method: 'GET', url: `/api/auth/google/start${next ? `?next=${encodeURIComponent(next)}` : ''}` });
    expect(res.statusCode).toBe(302);
    const url = new URL(res.headers.location as string);
    expect(url.origin).toBe('https://accounts.google.com');
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('redirect_uri')).toBe('https://sheets.test/api/auth/google/callback');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const state = url.searchParams.get('state')!;
    const cookie = cookieFrom(res);
    expect(cookie).toBe(`gstate=${state}`);
    return { state, cookie };
  }

  it('is off unless configured', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/auth/me' })).json().googleLogin).toBe(false);
    expect((await app.inject({ method: 'GET', url: '/api/auth/google/start' })).statusCode).toBe(404);
  });

  it('creates an account on first sign-in and reuses it after', async () => {
    await withGoogleApp({ sub: 'g-1', email: 'Person@Gmail.com', email_verified: true }, async (g, tokenBodies) => {
      expect((await g.inject({ method: 'GET', url: '/api/auth/me' })).json().googleLogin).toBe(true);
      const { state, cookie } = await start(g, '/s/abc');
      let res = await g.inject({ method: 'GET', url: `/api/auth/google/callback?state=${state}&code=the-code`, headers: { cookie } });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/s/abc');
      expect(tokenBodies[0].get('code')).toBe('the-code');
      expect(tokenBodies[0].get('code_verifier')).toBeTruthy();
      const sid = (res.headers['set-cookie'] as string[]).map((c) => c.split(';')[0]).find((c) => c.startsWith('sid='))!;
      res = await g.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: sid } });
      expect(res.json().user.email).toBe('person@gmail.com');
      const id = res.json().user.id;

      // A Google-created account has no password that works.
      expect((await g.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'person@gmail.com', password: '' } })).statusCode).toBe(401);
      expect((await g.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'person@gmail.com', password: 'anything1' } })).statusCode).toBe(401);

      // Second sign-in: same account; an off-site "next" falls back to the home page.
      const again = await start(g, 'https://evil.example/');
      res = await g.inject({ method: 'GET', url: `/api/auth/google/callback?state=${again.state}&code=c2`, headers: { cookie: again.cookie } });
      expect(res.headers.location).toBe('/');
      const sid2 = (res.headers['set-cookie'] as string[]).map((c) => c.split(';')[0]).find((c) => c.startsWith('sid='))!;
      expect((await g.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: sid2 } })).json().user.id).toBe(id);
    });
  });

  it('hands a sign-in in the system browser back to the desktop app, which asks after it with its key', async () => {
    await withGoogleApp({ sub: 'g-d', email: 'desk@x.com', email_verified: true }, async (g) => {
      const key = 'k'.repeat(40);
      const status = async () => (await g.inject({ method: 'GET', url: `/api/auth/handoff/status?key=${key}` })).json().ready;
      let res = await g.inject({ method: 'GET', url: `/api/auth/google/start?desktop=${key}&next=%2Fdoc%2Fabc` });
      const state = new URL(res.headers.location as string).searchParams.get('state')!;
      expect(await status()).toBe(false);
      res = await g.inject({ method: 'GET', url: `/api/auth/google/callback?state=${state}&code=c`, headers: { cookie: cookieFrom(res) } });
      // The browser gets no session, only a page saying to go back to the app.
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      expect(String(res.headers['set-cookie'] ?? '')).not.toContain('sid=');
      expect(res.body).toContain('MCP Docs');
      expect(await status()).toBe(true);

      // The app's Web tab trades the key for a session, once.
      res = await g.inject({ method: 'GET', url: `/api/auth/handoff?key=${key}` });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('/doc/abc');
      const sid = cookieFrom(res);
      expect(sid).toMatch(/^sid=/);
      expect((await g.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: sid } })).json().user.email).toBe('desk@x.com');
      expect(await status()).toBe(false);
      res = await g.inject({ method: 'GET', url: `/api/auth/handoff?key=${key}` });
      expect(res.headers.location).toMatch(/^\/login\?error=/);
      expect(res.headers['set-cookie']).toBeUndefined();

      // A key too short to be the app's is not one: the sign-in is the browser's own.
      res = await g.inject({ method: 'GET', url: '/api/auth/google/start?desktop=short' });
      const st2 = new URL(res.headers.location as string).searchParams.get('state')!;
      res = await g.inject({ method: 'GET', url: `/api/auth/google/callback?state=${st2}&code=c`, headers: { cookie: cookieFrom(res) } });
      expect(res.statusCode).toBe(302);
    });
  });

  it('links to an existing verified password account with the same email', async () => {
    await withGoogleApp({ sub: 'g-2', email: 'linked@x.com', email_verified: true }, async (g, _tokens, gbox) => {
      const { user } = await signUp(g, gbox, 'linked@x.com');
      const id = user.id;
      const { state, cookie } = await start(g);
      const res = await g.inject({ method: 'GET', url: `/api/auth/google/callback?state=${state}&code=c`, headers: { cookie } });
      const sid = (res.headers['set-cookie'] as string[]).map((c) => c.split(';')[0]).find((c) => c.startsWith('sid='))!;
      expect((await g.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: sid } })).json().user.id).toBe(id);
      // The password still works too.
      expect((await g.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'linked@x.com', password: 'password123' } })).statusCode).toBe(200);
    });
  });

  it('takes over an unverified password account with the same email', async () => {
    await withGoogleApp({ sub: 'g-4', email: 'squatted@x.com', email_verified: true }, async (g) => {
      // Someone registered with this address but never opened the verification link.
      const reg = await g.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'squatted@x.com', password: 'password123' } });
      expect(reg.statusCode).toBe(200);
      expect(reg.headers['set-cookie']).toBeUndefined();

      const { state, cookie } = await start(g);
      const res = await g.inject({ method: 'GET', url: `/api/auth/google/callback?state=${state}&code=c`, headers: { cookie } });
      expect(res.headers.location).toBe('/');
      const sid = (res.headers['set-cookie'] as string[]).map((c) => c.split(';')[0]).find((c) => c.startsWith('sid='))!;
      expect((await g.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie: sid } })).json().user.email).toBe('squatted@x.com');
      // The squatter's password no longer opens the account, and it now counts as taken.
      expect((await g.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'squatted@x.com', password: 'password123' } })).statusCode).toBe(401);
      expect((await g.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'squatted@x.com', password: 'password456' } })).statusCode).toBe(409);
    });
  });

  it('rejects unverified emails, bad states and cancellations', async () => {
    await withGoogleApp({ sub: 'g-3', email: 'unverified@x.com', email_verified: false }, async (g) => {
      const { state, cookie } = await start(g);
      let res = await g.inject({ method: 'GET', url: `/api/auth/google/callback?state=${state}&code=c`, headers: { cookie } });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toMatch(/^\/login\?error=.*verified/);
      expect(res.headers['set-cookie']).not.toEqual(expect.arrayContaining([expect.stringMatching(/^sid=/)]));

      // A state the server never issued, or one that doesn't match the browser's cookie.
      res = await g.inject({ method: 'GET', url: '/api/auth/google/callback?state=nope&code=c', headers: { cookie: 'gstate=nope' } });
      expect(res.headers.location).toMatch(/^\/login\?error=.*expired/);
      const fresh = await start(g);
      res = await g.inject({ method: 'GET', url: `/api/auth/google/callback?state=${fresh.state}&code=c` });
      expect(res.headers.location).toMatch(/^\/login\?error=.*expired/);

      res = await g.inject({ method: 'GET', url: '/api/auth/google/callback?error=access_denied' });
      expect(res.headers.location).toMatch(/^\/login\?error=.*cancelled/);
    });
  });
});

describe('auth', () => {
  it('registers, verifies the email, logs in and out', async () => {
    let res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'A@x.com', password: 'short' } });
    expect(res.statusCode).toBe(400);

    // Sign-up sends a link and gives no session yet.
    res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'A@x.com', password: 'password123' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ pending: true, email: 'a@x.com' });
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(sentMail.at(-1)?.to).toBe('a@x.com');
    expect(sentMail.at(-1)?.subject).toMatch(/verify/i);

    // The right password doesn't help until the link is opened.
    res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'a@x.com', password: 'password123' } });
    expect(res.statusCode).toBe(403);
    expect(res.json().code).toBe('unverified');

    // Signing up again before verifying just replaces the password and sends a fresh link; the old link dies.
    const firstToken = box.tokenFor('a@x.com', 'verify');
    res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'a@x.com', password: 'password456' } });
    expect(res.statusCode).toBe(200);
    res = await app.inject({ method: 'POST', url: '/api/auth/verify', payload: { token: firstToken } });
    expect(res.statusCode).toBe(400);

    // Send-again works for an unverified account and says nothing about unknown ones.
    res = await app.inject({ method: 'POST', url: '/api/auth/verify/resend', payload: { email: 'a@x.com' } });
    expect(res.statusCode).toBe(200);
    const before = sentMail.length;
    res = await app.inject({ method: 'POST', url: '/api/auth/verify/resend', payload: { email: 'ghost@x.com' } });
    expect(res.statusCode).toBe(200);
    expect(sentMail.length).toBe(before);

    res = await app.inject({ method: 'POST', url: '/api/auth/verify', payload: { token: box.tokenFor('a@x.com', 'verify') } });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.email).toBe('a@x.com');
    const cookie = cookieFrom(res);
    // One use only.
    res = await app.inject({ method: 'POST', url: '/api/auth/verify', payload: { token: box.tokenFor('a@x.com', 'verify') } });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(res.json().user.email).toBe('a@x.com');

    res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'a@x.com', password: 'password123' } });
    expect(res.statusCode).toBe(409);

    res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'a@x.com', password: 'wrongpass1' } });
    expect(res.statusCode).toBe(401);

    res = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
    res = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { cookie } });
    expect(res.json().user).toBe(null);

    res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'a@x.com', password: 'password456' } });
    expect(res.statusCode).toBe(200);
  });

  it('limits verification emails per address', async () => {
    for (let i = 0; i < 5; i++) await app.inject({ method: 'POST', url: '/api/auth/verify/resend', payload: { email: 'vlimited@x.com' } });
    const res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { email: 'vlimited@x.com', password: 'password123' } });
    expect(res.statusCode).toBe(429);
  });
});

describe('saved signatures', () => {
  it('keeps each user their own signatures, added and removed one at a time', async () => {
    const { cookie } = await signUp(app, box, 'sig@x.com');
    const { cookie: other } = await signUp(app, box, 'sig2@x.com');
    const url = '/api/settings/signatures';
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url, headers: { cookie } })).json()).toEqual({ signatures: [] });
    const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    const first = (await app.inject({ method: 'POST', url, headers: { cookie }, payload: { image } })).json().signature;
    const second = (await app.inject({ method: 'POST', url, headers: { cookie }, payload: { image } })).json().signature;
    expect(first).toMatchObject({ image });
    expect((await app.inject({ method: 'GET', url, headers: { cookie } })).json().signatures.map((s: { id: string }) => s.id)).toEqual([first.id, second.id]);
    expect((await app.inject({ method: 'GET', url, headers: { cookie: other } })).json()).toEqual({ signatures: [] });
    // Only a PNG picture.
    expect((await app.inject({ method: 'POST', url, headers: { cookie }, payload: { image: 'data:image/svg+xml;base64,PHN2Zy8+' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url, headers: { cookie }, payload: { image: 'hello' } })).statusCode).toBe(400);
    // Not another user's.
    expect((await app.inject({ method: 'DELETE', url: `${url}/${first.id}`, headers: { cookie: other } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: `${url}/${first.id}`, headers: { cookie } })).json()).toEqual({ ok: true });
    expect((await app.inject({ method: 'GET', url, headers: { cookie } })).json().signatures.map((s: { id: string }) => s.id)).toEqual([second.id]);
    // Up to a limit.
    for (let n = 1; n < 12; n++) expect((await app.inject({ method: 'POST', url, headers: { cookie }, payload: { image } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'POST', url, headers: { cookie }, payload: { image } })).statusCode).toBe(400);
  });
});

describe('recents', () => {
  it('lists the files each user last opened, newest first, and forgets one that was deleted', async () => {
    const { cookie } = await signUp(app, box, 'recent@x.com');
    const { cookie: other } = await signUp(app, box, 'recent2@x.com');
    const sheet = (await app.inject({ method: 'POST', url: '/api/sheets', headers: { cookie }, payload: { title: 'Budget', folder: '' } })).json().sheet;
    const csv = (await app.inject({ method: 'POST', url: '/api/sheets', headers: { cookie }, payload: { title: 'Prices', csv: 'a,b\n1,2\n' } })).json().sheet;
    const opened = (kind: string, id: string, c = cookie) => app.inject({ method: 'POST', url: '/api/recents', headers: { cookie: c }, payload: { kind, id } });
    const list = async (c = cookie) => (await app.inject({ method: 'GET', url: '/api/recents', headers: { cookie: c } })).json().files as { id: string; kind: string; name: string; format?: string; app?: boolean }[];
    expect((await app.inject({ method: 'GET', url: '/api/recents' })).statusCode).toBe(401);
    expect(await list()).toEqual([]);
    expect((await opened('sheet', sheet.id)).statusCode).toBe(200);
    expect((await opened('sheet', csv.id)).statusCode).toBe(200);
    // Not another user's file, not one that is not there, not the wrong kind.
    expect((await opened('sheet', sheet.id, other)).statusCode).toBe(404);
    expect((await opened('doc', sheet.id)).statusCode).toBe(404);
    expect((await opened('nope', sheet.id)).statusCode).toBe(400);
    expect((await list()).map((f) => [f.name, f.kind, f.format ?? null, f.app])).toEqual([
      ['Prices', 'sheet', 'csv', true],
      ['Budget', 'sheet', null, true],
    ]);
    // Opened again: back to the top.
    await opened('sheet', sheet.id);
    expect((await list()).map((f) => f.id)).toEqual([sheet.id, csv.id]);
    expect(await list(other)).toEqual([]);
    await app.inject({ method: 'DELETE', url: `/api/sheets/${sheet.id}`, headers: { cookie } });
    expect((await list()).map((f) => f.id)).toEqual([csv.id]);
  });
});

describe('sheets', () => {
  it('requires auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/sheets' });
    expect(res.statusCode).toBe(401);
  });

  it('creates, saves, lists, renames and deletes sheets with per-user isolation', async () => {
    const { cookie } = await signUp(app, box, 'b@x.com');
    const { cookie: other } = await signUp(app, box, 'c@x.com');
    let res;

    res = await app.inject({ method: 'POST', url: '/api/sheets', headers: { cookie }, payload: { title: 'Budget' } });
    const { sheet } = res.json();
    expect(sheet.title).toBe('Budget');
    expect(readdirSync(path.join(dir, 'sheets'))).toContain(`${sheet.id}.json`);

    res = await app.inject({ method: 'GET', url: `/api/sheets/${sheet.id}`, headers: { cookie } });
    const { workbook } = res.json();
    expect(workbook.tabs[0].name).toBe('Sheet1');

    workbook.tabs[0].cells.A1 = { v: '=1+1' };
    res = await app.inject({ method: 'PUT', url: `/api/sheets/${sheet.id}`, headers: { cookie }, payload: { workbook } });
    expect(res.statusCode).toBe(200);

    res = await app.inject({ method: 'PUT', url: `/api/sheets/${sheet.id}`, headers: { cookie }, payload: { workbook: { version: 1, tabs: [] } } });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: 'GET', url: `/api/sheets/${sheet.id}`, headers: { cookie } });
    expect(res.json().workbook.tabs[0].cells.A1.v).toBe('=1+1');

    // Cell images are saved with the sheet; invalid ones are rejected.
    const png = 'data:image/png;base64,iVBORw0KGgo=';
    workbook.tabs[0].cells.I9 = { v: '', img: png };
    res = await app.inject({ method: 'PUT', url: `/api/sheets/${sheet.id}`, headers: { cookie }, payload: { workbook } });
    expect(res.statusCode).toBe(200);
    res = await app.inject({ method: 'GET', url: `/api/sheets/${sheet.id}`, headers: { cookie } });
    expect(res.json().workbook.tabs[0].cells.I9).toEqual({ v: '', img: png });
    workbook.tabs[0].cells.I9 = { v: '', img: 'javascript:alert(1)' };
    res = await app.inject({ method: 'PUT', url: `/api/sheets/${sheet.id}`, headers: { cookie }, payload: { workbook } });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: 'GET', url: `/api/sheets/${sheet.id}`, headers: { cookie: other } });
    expect(res.statusCode).toBe(404);
    res = await app.inject({ method: 'DELETE', url: `/api/sheets/${sheet.id}`, headers: { cookie: other } });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'PATCH', url: `/api/sheets/${sheet.id}`, headers: { cookie }, payload: { title: 'Budget 2026' } });
    expect(res.json().sheet.title).toBe('Budget 2026');

    res = await app.inject({ method: 'GET', url: '/api/sheets', headers: { cookie } });
    expect(res.json().sheets.map((s: { title: string }) => s.title)).toEqual(['Budget 2026']);

    res = await app.inject({ method: 'DELETE', url: `/api/sheets/${sheet.id}`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(readdirSync(path.join(dir, 'sheets'))).not.toContain(`${sheet.id}.json`);
    res = await app.inject({ method: 'GET', url: '/api/sheets', headers: { cookie } });
    expect(res.json().sheets).toEqual([]);
  });
});

describe('CSV files', () => {
  it('imports a CSV as a spreadsheet, saves edits as CSV, and converts when it needs more', async () => {
    const { cookie } = await signUp(app, box, 'csv@x.com');
    const text = 'Item,"Price, each"\r\nPen,1.50\r\n';
    let res = await app.inject({ method: 'POST', url: '/api/sheets', headers: { cookie }, payload: { title: 'Prices', csv: text } });
    expect(res.statusCode).toBe(200);
    const { sheet } = res.json();
    expect(sheet).toMatchObject({ kind: 'sheet', format: 'csv', title: 'Prices' });
    const stored = () => JSON.parse(readFileSync(path.join(dir, 'sheets', `${sheet.id}.json`), 'utf8'));
    expect(stored()).toEqual({ version: 1, csv: text });

    // It opens as an ordinary workbook and is listed with the spreadsheets, marked as CSV.
    res = await app.inject({ method: 'GET', url: `/api/sheets/${sheet.id}`, headers: { cookie } });
    const { workbook } = res.json();
    expect(res.json().sheet.format).toBe('csv');
    expect(workbook.tabs[0].cells).toEqual({ A1: { v: 'Item' }, B1: { v: 'Price, each' }, A2: { v: 'Pen' }, B2: { v: '1.50' } });
    res = await app.inject({ method: 'GET', url: '/api/sheets', headers: { cookie } });
    expect(res.json().sheets[0]).toMatchObject({ id: sheet.id, format: 'csv' });

    // Edits are written back as CSV, keeping the file's line endings.
    workbook.tabs[0].cells.A3 = { v: 'Total' };
    workbook.tabs[0].cells.B3 = { v: '=B2*2' };
    res = await app.inject({ method: 'PUT', url: `/api/sheets/${sheet.id}`, headers: { cookie }, payload: { workbook } });
    expect(res.json().sheet.format).toBe('csv');
    expect(stored()).toEqual({ version: 1, csv: 'Item,"Price, each"\r\nPen,1.50\r\nTotal,=B2*2\r\n' });

    // It downloads as the CSV file by default.
    res = await app.inject({ method: 'GET', url: `/api/files/${sheet.id}/export`, headers: { cookie } });
    expect(res.headers['content-disposition']).toContain('Prices.csv');
    expect(res.body).toBe('Item,"Price, each"\nPen,1.50\nTotal,=B2*2\n');

    // Converting makes it a native spreadsheet with the same content.
    res = await app.inject({ method: 'POST', url: `/api/sheets/${sheet.id}/convert`, headers: { cookie }, payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json().sheet.format).toBeUndefined();
    expect(stored().tabs[0].cells.B3).toEqual({ v: '=B2*2' });
    workbook.tabs[0].cells.A1 = { v: 'Item', st: { b: true } };
    res = await app.inject({ method: 'PUT', url: `/api/sheets/${sheet.id}`, headers: { cookie }, payload: { workbook } });
    res = await app.inject({ method: 'GET', url: `/api/sheets/${sheet.id}`, headers: { cookie } });
    expect(res.json().sheet.format).toBeUndefined();
    expect(res.json().workbook.tabs[0].cells.A1).toEqual({ v: 'Item', st: { b: true } });
  });

  it('becomes a native spreadsheet rather than drop what CSV cannot store', async () => {
    const { cookie } = await signUp(app, box, 'csv2@x.com');
    let res = await app.inject({ method: 'POST', url: '/api/sheets', headers: { cookie }, payload: { title: 'Data', csv: 'a,b\n1,2\n' } });
    const { sheet } = res.json();
    res = await app.inject({ method: 'GET', url: `/api/sheets/${sheet.id}`, headers: { cookie } });
    const { workbook } = res.json();
    workbook.tabs[0].frozenRows = 1;
    res = await app.inject({ method: 'PUT', url: `/api/sheets/${sheet.id}`, headers: { cookie }, payload: { workbook } });
    expect(res.json().sheet.format).toBeUndefined();
    res = await app.inject({ method: 'GET', url: `/api/sheets/${sheet.id}`, headers: { cookie } });
    expect(res.json().sheet.format).toBeUndefined();
    expect(res.json().workbook.tabs[0]).toMatchObject({ frozenRows: 1, cells: { A1: { v: 'a' }, B2: { v: '2' } } });
  });

  it('rejects CSV that is not text or is too large', async () => {
    const { cookie } = await signUp(app, box, 'csv3@x.com');
    let res = await app.inject({ method: 'POST', url: '/api/sheets', headers: { cookie }, payload: { title: 'x', csv: 5 } });
    expect(res.statusCode).toBe(400);
    res = await app.inject({ method: 'POST', url: '/api/sheets', headers: { cookie }, payload: { title: 'x', csv: 'a'.repeat(10 * 1024 * 1024 + 1) } });
    expect(res.statusCode).toBe(400);
  });
});

describe('legacy hosts', () => {
  it('redirects retired host names to the app URL, keeping the path', async () => {
    const d = mkdtempSync(path.join(tmpdir(), 'sheetsweb-host-test-'));
    const a = await buildApp({ dataDir: d, appUrl: 'https://docs.example.com', legacyHosts: ['sheets.example.com'] });
    try {
      let res = await a.inject({ method: 'GET', url: '/s/abc?x=1', headers: { host: 'sheets.example.com' } });
      expect(res.statusCode).toBe(301);
      expect(res.headers.location).toBe('https://docs.example.com/s/abc?x=1');
      res = await a.inject({ method: 'GET', url: '/api/health', headers: { host: 'SHEETS.example.com:443' } });
      expect(res.statusCode).toBe(200); // a port suffix is not the retired host; only exact matches redirect
      res = await a.inject({ method: 'GET', url: '/api/health', headers: { host: 'docs.example.com' } });
      expect(res.statusCode).toBe(200);
    } finally {
      await a.close();
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe('documents', () => {
  it('creates, saves, lists, renames and deletes documents, kept apart from spreadsheets and decks', async () => {
    const { cookie } = await signUp(app, box, 'doc@x.com');
    const { cookie: other } = await signUp(app, box, 'doc2@x.com');
    let res;

    res = await app.inject({ method: 'POST', url: '/api/docs', headers: { cookie }, payload: { title: 'Notes' } });
    expect(res.statusCode).toBe(200);
    const { doc: meta } = res.json();
    expect(meta).toMatchObject({ title: 'Notes', kind: 'doc' });
    expect(readdirSync(path.join(dir, 'sheets'))).toContain(`${meta.id}.json`);

    res = await app.inject({ method: 'GET', url: `/api/docs/${meta.id}`, headers: { cookie } });
    const { doc } = res.json();
    expect(doc.content.content).toHaveLength(1);

    doc.content.content = [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'Hello', marks: [{ type: 'bold' }] }] }, { type: 'paragraph' }];
    res = await app.inject({ method: 'PUT', url: `/api/docs/${meta.id}`, headers: { cookie }, payload: { doc } });
    expect(res.statusCode).toBe(200);
    res = await app.inject({ method: 'GET', url: `/api/docs/${meta.id}`, headers: { cookie } });
    expect(res.json().doc.content.content[0].content[0].text).toBe('Hello');

    // Invalid documents are rejected; the document is not a spreadsheet or a deck and vice versa.
    res = await app.inject({ method: 'PUT', url: `/api/docs/${meta.id}`, headers: { cookie }, payload: { doc: { version: 1, content: { type: 'doc', content: [{ type: 'bogus' }] } } } });
    expect(res.statusCode).toBe(400);
    res = await app.inject({ method: 'PUT', url: `/api/docs/${meta.id}`, headers: { cookie }, payload: { doc: { version: 1, content: { type: 'doc', content: [{ type: 'image', attrs: { src: 'javascript:1' } }] } } } });
    expect(res.statusCode).toBe(400);
    res = await app.inject({ method: 'POST', url: '/api/docs', headers: { cookie }, payload: { title: 'Bad', doc: { version: 2 } } });
    expect(res.statusCode).toBe(400);
    res = await app.inject({ method: 'GET', url: `/api/sheets/${meta.id}`, headers: { cookie } });
    expect(res.statusCode).toBe(404);
    res = await app.inject({ method: 'GET', url: `/api/decks/${meta.id}`, headers: { cookie } });
    expect(res.statusCode).toBe(404);
    res = await app.inject({ method: 'POST', url: '/api/decks', headers: { cookie }, payload: { title: 'A deck' } });
    res = await app.inject({ method: 'GET', url: `/api/docs/${res.json().deck.id}`, headers: { cookie } });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'GET', url: '/api/docs', headers: { cookie } });
    expect(res.json().docs.map((d: { title: string }) => d.title)).toEqual(['Notes']);
    res = await app.inject({ method: 'GET', url: '/api/decks', headers: { cookie } });
    expect(res.json().decks.map((d: { title: string }) => d.title)).toEqual(['A deck']);
    res = await app.inject({ method: 'GET', url: `/api/docs/${meta.id}`, headers: { cookie: other } });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'PATCH', url: `/api/docs/${meta.id}`, headers: { cookie }, payload: { title: 'Notes 2026' } });
    expect(res.json().meta.title).toBe('Notes 2026');

    // Word import: a new document from the upload, or just the converted blocks.
    const docx = await buildDocx('<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>From Word</w:t></w:r></w:p><w:p><w:r><w:t>Body.</w:t></w:r></w:p>');
    res = await app.inject({ method: 'POST', url: '/api/docs/import?title=Memo', headers: { cookie, 'content-type': 'application/octet-stream' }, payload: docx });
    expect(res.statusCode).toBe(200);
    expect(res.json().doc).toMatchObject({ title: 'Memo', kind: 'doc' });
    res = await app.inject({ method: 'GET', url: `/api/docs/${res.json().doc.id}`, headers: { cookie } });
    expect(res.json().doc.content.content[0]).toMatchObject({ type: 'heading', attrs: { level: 1 } });
    // PDF import: stored as a file only; no document is created.
    const docsBefore = (await app.inject({ method: 'GET', url: '/api/docs', headers: { cookie } })).json().docs.length;
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Length 40 >>\nstream\nBT /F1 12 Tf 72 700 Td (Hello PDF) Tj ET\nendstream\nendobj\n%%EOF');
    res = await app.inject({ method: 'POST', url: '/api/import/pdf?filename=Scan.pdf', headers: { cookie, 'content-type': 'application/octet-stream' }, payload: pdf });
    expect(res.statusCode).toBe(200);
    expect(res.json().file).toMatchObject({ filename: 'Scan.pdf', type: 'application/pdf' });
    res = await app.inject({ method: 'GET', url: '/api/files', headers: { cookie } });
    expect(res.json().files[0]).toMatchObject({ filename: 'Scan.pdf', type: 'application/pdf' });
    res = await app.inject({ method: 'GET', url: '/api/docs', headers: { cookie } });
    expect(res.json().docs.length).toBe(docsBefore);
    res = await app.inject({ method: 'POST', url: '/api/import/pdf?filename=x.pdf', headers: { cookie, 'content-type': 'application/octet-stream' }, payload: Buffer.from('garbage') });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/not a valid PDF/);
    res = await app.inject({ method: 'POST', url: '/api/import/docx', headers: { cookie, 'content-type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }, payload: docx });
    expect(res.json().doc.content.content).toHaveLength(2);
    res = await app.inject({ method: 'POST', url: '/api/import/docx', headers: { cookie, 'content-type': 'application/octet-stream' }, payload: Buffer.from('garbage') });
    expect(res.statusCode).toBe(400);
    res = await app.inject({ method: 'DELETE', url: `/api/docs/${meta.id}`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(readdirSync(path.join(dir, 'sheets'))).not.toContain(`${meta.id}.json`);
  });
});

describe('markdown documents', () => {
  it('creates from text, saves with revision checks, lists, exports, renames and deletes, kept apart from other kinds', async () => {
    const { cookie } = await signUp(app, box, 'md@x.com');
    const { cookie: other } = await signUp(app, box, 'md2@x.com');
    let res;

    res = await app.inject({ method: 'POST', url: '/api/markdown', headers: { cookie }, payload: { title: 'README', text: '# Hello\n\n- [x] done' } });
    expect(res.statusCode).toBe(200);
    const { doc: meta } = res.json();
    expect(meta).toMatchObject({ title: 'README', kind: 'markdown' });
    expect(readdirSync(path.join(dir, 'sheets'))).toContain(`${meta.id}.json`);

    res = await app.inject({ method: 'GET', url: `/api/markdown/${meta.id}`, headers: { cookie } });
    expect(res.json().doc).toEqual({ version: 1, text: '# Hello\n\n- [x] done' });

    // Saves carry the revision loaded; a stale one is refused with the current metadata.
    res = await app.inject({ method: 'PUT', url: `/api/markdown/${meta.id}`, headers: { cookie }, payload: { doc: { version: 1, text: '# Hi' }, rev: meta.updatedAt } });
    expect(res.statusCode).toBe(200);
    const rev = res.json().meta.updatedAt;
    res = await app.inject({ method: 'PUT', url: `/api/markdown/${meta.id}`, headers: { cookie }, payload: { doc: { version: 1, text: '# Stale' }, rev: meta.updatedAt } });
    expect(res.statusCode).toBe(409);
    expect(res.json().meta.updatedAt).toBe(rev);
    res = await app.inject({ method: 'GET', url: `/api/markdown/${meta.id}`, headers: { cookie } });
    expect(res.json().doc.text).toBe('# Hi');

    // Invalid documents are rejected; the document is not a text document, spreadsheet or deck and vice versa.
    res = await app.inject({ method: 'PUT', url: `/api/markdown/${meta.id}`, headers: { cookie }, payload: { doc: { version: 1, text: 5 } } });
    expect(res.statusCode).toBe(400);
    res = await app.inject({ method: 'POST', url: '/api/markdown', headers: { cookie }, payload: { title: 'Bad', text: {} } });
    expect(res.statusCode).toBe(400);
    for (const url of [`/api/docs/${meta.id}`, `/api/sheets/${meta.id}`, `/api/decks/${meta.id}`]) {
      res = await app.inject({ method: 'GET', url, headers: { cookie } });
      expect(res.statusCode).toBe(404);
    }
    res = await app.inject({ method: 'POST', url: '/api/docs', headers: { cookie }, payload: { title: 'Notes' } });
    res = await app.inject({ method: 'GET', url: `/api/markdown/${res.json().doc.id}`, headers: { cookie } });
    expect(res.statusCode).toBe(404);
    res = await app.inject({ method: 'GET', url: '/api/markdown', headers: { cookie } });
    expect(res.json().docs.map((d: { title: string }) => d.title)).toEqual(['README']);
    res = await app.inject({ method: 'GET', url: '/api/docs', headers: { cookie } });
    expect(res.json().docs.map((d: { title: string }) => d.title)).toEqual(['Notes']);
    res = await app.inject({ method: 'GET', url: `/api/markdown/${meta.id}`, headers: { cookie: other } });
    expect(res.statusCode).toBe(404);

    // Exports: the text itself as .md (the default), or the stored JSON.
    res = await app.inject({ method: 'GET', url: `/api/files/${meta.id}/export`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/markdown');
    expect(res.headers['content-disposition']).toContain('README.md');
    expect(res.body).toBe('# Hi');
    res = await app.inject({ method: 'GET', url: `/api/files/${meta.id}/export?format=xlsx`, headers: { cookie } });
    expect(res.statusCode).toBe(400);

    res = await app.inject({ method: 'PATCH', url: `/api/markdown/${meta.id}`, headers: { cookie }, payload: { title: 'README 2026' } });
    expect(res.json().meta.title).toBe('README 2026');
    res = await app.inject({ method: 'DELETE', url: `/api/markdown/${meta.id}`, headers: { cookie: other } });
    expect(res.statusCode).toBe(404);
    res = await app.inject({ method: 'DELETE', url: `/api/markdown/${meta.id}`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    res = await app.inject({ method: 'GET', url: `/api/markdown/${meta.id}`, headers: { cookie } });
    expect(res.statusCode).toBe(404);
    expect(readdirSync(path.join(dir, 'sheets'))).not.toContain(`${meta.id}.json`);
  });
});

describe('presentations', () => {
  it('creates, saves, lists, renames and deletes decks, kept apart from spreadsheets', async () => {
    const { cookie } = await signUp(app, box, 'deck@x.com');
    const { cookie: other } = await signUp(app, box, 'deck2@x.com');
    let res;

    res = await app.inject({ method: 'POST', url: '/api/decks', headers: { cookie }, payload: { title: 'Kickoff' } });
    expect(res.statusCode).toBe(200);
    const { deck: meta } = res.json();
    expect(meta).toMatchObject({ title: 'Kickoff', kind: 'deck' });
    expect(readdirSync(path.join(dir, 'sheets'))).toContain(`${meta.id}.json`);

    res = await app.inject({ method: 'GET', url: `/api/decks/${meta.id}`, headers: { cookie } });
    const { deck } = res.json();
    expect(deck.slides).toHaveLength(1);
    expect(deck.theme).toBe('light');

    deck.theme = 'dark';
    deck.slides.push({ id: 's2', layout: 'blank', elements: [{ id: 'e1', type: 'text', x: 10, y: 10, w: 300, h: 60, paragraphs: [{ text: 'Hello', bullet: true }] }] });
    res = await app.inject({ method: 'PUT', url: `/api/decks/${meta.id}`, headers: { cookie }, payload: { deck } });
    expect(res.statusCode).toBe(200);
    res = await app.inject({ method: 'GET', url: `/api/decks/${meta.id}`, headers: { cookie } });
    expect(res.json().deck.slides[1].elements[0].paragraphs[0].text).toBe('Hello');

    // Invalid decks are rejected; the deck is not a spreadsheet and vice versa.
    res = await app.inject({ method: 'PUT', url: `/api/decks/${meta.id}`, headers: { cookie }, payload: { deck: { version: 1, theme: 'light', slides: [] } } });
    expect(res.statusCode).toBe(400);
    res = await app.inject({ method: 'POST', url: '/api/decks', headers: { cookie }, payload: { title: 'Bad', deck: { version: 2 } } });
    expect(res.statusCode).toBe(400);
    res = await app.inject({ method: 'GET', url: `/api/sheets/${meta.id}`, headers: { cookie } });
    expect(res.statusCode).toBe(404);
    res = await app.inject({ method: 'POST', url: '/api/sheets', headers: { cookie }, payload: { title: 'A sheet' } });
    const sheetId = res.json().sheet.id;
    res = await app.inject({ method: 'GET', url: `/api/decks/${sheetId}`, headers: { cookie } });
    expect(res.statusCode).toBe(404);
    res = await app.inject({ method: 'DELETE', url: `/api/decks/${sheetId}`, headers: { cookie } });
    expect(res.statusCode).toBe(404);

    // Lists stay separate, and other users see nothing.
    res = await app.inject({ method: 'GET', url: '/api/decks', headers: { cookie } });
    expect(res.json().decks.map((d: { title: string }) => d.title)).toEqual(['Kickoff']);
    res = await app.inject({ method: 'GET', url: '/api/sheets', headers: { cookie } });
    expect(res.json().sheets.map((s: { title: string; kind: string }) => [s.title, s.kind])).toEqual([['A sheet', 'sheet']]);
    res = await app.inject({ method: 'GET', url: `/api/decks/${meta.id}`, headers: { cookie: other } });
    expect(res.statusCode).toBe(404);

    res = await app.inject({ method: 'PATCH', url: `/api/decks/${meta.id}`, headers: { cookie }, payload: { title: 'Kickoff 2026' } });
    expect(res.json().meta.title).toBe('Kickoff 2026');

    // PowerPoint import: a new deck from the upload, or just the converted slides.
    const { pres } = await buildPptx({ version: 1, theme: 'light', slides: [buildSlide('title-body', { title: 'From PowerPoint', body: ['One', 'Two'] }, newId)] }, 'x', async () => null);
    const pptx = Buffer.from((await pres.write({ outputType: 'nodebuffer' })) as Buffer);
    res = await app.inject({ method: 'POST', url: '/api/decks/import?title=Slides', headers: { cookie, 'content-type': 'application/octet-stream' }, payload: pptx });
    expect(res.statusCode).toBe(200);
    expect(res.json().deck).toMatchObject({ title: 'Slides', kind: 'deck' });
    res = await app.inject({ method: 'GET', url: `/api/decks/${res.json().deck.id}`, headers: { cookie } });
    expect(res.json().deck.slides[0].elements[0].paragraphs[0].text).toBe('From PowerPoint');
    res = await app.inject({ method: 'POST', url: '/api/import/pptx', headers: { cookie, 'content-type': 'application/octet-stream' }, payload: pptx });
    expect(res.json().deck.slides).toHaveLength(1);
    res = await app.inject({ method: 'POST', url: '/api/import/pptx', headers: { cookie, 'content-type': 'application/octet-stream' }, payload: Buffer.from('garbage') });
    expect(res.statusCode).toBe(400);
    res = await app.inject({ method: 'DELETE', url: `/api/decks/${meta.id}`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(readdirSync(path.join(dir, 'sheets'))).not.toContain(`${meta.id}.json`);
  });
});

describe('file ids', () => {
  it('gives new files a short id that every route takes', async () => {
    const { cookie } = await signUp(app, box, 'ids@x.com');
    let res = await app.inject({ method: 'POST', url: '/api/decks', headers: { cookie }, payload: { title: 'Short' } });
    const { id } = res.json().deck;
    expect(id).toMatch(/^[0-9a-z]{12}$/);
    res = await app.inject({ method: 'GET', url: `/api/decks/${id}`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    res = await app.inject({ method: 'GET', url: `/api/files/${id}/export?format=json`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    res = await app.inject({ method: 'POST', url: '/api/library/move', headers: { cookie }, payload: { id, kind: 'deck', folder: '' } });
    expect(res.statusCode).toBe(200);
    res = await app.inject({ method: 'POST', url: '/api/docs', headers: { cookie }, payload: { title: 'Also short' } });
    expect(res.json().doc.id).toMatch(/^[0-9a-z]{12}$/);
    res = await app.inject({ method: 'POST', url: '/api/sheets', headers: { cookie }, payload: { title: 'And this' } });
    expect(res.json().sheet.id).toMatch(/^[0-9a-z]{12}$/);
  });
});

describe('getting started', () => {
  afterEach(() => {
    delete process.env.GETTING_STARTED_DECK_ID;
  });

  it('copies the built-in guide into the account once, and returns that copy afterwards', async () => {
    const { cookie } = await signUp(app, box, 'guide1@x.com');
    let res = await app.inject({ method: 'POST', url: '/api/getting-started', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const first = res.json().deck;
    expect(first.title).toBe('Getting started');
    res = await app.inject({ method: 'GET', url: `/api/decks/${first.id}`, headers: { cookie } });
    expect(res.json().deck.slides.length).toBeGreaterThan(1);
    res = await app.inject({ method: 'POST', url: '/api/getting-started', headers: { cookie } });
    expect(res.json().deck.id).toBe(first.id);
    res = await app.inject({ method: 'GET', url: '/api/decks', headers: { cookie } });
    expect(res.json().decks).toHaveLength(1);
  });

  it('copies the presentation named by GETTING_STARTED_DECK_ID, with its pictures, from its owner', async () => {
    const { cookie: author } = await signUp(app, box, 'guide-author@x.com');
    const { cookie: reader } = await signUp(app, box, 'guide-reader@x.com');
    let res = await app.inject({ method: 'POST', url: '/api/images', headers: { cookie: author, 'content-type': 'image/png' }, payload: Buffer.from('picture') });
    const picture: string = res.json().url;
    const deck = { version: 1, theme: 'dark', slides: [{ id: 's1', elements: [{ id: 'e1', type: 'image', src: picture, x: 0, y: 0, w: 100, h: 100 }] }] };
    res = await app.inject({ method: 'POST', url: '/api/decks', headers: { cookie: author }, payload: { title: 'Guide (master)', deck } });
    expect(res.statusCode).toBe(200);
    const master = res.json().deck;
    process.env.GETTING_STARTED_DECK_ID = master.id;

    // Its owner gets the guide itself.
    res = await app.inject({ method: 'POST', url: '/api/getting-started', headers: { cookie: author } });
    expect(res.json().deck.id).toBe(master.id);

    res = await app.inject({ method: 'POST', url: '/api/getting-started', headers: { cookie: reader } });
    const copy = res.json().deck;
    expect(copy.id).not.toBe(master.id);
    expect(copy.title).toBe('Getting started');
    res = await app.inject({ method: 'GET', url: `/api/decks/${copy.id}`, headers: { cookie: reader } });
    expect(res.json().deck.theme).toBe('dark');
    const copied: string = res.json().deck.slides[0].elements[0].src;
    // The picture is the reader's own copy: the author's is not theirs to load.
    expect(copied).not.toBe(picture);
    res = await app.inject({ method: 'GET', url: copied, headers: { cookie: reader } });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('picture');
    res = await app.inject({ method: 'GET', url: picture, headers: { cookie: reader } });
    expect(res.statusCode).toBe(404);
    // The author's file is still only theirs.
    res = await app.inject({ method: 'GET', url: `/api/decks/${master.id}`, headers: { cookie: reader } });
    expect(res.statusCode).toBe(404);
  });

  it('falls back to the built-in guide when the named presentation is gone', async () => {
    process.env.GETTING_STARTED_DECK_ID = 'no-such-deck';
    const { cookie } = await signUp(app, box, 'guide3@x.com');
    const res = await app.inject({ method: 'POST', url: '/api/getting-started', headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json().deck.title).toBe('Getting started');
  });
});

describe('assistant settings', () => {
  it('keeps a Brave Search API key, checked, masked and removable', async () => {
    const { cookie } = await signUp(app, box, 'brave@x.com');
    const put = (payload: Record<string, unknown>) => app.inject({ method: 'PUT', url: '/api/settings/assistant', headers: { cookie }, payload });
    let res = await put({ provider: 'default', braveKey: 'BSA-bad' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('did not accept');

    res = await put({ provider: 'default', braveKey: 'BSA-good-key-1234' });
    expect(res.statusCode).toBe(200);
    expect(res.json().settings.braveKey).toMatch(/1234$/);
    expect(res.json().settings.braveKey).not.toContain('good');
    // Saving other settings keeps it; null removes it.
    res = await put({ provider: 'default' });
    expect(res.json().settings.braveKey).toMatch(/1234$/);
    res = await put({ provider: 'default', braveKey: null });
    expect(res.json().settings.braveKey).toBeNull();
  });
});

describe('stored files', () => {
  it('makes an edited copy of a picture with the image model, using the user\'s OpenAI key', async () => {
    delete process.env.OPENAI_API_KEY;
    const { cookie } = await signUp(app, box, 'pictures@x.com');
    const upload = (name: string, type: string, body: string) => app.inject({ method: 'POST', url: '/api/files', headers: { cookie, 'content-type': type, 'x-filename': name }, payload: Buffer.from(body) });
    const photo = (await upload('logo.jpg', 'image/jpeg', 'jpeg bytes')).json().file;
    const edit = (url: string, prompt: unknown) => app.inject({ method: 'POST', url: `${url}/edit-image`, headers: { cookie }, payload: { prompt } });

    // Without a key nothing is sent to the model.
    let res = await edit(photo.url, 'Make the background blue');
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('OpenAI API key');
    res = await app.inject({ method: 'PUT', url: '/api/settings/assistant', headers: { cookie }, payload: { provider: 'default', openaiModel: OPENAI_MODELS[0].id, openaiKey: 'sk-test-pictures' } });
    expect(res.statusCode).toBe(200);

    res = await edit(photo.url, 'Make the background blue');
    expect(res.statusCode).toBe(200);
    const made = res.json().file;
    expect(made).toMatchObject({ filename: 'logo-edited.png', type: 'image/png' });
    expect(made.id).not.toBe(photo.id);
    expect(imageEdits.at(-1)).toMatchObject({ apiKey: 'sk-test-pictures', filename: 'logo.jpg', type: 'image/jpeg', prompt: 'Make the background blue' });
    expect(imageEdits.at(-1)!.image.toString()).toBe('jpeg bytes');
    expect((await app.inject({ method: 'GET', url: made.url, headers: { cookie } })).payload).toBe('edited:Make the background blue');
    // The original is untouched.
    expect((await app.inject({ method: 'GET', url: photo.url, headers: { cookie } })).payload).toBe('jpeg bytes');

    const before = imageEdits.length;
    expect((await edit(photo.url, '  ')).statusCode).toBe(400);
    const page = (await upload('a.html', 'application/octet-stream', '<p>x</p>')).json().file;
    expect((await edit(page.url, 'Make it blue')).json().error).toContain('Only PNG, JPEG and WebP');
    expect((await app.inject({ method: 'POST', url: `${photo.url}/edit-image`, payload: { prompt: 'x' } })).statusCode).toBe(401);
    expect(imageEdits).toHaveLength(before);
  });

  it('finds a stored file by its folder and name, for pictures a Markdown document names by path', async () => {
    const { cookie } = await signUp(app, box, 'filesat@x.com');
    const { cookie: other } = await signUp(app, box, 'filesat2@x.com');
    expect((await app.inject({ method: 'POST', url: '/api/folders', headers: { cookie }, payload: { name: 'images' } })).statusCode).toBe(200);
    const shot = (await app.inject({ method: 'POST', url: '/api/files?folder=images', headers: { cookie, 'content-type': 'image/png', 'x-filename': 'shot.png' }, payload: Buffer.from('png bytes') })).json().file;
    const at = (q: string, c = cookie) => app.inject({ method: 'GET', url: `/api/files/at?${q}`, headers: { cookie: c } });

    const res = await at('folder=images&name=shot.png');
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe(`/api/files/${shot.id}`);
    expect((await at('name=shot.png')).statusCode).toBe(404);
    expect((await at('folder=images&name=../shot.png')).statusCode).toBe(404);
    expect((await at('folder=elsewhere&name=shot.png')).statusCode).toBe(404);
    expect((await at('folder=images&name=shot.png', other)).statusCode).toBe(404);
  });

  it('stores PDFs per owner, serves them inline and as downloads, and lists them newest first', async () => {
    const { cookie } = await signUp(app, box, 'files@x.com');
    const { cookie: other } = await signUp(app, box, 'files2@x.com');
    const pdf = Buffer.from('%PDF-1.4 test');
    let res = await app.inject({ method: 'POST', url: '/api/files', headers: { cookie, 'content-type': 'application/pdf', 'x-filename': encodeURIComponent('BizTrip Review.pdf') }, payload: pdf });
    expect(res.statusCode).toBe(200);
    const { file } = res.json();
    expect(file).toMatchObject({ filename: 'BizTrip Review.pdf', type: 'application/pdf', size: pdf.length, url: `/api/files/${file.id}`, downloadUrl: `/api/files/${file.id}/download` });
    res = await app.inject({ method: 'POST', url: '/api/files', headers: { cookie, 'content-type': 'application/octet-stream', 'x-filename': 'a.bin' }, payload: Buffer.from('xyz') });
    const second = res.json().file;

    // A rename keeps the extension, whether or not the new name has it, and is the owner's alone.
    const rename = (who: string, name: unknown) => app.inject({ method: 'PATCH', url: `/api/files/${file.id}`, headers: { cookie: who }, payload: { name } });
    expect((await rename(cookie, 'Q3/review')).json().file.filename).toBe('Q3_review.pdf');
    expect((await rename(cookie, 'BizTrip Review.PDF')).json().file.filename).toBe('BizTrip Review.pdf');
    expect((await rename(cookie, '  ')).statusCode).toBe(400);
    expect((await rename(other, 'mine')).statusCode).toBe(404);

    res = await app.inject({ method: 'GET', url: file.url, headers: { cookie } });
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toBe('inline');
    expect(res.rawPayload.equals(pdf)).toBe(true);
    res = await app.inject({ method: 'GET', url: file.downloadUrl, headers: { cookie } });
    expect(res.headers['content-disposition']).toContain('attachment; filename="BizTrip Review.pdf"');
    // Unknown types are never served inline.
    res = await app.inject({ method: 'GET', url: second.url, headers: { cookie } });
    expect(res.headers['content-disposition']).toContain('attachment');

    // A web page is stored as one by its name, but never served as a page: the viewer shows its text in a sandboxed frame.
    res = await app.inject({ method: 'POST', url: '/api/files', headers: { cookie, 'content-type': 'application/octet-stream', 'x-filename': 'chart.html' }, payload: Buffer.from('<script>alert(1)</script>') });
    const page = res.json().file;
    expect(page).toMatchObject({ filename: 'chart.html', type: 'text/html' });
    res = await app.inject({ method: 'GET', url: page.url, headers: { cookie } });
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.payload).toBe('<script>alert(1)</script>');
    expect((await app.inject({ method: 'GET', url: page.downloadUrl, headers: { cookie } })).headers['content-disposition']).toContain('attachment');
    // A text file can be rewritten, and the version before comes back with a revert; a PDF only as a PDF.
    res = await app.inject({ method: 'PUT', url: page.url, headers: { cookie, 'content-type': 'application/octet-stream' }, payload: Buffer.from('<p>light</p>') });
    expect(res.json().file).toMatchObject({ id: page.id, size: 12 });
    expect((await app.inject({ method: 'GET', url: page.url, headers: { cookie } })).payload).toBe('<p>light</p>');
    expect((await app.inject({ method: 'POST', url: `${page.url}/revert`, headers: { cookie } })).json().file).toMatchObject({ size: 25 });
    expect((await app.inject({ method: 'GET', url: page.url, headers: { cookie } })).payload).toBe('<script>alert(1)</script>');
    expect((await app.inject({ method: 'PUT', url: file.url, headers: { cookie, 'content-type': 'application/octet-stream' }, payload: Buffer.from('x') })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: `${file.url}/revert`, headers: { cookie } })).statusCode).toBe(404);
    // A signed PDF is saved over the PDF, and the one before comes back with a revert.
    expect((await app.inject({ method: 'PUT', url: file.url, headers: { cookie, 'content-type': 'application/pdf' }, payload: Buffer.from('not a pdf') })).statusCode).toBe(400);
    res = await app.inject({ method: 'PUT', url: file.url, headers: { cookie, 'content-type': 'application/pdf' }, payload: Buffer.from('%PDF-1.4 signed') });
    expect(res.json().file).toMatchObject({ id: file.id, type: 'application/pdf', size: 15 });
    expect((await app.inject({ method: 'POST', url: `${file.url}/revert`, headers: { cookie } })).json().file).toMatchObject({ size: pdf.length });
    expect((await app.inject({ method: 'GET', url: file.url, headers: { cookie } })).rawPayload.equals(pdf)).toBe(true);
    expect((await app.inject({ method: 'PUT', url: page.url, headers: { 'content-type': 'application/octet-stream' }, payload: Buffer.from('x') })).statusCode).toBe(401);
    // A picture can be saved over by the image editor, as the type it is; the version before comes back with a revert.
    const png = (n: number) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(n, 7)]);
    const pic = (await app.inject({ method: 'POST', url: '/api/files', headers: { cookie, 'content-type': 'image/png', 'x-filename': 'logo.png' }, payload: png(10) })).json().file;
    res = await app.inject({ method: 'GET', url: pic.url, headers: { cookie } });
    expect(res.headers['cache-control']).toBe('private, no-cache');
    const etag = String(res.headers.etag);
    expect((await app.inject({ method: 'GET', url: pic.url, headers: { cookie, 'if-none-match': etag } })).statusCode).toBe(304);
    res = await app.inject({ method: 'PUT', url: pic.url, headers: { cookie, 'content-type': 'image/png' }, payload: png(40) });
    expect(res.json().file).toMatchObject({ id: pic.id, type: 'image/png', size: 48 });
    res = await app.inject({ method: 'GET', url: pic.url, headers: { cookie, 'if-none-match': etag } });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.length).toBe(48);
    // Not as another type, and not bytes that are not a picture of that type.
    expect((await app.inject({ method: 'PUT', url: pic.url, headers: { cookie, 'content-type': 'image/jpeg' }, payload: Buffer.from([0xff, 0xd8, 0xff, 0]) })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PUT', url: pic.url, headers: { cookie, 'content-type': 'image/png' }, payload: Buffer.from('not a picture') })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: pic.url, headers: { cookie } })).rawPayload.length).toBe(48);
    expect((await app.inject({ method: 'POST', url: `${pic.url}/revert`, headers: { cookie } })).json().file).toMatchObject({ size: 18 });
    await app.inject({ method: 'DELETE', url: pic.url, headers: { cookie } });
    await app.inject({ method: 'DELETE', url: page.url, headers: { cookie } });

    res = await app.inject({ method: 'GET', url: '/api/files', headers: { cookie } });
    expect(res.json().files.map((f: { id: string }) => f.id)).toEqual([second.id, file.id]);
    expect(res.json().files).toHaveLength(2);

    // Other users and signed-out requests can't see it.
    expect((await app.inject({ method: 'GET', url: file.url, headers: { cookie: other } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/files', headers: { cookie: other } })).json().files).toEqual([]);
    expect((await app.inject({ method: 'GET', url: file.url })).statusCode).toBe(401);
    expect((await app.inject({ method: 'DELETE', url: file.url, headers: { cookie: other } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'DELETE', url: file.url, headers: { cookie } })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: `${file.url}/meta`, headers: { cookie } })).statusCode).toBe(404);
  });
});

describe('cell images', () => {
  it('stores large images as files referenced from cells, readable only by their owner', async () => {
    const { cookie } = await signUp(app, box, 'img@x.com');
    const { cookie: other } = await signUp(app, box, 'img2@x.com');
    let res;

    // A 50 MB PNG.
    const big = Buffer.alloc(50 * 1024 * 1024, 7);
    res = await app.inject({ method: 'POST', url: '/api/images', headers: { cookie, 'content-type': 'image/png' }, payload: big });
    expect(res.statusCode).toBe(200);
    const { url } = res.json();
    expect(url).toMatch(/^\/api\/images\/[0-9a-f-]{36}$/);

    res = await app.inject({ method: 'GET', url, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.rawPayload.equals(big)).toBe(true);
    res = await app.inject({ method: 'GET', url, headers: { cookie: other } });
    expect(res.statusCode).toBe(404);

    // The cell holds only the reference, and is saved with the sheet.
    res = await app.inject({ method: 'POST', url: '/api/sheets', headers: { cookie }, payload: { title: 'Team Budget' } });
    const { sheet } = res.json();
    const workbook = (await app.inject({ method: 'GET', url: `/api/sheets/${sheet.id}`, headers: { cookie } })).json().workbook;
    workbook.tabs[0].cells.A15 = { v: '', img: url };
    res = await app.inject({ method: 'PUT', url: `/api/sheets/${sheet.id}`, headers: { cookie }, payload: { workbook } });
    expect(res.statusCode).toBe(200);
    res = await app.inject({ method: 'GET', url: `/api/sheets/${sheet.id}`, headers: { cookie } });
    expect(res.json().workbook.tabs[0].cells.A15).toEqual({ v: '', img: url });

    // Over 100 MB, other types and signed-out uploads are refused.
    res = await app.inject({ method: 'POST', url: '/api/images', headers: { cookie, 'content-type': 'image/png' }, payload: Buffer.alloc(100 * 1024 * 1024 + 1) });
    expect(res.statusCode).toBe(413);
    res = await app.inject({ method: 'POST', url: '/api/images', headers: { cookie, 'content-type': 'image/svg+xml' }, payload: '<svg/>' });
    expect(res.statusCode).toBe(415);
    res = await app.inject({ method: 'POST', url: '/api/images', headers: { 'content-type': 'image/png' }, payload: Buffer.from('x') });
    expect(res.statusCode).toBe(401);
  });
});

describe('branches', () => {
  it('branches a sheet, compares against the live original, and detaches when it is deleted', async () => {
    const { cookie } = await signUp(app, box, 'br@x.com');
    let res;
    const put = (id: string, workbook: unknown) => app.inject({ method: 'PUT', url: `/api/sheets/${id}`, headers: { cookie }, payload: { workbook } });

    res = await app.inject({ method: 'POST', url: '/api/sheets', headers: { cookie }, payload: { title: 'Plan' } });
    const orig = res.json().sheet;
    const wb = (await app.inject({ method: 'GET', url: `/api/sheets/${orig.id}`, headers: { cookie } })).json().workbook;
    wb.tabs[0].cells.A1 = { v: 'v1' };
    await put(orig.id, wb);

    res = await app.inject({ method: 'POST', url: `/api/sheets/${orig.id}/branch`, headers: { cookie }, payload: {} });
    const branch = res.json().sheet;
    expect(branch.title).toBe('Plan (branch)');
    expect(branch.branch).toMatchObject({ parentId: orig.id, parentTitle: 'Plan', detached: false });
    expect(readdirSync(path.join(dir, 'sheets'))).toContain(`${branch.id}.base.json`);

    // The original moves on; compare returns the base snapshot plus the original's current state.
    wb.tabs[0].cells.A1 = { v: 'v2' };
    await put(orig.id, wb);
    await app.inject({ method: 'PATCH', url: `/api/sheets/${orig.id}`, headers: { cookie }, payload: { title: 'Plan 2027' } });
    res = await app.inject({ method: 'GET', url: `/api/sheets/${branch.id}/compare`, headers: { cookie } });
    const cmp = res.json();
    expect(cmp.base.tabs[0].cells.A1.v).toBe('v1');
    expect(cmp.original.tabs[0].cells.A1.v).toBe('v2');
    expect(cmp.meta.branch.parentTitle).toBe('Plan 2027');

    res = await app.inject({ method: 'GET', url: `/api/sheets/${orig.id}/compare`, headers: { cookie } });
    expect(res.statusCode).toBe(400);

    // Deleting the original detaches the branch but keeps it comparable against the base.
    await app.inject({ method: 'DELETE', url: `/api/sheets/${orig.id}`, headers: { cookie } });
    res = await app.inject({ method: 'GET', url: `/api/sheets/${branch.id}/compare`, headers: { cookie } });
    expect(res.json().original).toBe(null);
    expect(res.json().meta.branch).toMatchObject({ detached: true, parentTitle: 'Plan' });

    await app.inject({ method: 'DELETE', url: `/api/sheets/${branch.id}`, headers: { cookie } });
    expect(readdirSync(path.join(dir, 'sheets'))).not.toContain(`${branch.id}.base.json`);
  });

  it('migrates a database created before branches existed', async () => {
    const { DatabaseSync } = await import('node:sqlite');
    const { openDb } = await import('./db.ts');
    const file = path.join(dir, 'old.db');
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE sheets (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, title TEXT NOT NULL, file TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      INSERT INTO sheets VALUES ('s1', 'u1', 'Old', 's1.json', 'x', 'x');`);
    old.close();
    const db = openDb(file);
    const cols = (db.prepare('PRAGMA table_info(sheets)').all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(expect.arrayContaining(['parent_id', 'parent_title', 'branched_at']));
    expect((db.prepare('SELECT title, parent_id FROM sheets').get() as { title: string; parent_id: null }).parent_id).toBe(null);
    db.close();
  });
});

describe('files of any kind', () => {
  it('are kept as they are, typed by their name when the app knows it', async () => {
    const { cookie } = await signUp(app, box, 'anyfile@x.com');
    const upload = (name: string) => app.inject({ method: 'POST', url: '/api/files', headers: { cookie, 'content-type': 'application/octet-stream', 'x-filename': name }, payload: Buffer.from([0x50, 0x4b, 3, 4, 0, 1]) });
    const zip = (await upload('photos.zip')).json().file;
    expect(zip).toMatchObject({ filename: 'photos.zip', type: 'application/zip' });
    const odd = (await upload('model.blend')).json().file;
    expect(odd).toMatchObject({ filename: 'model.blend', type: 'application/octet-stream' });
    const listed = (await app.inject({ method: 'GET', url: '/api/library', headers: { cookie } })).json() as { files: { filename: string }[] };
    expect(listed.files.map((f) => f.filename).sort()).toEqual(['model.blend', 'photos.zip']);
    // Not shown in the page: downloaded, as the bytes it was.
    const res = await app.inject({ method: 'GET', url: odd.url, headers: { cookie } });
    expect(res.headers['content-disposition']).toMatch(/^attachment/);
    expect(res.rawPayload).toEqual(Buffer.from([0x50, 0x4b, 3, 4, 0, 1]));
  });
});

describe('plain text files', () => {
  it('are found by their bytes, whatever their name, and can be rewritten', async () => {
    const { cookie } = await signUp(app, box, 'plaintext@x.com');
    const upload = (name: string, bytes: Buffer) => app.inject({ method: 'POST', url: '/api/files', headers: { cookie, 'content-type': 'application/octet-stream', 'x-filename': name }, payload: bytes });
    const log = (await upload('server.log', Buffer.from('started\r\nlistening on 3001 — ok ✓\r\n'))).json().file;
    const makefile = (await upload('Makefile', Buffer.from('all:\n\techo hi\n'))).json().file;
    const binary = (await upload('blob.bin', Buffer.from([0x50, 0x4b, 0, 1, 2]))).json().file;
    const latin1 = (await upload('old.txt', Buffer.from([0x63, 0x61, 0x66, 0xe9]))).json().file;
    expect([log.text, makefile.text, binary.text, latin1.text]).toEqual([true, true, undefined, undefined]);
    const listed = (await app.inject({ method: 'GET', url: '/api/library', headers: { cookie } })).json() as { files: { filename: string; text?: boolean }[] };
    expect(listed.files.filter((f) => f.text).map((f) => f.filename).sort()).toEqual(['Makefile', 'server.log']);

    const put = await app.inject({ method: 'PUT', url: makefile.url, headers: { cookie, 'content-type': 'application/octet-stream' }, payload: Buffer.from('all:\n\techo bye\n') });
    expect(put.statusCode).toBe(200);
    expect(put.json().file).toMatchObject({ filename: 'Makefile', text: true, size: 15 });
    expect((await app.inject({ method: 'GET', url: makefile.url, headers: { cookie } })).body).toBe('all:\n\techo bye\n');
  });
});

describe('video files', () => {
  it('are stored by their extension and served in the parts a player asks for', async () => {
    const { cookie } = await signUp(app, box, 'video@x.com');
    const bytes = Buffer.from('0123456789abcdefghij');
    const up = await app.inject({ method: 'POST', url: '/api/files', headers: { cookie, 'content-type': 'video/quicktime', 'x-filename': 'clip.mov' }, payload: bytes });
    expect(up.statusCode).toBe(200);
    const file = (up.json() as { file: { url: string; type: string } }).file;
    expect(file.type).toBe('video/quicktime');

    const whole = await app.inject({ method: 'GET', url: file.url, headers: { cookie } });
    expect(whole.statusCode).toBe(200);
    // Served as MP4 so browsers play it, and seekable.
    expect(whole.headers['content-type']).toBe('video/mp4');
    expect(whole.headers['accept-ranges']).toBe('bytes');
    expect(whole.headers['content-length']).toBe('20');

    const part = await app.inject({ method: 'GET', url: file.url, headers: { cookie, range: 'bytes=5-9' } });
    expect(part.statusCode).toBe(206);
    expect(part.headers['content-range']).toBe('bytes 5-9/20');
    expect(part.body).toBe('56789');
    const tail = await app.inject({ method: 'GET', url: file.url, headers: { cookie, range: 'bytes=-4' } });
    expect([tail.headers['content-range'], tail.body]).toEqual(['bytes 16-19/20', 'ghij']);
    const rest = await app.inject({ method: 'GET', url: file.url, headers: { cookie, range: 'bytes=15-' } });
    expect([rest.headers['content-range'], rest.body]).toEqual(['bytes 15-19/20', 'fghij']);
    expect((await app.inject({ method: 'GET', url: file.url, headers: { cookie, range: 'bytes=50-' } })).statusCode).toBe(416);

    // A download (a log, say) is read in parts too: what the text editor's Tail asks for as it grows.
    const log = (await app.inject({ method: 'POST', url: '/api/files', headers: { cookie, 'content-type': 'application/octet-stream', 'x-filename': 'run.log' }, payload: Buffer.from('one\ntwo\n') })).json().file as { url: string };
    const more = await app.inject({ method: 'GET', url: log.url, headers: { cookie, range: 'bytes=4-' } });
    expect([more.statusCode, more.headers['content-range'], more.body]).toEqual([206, 'bytes 4-7/8', 'two\n']);
    expect(more.headers['content-disposition']).toMatch(/^attachment/);
    const none = await app.inject({ method: 'GET', url: log.url, headers: { cookie, range: 'bytes=8-' } });
    expect([none.statusCode, none.headers['content-range']]).toEqual([416, 'bytes */8']);
  });
});

describe('a picture from the web for a slide', () => {
  it('is fetched by the server and stored like an upload, not as a file in the library', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'webimg-'));
    const box = mailbox();
    const a = await buildApp({ dataDir: dir, sendMail: box.send });
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20, 3)]);
    const realLookup = resolver.lookup;
    resolver.lookup = async (host) => (host === 'intranet.example' ? ['10.0.0.8'] : ['93.184.216.34']);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input);
      if (url === 'https://logos.example/openai.png') return new Response(new Uint8Array(png), { headers: { 'content-type': 'image/png' } });
      if (url === 'https://logos.example/page') return new Response('<html>not a picture</html>', { headers: { 'content-type': 'text/html' } });
      return new Response('nope', { status: 404 });
    });
    try {
      const { cookie } = await signUp(a, box, 'slides@x.com', 'password-12345');
      const keep = (url: unknown, c = cookie) => a.inject({ method: 'POST', url: '/api/images/fetch', headers: c ? { cookie: c } : {}, payload: { url } });
      expect((await keep('https://logos.example/openai.png', '')).statusCode).toBe(401);
      const kept = await keep('https://logos.example/openai.png');
      expect(kept.statusCode).toBe(200);
      expect(kept.json().url).toMatch(/^\/api\/images\/[0-9a-f-]{36}$/);
      const served = await a.inject({ method: 'GET', url: kept.json().url, headers: { cookie } });
      expect(served.headers['content-type']).toBe('image/png');
      expect(served.rawPayload.equals(png)).toBe(true);
      // Nothing was added to the user's files.
      expect((await a.inject({ method: 'GET', url: '/api/files', headers: { cookie } })).json().files).toEqual([]);
      // Not a picture, not there, not on the public internet, not an address.
      expect((await keep('https://logos.example/page')).json().error).toContain('does not hold a PNG');
      expect((await keep('https://logos.example/missing.png')).statusCode).toBe(400);
      expect((await keep('https://intranet.example/logo.png')).statusCode).toBe(400);
      expect((await keep('file:///etc/passwd')).statusCode).toBe(400);
      expect((await keep(42)).statusCode).toBe(400);
    } finally {
      fetchSpy.mockRestore();
      resolver.lookup = realLookup;
      await a.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('a spreadsheet range for a slide table', () => {
  it('reads the range as table cells with the revision, for the owner only', async () => {
    const { cookie } = await signUp(app, box, 'table-range@example.com');
    let res = await app.inject({ method: 'POST', url: '/api/sheets', headers: { cookie }, payload: { title: 'Figures' } });
    const sheet = res.json().sheet as { id: string };
    const workbook = { version: 1, tabs: [{ id: 'tab-a', name: 'Data', rows: 100, cols: 26, cells: { A1: { v: 'Item', st: { b: true } }, B1: { v: 'Cost' }, A2: { v: 'Pens' }, B2: { v: '=2+3' } }, colWidths: {}, rowHeights: {} }] };
    res = await app.inject({ method: 'PUT', url: `/api/sheets/${sheet.id}`, headers: { cookie }, payload: { workbook } });
    expect(res.statusCode).toBe(200);
    const rev = res.json().sheet.updatedAt as string;

    res = await app.inject({ method: 'GET', url: `/api/sheets/${sheet.id}/table?range=Data!A1:B2`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ title: 'Figures', rev, tabId: 'tab-a', tab: 'Data', range: 'A1:B2', rows: [[{ text: 'Item', bold: true }, { text: 'Cost' }], [{ text: 'Pens' }, { text: '5', align: 'right' }]] });

    res = await app.inject({ method: 'GET', url: `/api/sheets/${sheet.id}/table?range=Q1:Q2`, headers: { cookie } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/empty/);
    const other = await signUp(app, box, 'table-range-other@example.com');
    res = await app.inject({ method: 'GET', url: `/api/sheets/${sheet.id}/table`, headers: { cookie: other.cookie } });
    expect(res.statusCode).toBe(404);
  });
});

describe("a spreadsheet's charts for a slide", () => {
  it('lists the charts and reads one with its data, for the owner', async () => {
    const { cookie } = await signUp(app, box, 'sheet-charts@example.com');
    let res = await app.inject({ method: 'POST', url: '/api/sheets', headers: { cookie }, payload: { title: 'Charted' } });
    const sheet = res.json().sheet as { id: string };
    const chart = { id: 'ch1', type: 'column', anchor: { r: 0, c: 3, dx: 0, dy: 0 }, w: 500, h: 300, title: 'Costs', categories: 'A2:A3', series: [{ values: 'B2:B3', nameRef: 'B1' }] };
    const workbook = { version: 1, tabs: [{ id: 'tab-a', name: 'Data', rows: 100, cols: 26, cells: { A1: { v: 'Item' }, B1: { v: 'Cost' }, A2: { v: 'Pens' }, B2: { v: '=2+3' }, A3: { v: 'Ink' }, B3: { v: '7' } }, colWidths: {}, rowHeights: {}, charts: [chart] }] };
    res = await app.inject({ method: 'PUT', url: `/api/sheets/${sheet.id}`, headers: { cookie }, payload: { workbook } });
    expect(res.statusCode).toBe(200);
    res = await app.inject({ method: 'GET', url: `/api/sheets/${sheet.id}/charts`, headers: { cookie } });
    expect(res.json()).toEqual({ title: 'Charted', charts: [{ id: 'ch1', tabId: 'tab-a', tab: 'Data', type: 'column', title: 'Costs' }] });
    res = await app.inject({ method: 'GET', url: `/api/sheets/${sheet.id}/chart?chart=ch1`, headers: { cookie } });
    expect(res.json()).toMatchObject({ title: 'Charted', tab: 'Data', w: 500, h: 300, chart: { type: 'column', title: 'Costs' }, data: { categories: ['Pens', 'Ink'], series: [{ name: 'Cost', points: [{ y: 5 }, { y: 7 }] }] } });
    res = await app.inject({ method: 'GET', url: `/api/sheets/${sheet.id}/chart?chart=nope`, headers: { cookie } });
    expect(res.statusCode).toBe(404);
    // A chart that is not one is refused when the workbook is saved.
    res = await app.inject({ method: 'PUT', url: `/api/sheets/${sheet.id}`, headers: { cookie }, payload: { workbook: { ...workbook, tabs: [{ ...workbook.tabs[0], charts: [{ ...chart, type: 'radar' }] }] } } });
    expect(res.statusCode).toBe(400);
  });
});
