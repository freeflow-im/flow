import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { toCellInput } from '../shared/connectors.ts';
import { registerConnectorService, runServerTool, validateToolInput } from './agent/tools.ts';
import { buildApp } from './app.ts';
import { mailbox, signUp } from './testing.ts';

const box = mailbox();
import { brex } from './connectors/brex.ts';
import { ConnectorService } from './connectors/service.ts';
import { decrypt, encrypt, loadKey } from './connectors/secrets.ts';
import { fromMinorUnits, type Connector, type FetchContext } from './connectors/types.ts';
import { openDb } from './db.ts';
import type { SheetStore } from './sheets.ts';

const TOKEN = 'bxt_SECRET_TOKEN_abcd1234';

// --- A fake Brex API ------------------------------------------------------------------

const calls: string[] = [];
let failNext: number[] = [];

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

const cardTx = Array.from({ length: 250 }, (_, k) => ({
  id: `tx${k}`,
  card_id: 'card1',
  description: `Purchase ${k}`,
  amount: { amount: 1234 + k, currency: 'USD' },
  initiated_at_date: '2025-01-02',
  posted_at_date: k < 200 ? '2025-01-03' : '2025-02-10',
  type: 'PURCHASE',
  merchant: { raw_descriptor: k === 0 ? 'TRUE COFFEE' : 'ACME' },
  expense_id: `exp${k}`,
}));

const fakeBrex: typeof fetch = async (input, init) => {
  const url = new URL(String(input));
  calls.push(url.pathname + url.search);
  const auth = new Headers(init?.headers).get('authorization');
  if (auth !== `Bearer ${TOKEN}`) return json({ message: 'Unauthorized' }, 401);
  const status = failNext.shift();
  if (status) return json({}, status, status === 429 ? { 'Retry-After': '1' } : {});
  const page = (items: unknown[]) => {
    const start = Number(url.searchParams.get('cursor') ?? 0);
    const limit = Number(url.searchParams.get('limit') ?? 100);
    const next = start + limit < items.length ? String(start + limit) : null;
    return json({ items: items.slice(start, start + limit), next_cursor: next });
  };
  switch (url.pathname) {
    case '/v2/users/me':
      return json({ id: 'u1' });
    case '/v2/cards':
      return page([{ id: 'c1', last_four: '1234', card_name: 'Ops', status: 'ACTIVE', owner: { user_id: 'u1' }, card_type: 'VIRTUAL', limit_type: 'CARD' }]);
    case '/v2/budgets':
      return page([]);
    case '/v2/transactions/card/primary':
      return page(cardTx);
    case '/v2/accounts/cash':
      return page([
        { id: 'acc1', name: 'Main', status: 'ACTIVE', primary: true, current_balance: { amount: 1000050, currency: 'USD' }, available_balance: { amount: 900000, currency: 'USD' } },
        { id: 'acc2', name: 'Reserve', status: 'ACTIVE', primary: false, current_balance: { amount: 5, currency: 'USD' }, available_balance: { amount: 5, currency: 'USD' } },
      ]);
    case '/v2/transactions/cash/acc1':
    case '/v2/transactions/cash/acc2':
      return page([{ id: `${url.pathname.slice(-4)}-t`, description: 'Deposit', amount: { amount: 50000, currency: 'USD' }, posted_at_date: '2025-01-05', type: 'DEPOSIT' }]);
    case '/v2/expenses/card':
      return page([
        { id: 'e1', purchased_at: '2025-01-03T10:00:00Z', merchant: { raw_descriptor: 'ACME' }, original_amount: { amount: 1999, currency: 'JPY' }, category: 'SOFTWARE', memo: 'x', status: 'APPROVED', budget: { name: 'Eng' }, user: { first_name: 'Ada', last_name: 'L' } },
      ]);
    default:
      return json({}, 404);
  }
};

const noSleep = async () => {};

// --- Unit tests -----------------------------------------------------------------------

describe('connector helpers', () => {
  it('converts minor units to decimals using the currency', () => {
    expect(fromMinorUnits(1234, 'USD')).toBe(12.34);
    expect(fromMinorUnits(-50, 'USD')).toBe(-0.5);
    expect(fromMinorUnits(1999, 'JPY')).toBe(1999);
    expect(fromMinorUnits(12345, 'KWD')).toBe(12.345);
    expect(fromMinorUnits(100, undefined)).toBe(1);
    expect(fromMinorUnits('12', 'USD')).toBeNull();
  });

  it('turns fetched values into cell input that parses as the right type', () => {
    expect(toCellInput(12.34, 'number')).toBe('12.34');
    expect(toCellInput('2025-01-03', 'date')).toBe('2025-01-03');
    expect(toCellInput('2025-01-03T10:00:00Z', 'date')).toBe('2025-01-03');
    expect(toCellInput('2025-01-03T10:00:00Z', 'datetime')).toBe('2025-01-03 10:00:00');
    expect(toCellInput('0012', 'string')).toBe("'0012");
    expect(toCellInput('TRUE', 'string')).toBe("'TRUE");
    expect(toCellInput('=1+1', 'string')).toBe("'=1+1");
    expect(toCellInput('ACME', 'string')).toBe('ACME');
    expect(toCellInput(null, 'string')).toBeNull();
    expect(toCellInput(true, 'boolean')).toBe('TRUE');
  });

  it('encrypts credentials with an authenticated cipher', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sheets-key-'));
    try {
      const key = loadKey(path.join(dir, 'k'), '');
      expect(loadKey(path.join(dir, 'k'), '')).toEqual(key); // reused from the file
      const blob = encrypt(key, { api_token: TOKEN });
      expect(blob).not.toContain(TOKEN);
      expect(decrypt(key, blob)).toEqual({ api_token: TOKEN });
      const parts = blob.split('.');
      parts[3] = Buffer.from('tampered').toString('base64');
      expect(() => decrypt(key, parts.join('.'))).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Brex datasets', () => {
  const ctx = (maxRows = 5000, token = TOKEN): FetchContext => ({ credentials: { api_token: token }, maxRows, fetch: fakeBrex, sleep: noSleep, now: () => new Date('2025-03-01T12:00:00Z') });
  const ds = (id: string) => brex.datasets.find((d) => d.id === id)!;

  beforeEach(() => {
    calls.length = 0;
    failNext = [];
  });

  it('follows next_cursor across pages and converts amounts', async () => {
    const res = await ds('card_transactions').fetch(ctx(), { posted_at_start: '2025-01-01' });
    expect(res.rows).toHaveLength(250);
    expect(res.truncated).toBe(false);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toContain('posted_at_start=2025-01-01T00%3A00%3A00Z');
    expect(calls[1]).toContain('cursor=100');
    expect(res.rows[0]).toEqual(['tx0', '2025-01-02', '2025-01-03', 'Purchase 0', 'TRUE COFFEE', 12.34, 'USD', 'card1', 'exp0', 'PURCHASE']);
  });

  it('caps rows and reports truncation', async () => {
    const res = await ds('card_transactions').fetch(ctx(150), {});
    expect(res.rows).toHaveLength(150);
    expect(res.truncated).toBe(true);
    expect(calls).toHaveLength(2);
  });

  it('computes last_days from today and filters by end_date', async () => {
    const res = await ds('card_transactions').fetch(ctx(), { last_days: 30, end_date: '2025-01-31' });
    expect(calls[0]).toContain('posted_at_start=2025-01-30T00%3A00%3A00Z');
    expect(res.rows).toHaveLength(200);
  });

  it('retries 429 and 5xx responses with backoff', async () => {
    failNext = [429, 503];
    const res = await ds('cash_accounts').fetch(ctx(), {});
    expect(calls).toHaveLength(3);
    expect(res.rows[0]).toEqual(['acc1', 'Main', 'ACTIVE', true, 10000.5, 9000, 'USD']);
  });

  it('iterates over every cash account when none is given', async () => {
    const res = await ds('cash_transactions').fetch(ctx(), {});
    expect(res.rows.map((r) => r[1])).toEqual(['acc1', 'acc2']);
    expect(res.rows[0][5]).toBe(500);
  });

  it('expands expenses and converts zero-decimal currencies', async () => {
    const res = await ds('expenses').fetch(ctx(), {});
    expect(calls[0]).toContain('expand%5B%5D=merchant&expand%5B%5D=budget&expand%5B%5D=user');
    expect(res.rows[0]).toEqual(['e1', '2025-01-03T10:00:00Z', 'ACME', 1999, 'JPY', 'SOFTWARE', 'x', 'APPROVED', 'Eng', 'Ada L']);
  });

  it('maps Brex errors to clear messages without the token', async () => {
    await expect(brex.test(ctx(10, 'bad-token'))).rejects.toThrow(/rejected the user token \(401\)/);
    // One forbidden endpoint does not fail the test; a token with no usable scope does, naming them.
    failNext = [403];
    await expect(brex.test(ctx())).resolves.toBeUndefined();
    failNext = [403, 403, 403, 403, 403, 403];
    await expect(brex.test(ctx())).rejects.toThrow(/none of the read-only scopes .*Cards, Transactions card, Accounts cash, Expenses card, Budgets, Users/);
    // A dataset whose scope is missing says which one.
    failNext = [403];
    await expect(ds('users').fetch(ctx(), {})).rejects.toThrow(/\/v2\/users \(403\): the user token does not have the "Users" read-only scope/);
    failNext = [429, 429, 429, 429, 429];
    await expect(brex.test(ctx())).rejects.toThrow(/rate limiting/);
    failNext = [500, 500, 500, 500, 500];
    await expect(brex.test(ctx())).rejects.toMatchObject({ code: 'unavailable' });
  });
});

// --- Connections through the API and the agent tools -----------------------------------------

describe('connections', () => {
  let dir: string;
  let app: Awaited<ReturnType<typeof buildApp>>;
  let cookie: string;
  let sheets: SheetStore;
  let userId: string;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'sheets-connectors-'));
    app = await buildApp({ dataDir: dir, sendMail: box.send, connectors: { fetch: fakeBrex, sleep: noSleep } });
    const signedUp = await signUp(app, box, 'conn@x.com');
    cookie = signedUp.cookie;
    userId = signedUp.user.id;
    // The app's service, registered for the agent tools under a stand-in SheetStore.
    sheets = {} as SheetStore;
    registerConnectorService(sheets, app.connectors);
  });

  afterAll(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const inject = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) => app.inject({ method, url, payload: payload as object, headers: { cookie } });

  it('lists the Brex connector with its datasets and parameter schemas', async () => {
    const res = await inject('GET', '/api/connectors');
    const brexInfo = res.json().connectors.find((c: { id: string }) => c.id === 'brex');
    expect(brexInfo.fields[0]).toMatchObject({ key: 'api_token', secret: true });
    expect(brexInfo.datasets.map((d: { id: string }) => d.id)).toEqual(['card_transactions', 'cash_transactions', 'cash_accounts', 'cards', 'users', 'expenses', 'budgets']);
    expect(brexInfo.datasets[0].params.properties).toHaveProperty('posted_at_start');
    expect(brexInfo.datasets[0].params.properties).toHaveProperty('limit');
  });

  it('tests before saving, stores the token encrypted and never returns it', async () => {
    let res = await inject('POST', '/api/connections/test', { connector: 'brex', fields: { api_token: 'wrong' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/401/);
    res = await inject('POST', '/api/connections', { connector: 'brex', name: 'Brex - Production', fields: { api_token: 'wrong' } });
    expect(res.statusCode).toBe(400);

    res = await inject('POST', '/api/connections/test', { connector: 'brex', fields: { api_token: TOKEN } });
    expect(res.json()).toEqual({ ok: true });
    res = await inject('POST', '/api/connections', { connector: 'brex', name: 'Brex - Production', fields: { api_token: TOKEN } });
    expect(res.statusCode).toBe(200);
    expect(res.json().connection).toMatchObject({ name: 'Brex - Production', status: 'connected', masked: '••••1234' });
    expect(res.body).not.toContain(TOKEN);

    const list = await inject('GET', '/api/connections');
    expect(list.body).not.toContain(TOKEN);
    expect(list.body).not.toContain('SECRET');

    const db = openDb(path.join(dir, 'app.db'));
    const rows = db.prepare('SELECT * FROM connections').all();
    db.close();
    expect(JSON.stringify(rows)).not.toContain('SECRET');
    expect(readFileSync(path.join(dir, 'app.db')).includes('SECRET_TOKEN')).toBe(false);
  });

  it('renames a connection, keeping the token when the field is left blank', async () => {
    const [conn] = (await inject('GET', '/api/connections')).json().connections;
    let res = await inject('POST', '/api/connections/test', { id: conn.id, fields: { api_token: '' } });
    expect(res.json()).toEqual({ ok: true });
    res = await inject('PATCH', `/api/connections/${conn.id}`, { name: 'Brex - Prod', fields: { api_token: '' } });
    expect(res.json().connection).toMatchObject({ name: 'Brex - Prod', masked: '••••1234', status: 'connected' });
    res = await inject('PATCH', `/api/connections/${conn.id}`, { fields: { api_token: 'bad' } });
    expect(res.statusCode).toBe(400);
  });

  it('runs the agent tools without exposing credentials', async () => {
    const [conn] = (await inject('GET', '/api/connections')).json().connections;
    const env = { userId, sheets, context: { page: 'home' as const } };
    const listed = await runServerTool('list_connections', {}, env);
    expect(listed).not.toContain('SECRET');
    expect(JSON.parse(listed).connections).toEqual([{ id: conn.id, connector: 'brex', name: 'Brex - Prod', status: 'connected', last_used_at: expect.any(String) }]);

    expect(validateToolInput('fetch_connector_data', { connection_id: conn.id, dataset: 'card_transactions', params: { posted_at_start: '2025-01-01' }, preview_rows: 5 }).ok).toBe(true);
    const fetched = JSON.parse(await runServerTool('fetch_connector_data', { connection_id: conn.id, dataset: 'card_transactions', params: { limit: 120 }, preview_rows: 2 }, env));
    expect(fetched).toMatchObject({ total_rows: 120, truncated: true, columns: expect.arrayContaining(['amount']) });
    expect(fetched.preview).toHaveLength(2);

    // The browser's ingest tool fetches through the API, here reusing the previewed result.
    const res = await inject('POST', `/api/connections/${conn.id}/fetch`, { dataset: 'card_transactions', handle: fetched.result_handle });
    expect(res.json()).toMatchObject({ totalRows: 120, truncated: true });

    await expect(runServerTool('fetch_connector_data', { connection_id: conn.id, dataset: 'nope' }, env)).rejects.toThrow(/no dataset "nope"/);
    await expect(runServerTool('fetch_connector_data', { connection_id: conn.id, dataset: 'cards', params: { bogus: 1 } }, env)).rejects.toThrow(/Invalid params/);
    await expect(runServerTool('fetch_connector_data', { connection_id: 'missing', dataset: 'cards' }, env)).rejects.toThrow(/Connectors page/);
  });

  it('keeps other users out of a connection', async () => {
    const [conn] = (await inject('GET', '/api/connections')).json().connections;
    const otherCookie = (await signUp(app, box, 'other@x.com')).cookie;
    const res = await app.inject({ method: 'POST', url: `/api/connections/${conn.id}/fetch`, payload: { dataset: 'cards' }, headers: { cookie: otherCookie } });
    expect(res.statusCode).toBe(404);
  });

  it('deletes a connection', async () => {
    const [conn] = (await inject('GET', '/api/connections')).json().connections;
    expect((await inject('DELETE', `/api/connections/${conn.id}`)).statusCode).toBe(200);
    expect((await inject('GET', '/api/connections')).json().connections).toEqual([]);
  });
});

// --- Generic OAuth plumbing, with a fake provider --------------------------------------------

describe('OAuth connectors', () => {
  let dir: string;
  let now = new Date('2025-03-01T00:00:00Z');
  const tokenCalls: URLSearchParams[] = [];
  let issued = 0;

  const provider: Connector = {
    id: 'demo',
    name: 'Demo',
    icon: 'D',
    description: 'Fake OAuth provider',
    authTypes: ['oauth2'],
    fields: [],
    oauth: { authorizeUrl: 'https://auth.demo.test/authorize', tokenUrl: 'https://auth.demo.test/token', scopes: ['read'], clientIdEnv: 'DEMO_ID', clientSecretEnv: 'DEMO_SECRET' },
    test: async (ctx) => {
      if (!ctx.credentials.access_token.startsWith('at')) throw new Error('bad');
    },
    datasets: [
      {
        id: 'whoami',
        description: 'The token used',
        params: z.object({}),
        columns: [{ name: 'token', type: 'string' }],
        fetch: async (ctx) => ({ rows: [[ctx.credentials.access_token]], truncated: false }),
      },
    ],
  };

  const oauthFetch: typeof fetch = async (input, init) => {
    expect(String(input)).toBe('https://auth.demo.test/token');
    const body = new URLSearchParams(String(init?.body));
    tokenCalls.push(body);
    if (body.get('grant_type') === 'refresh_token' && body.get('refresh_token') === 'revoked') return json({ error: 'invalid_grant' }, 400);
    issued++;
    return json({ access_token: `at${issued}`, refresh_token: `rt${issued}`, expires_in: 3600 });
  };

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'sheets-oauth-'));
    process.env.DEMO_ID = 'client-1';
    process.env.DEMO_SECRET = 'shh';
  });

  afterAll(() => {
    delete process.env.DEMO_ID;
    delete process.env.DEMO_SECRET;
    rmSync(dir, { recursive: true, force: true });
  });

  it('runs the code flow with state and PKCE, then refreshes expired tokens', async () => {
    const db = openDb(path.join(dir, 'app.db'));
    db.prepare("INSERT INTO users (id, email, password_hash, created_at) VALUES ('u1', 'a@x.com', 'x', 'now'), ('u2', 'b@x.com', 'x', 'now')").run();
    const svc = new ConnectorService(db, { keyFile: path.join(dir, 'key'), connectors: [provider], fetch: oauthFetch, now: () => now });
    expect(svc.connectorInfo()[0].oauthAvailable).toBe(true);

    const url = new URL(svc.oauthStart('u1', 'demo', 'My Demo', 'https://app.test/api/connectors/oauth/callback'));
    expect(url.origin + url.pathname).toBe('https://auth.demo.test/authorize');
    expect(url.searchParams.get('client_id')).toBe('client-1');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const state = url.searchParams.get('state')!;

    // Another user can't complete someone else's flow, and a state works once.
    await expect(svc.oauthCallback('u2', state, 'code')).rejects.toThrow(/invalid or has expired/);
    const url2 = new URL(svc.oauthStart('u1', 'demo', 'My Demo', 'https://app.test/api/connectors/oauth/callback'));
    const conn = await svc.oauthCallback('u1', url2.searchParams.get('state')!, 'the-code');
    expect(tokenCalls[0].get('code')).toBe('the-code');
    expect(tokenCalls[0].get('code_verifier')).toBeTruthy();
    expect(conn).toMatchObject({ name: 'My Demo', authType: 'oauth2', status: 'connected' });
    expect(JSON.stringify(svc.list('u1'))).not.toContain('at1');

    expect((await svc.fetch('u1', conn.id, 'whoami', {})).rows).toEqual([['at1']]);
    now = new Date(now.getTime() + 2 * 3600_000); // expired
    expect((await svc.fetch('u1', conn.id, 'whoami', {})).rows).toEqual([['at2']]);
    expect(tokenCalls[1].get('grant_type')).toBe('refresh_token');
    expect(tokenCalls[1].get('refresh_token')).toBe('rt1');

    // A revoked refresh token marks the connection as needing to reconnect.
    db.prepare('UPDATE connections SET credentials = ? WHERE id = ?').run(
      encrypt(loadKey(path.join(dir, 'key'), ''), { access_token: 'old', refresh_token: 'revoked', expires_at: '2000-01-01T00:00:00Z' }),
      conn.id,
    );
    await expect(svc.fetch('u1', conn.id, 'whoami', {})).rejects.toThrow(/Reconnect/);
    expect(svc.get('u1', conn.id)).toMatchObject({ status: 'needs_reauth' });
    db.close();
  });
});
