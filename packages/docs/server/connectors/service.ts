// Connections: per-user configured connectors with encrypted credentials. Runs dataset queries (refreshing
// OAuth tokens as needed), tracks connection status, and implements the generic OAuth 2.0 code flow.
// Credentials never leave this module except to the connector's own fetch code.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ConnectionInfo, ConnectionStatus, ConnectorAuthType, ConnectorInfo, FetchResult } from '../../shared/connectors.ts';
import type { DB } from '../db.ts';
import { brex } from './brex.ts';
import { decrypt, encrypt, loadKey, mask } from './secrets.ts';
import { ConnectorError, type Connector, type Dataset, type FetchContext } from './types.ts';

/** Every connector the app ships with. Add new connectors here. */
export const CONNECTORS: Connector[] = [brex];

export const DEFAULT_MAX_ROWS = 5000;
export const MAX_ROWS = 50_000;
const RESULT_TTL_MS = 15 * 60_000;
const MAX_CACHED_RESULTS = 20;
const OAUTH_STATE_TTL_MS = 10 * 60_000;

export interface ConnectorServiceOptions {
  /** File holding the generated encryption key when CONNECTOR_ENCRYPTION_KEY is not set. */
  keyFile: string;
  connectors?: Connector[];
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}

interface Row {
  id: string;
  user_id: string;
  connector: string;
  name: string;
  auth_type: ConnectorAuthType;
  credentials: string;
  settings: string;
  masked: string | null;
  status: ConnectionStatus;
  error: string | null;
  created_at: string;
  last_used_at: string | null;
}

export class ConnectorService {
  private db: DB;
  private key: Buffer;
  private connectors: Connector[];
  private fetchFn: typeof fetch;
  private sleep: (ms: number) => Promise<void>;
  private now: () => Date;
  private results = new Map<string, { userId: string; connectionId: string; dataset: string; result: Omit<FetchResult, 'handle'>; expires: number }>();
  private oauthStates = new Map<string, { userId: string; connector: string; name: string; verifier: string; redirectUri: string; expires: number }>();

  constructor(db: DB, opts: ConnectorServiceOptions) {
    this.db = db;
    this.key = loadKey(opts.keyFile);
    this.connectors = opts.connectors ?? CONNECTORS;
    this.fetchFn = opts.fetch ?? ((...a) => fetch(...a));
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? (() => new Date());
  }

  // --- Connectors ---------------------------------------------------------------

  connector(id: string): Connector {
    const c = this.connectors.find((x) => x.id === id);
    if (!c) throw new ConnectorError('not_found', `Unknown connector "${id}". Available: ${this.connectors.map((x) => x.id).join(', ')}.`);
    return c;
  }

  /** Public descriptions of every connector, with each dataset's parameter JSON Schema. */
  connectorInfo(): ConnectorInfo[] {
    return this.connectors.map((c) => ({
      id: c.id,
      name: c.name,
      icon: c.icon,
      description: c.description,
      authTypes: c.authTypes,
      fields: c.fields,
      setupHelp: c.setupHelp,
      oauthAvailable: !!c.oauth && !!process.env[c.oauth.clientIdEnv] && !!process.env[c.oauth.clientSecretEnv],
      datasets: c.datasets.map((d) => ({ id: d.id, description: d.description, params: paramsJsonSchema(d) })),
    }));
  }

  // --- Connections --------------------------------------------------------------

  list(userId: string): ConnectionInfo[] {
    const rows = this.db.prepare('SELECT * FROM connections WHERE user_id = ? ORDER BY created_at').all(userId) as unknown as Row[];
    return rows.map(publicConnection);
  }

  get(userId: string, id: string): ConnectionInfo | null {
    const row = this.row(userId, id);
    return row ? publicConnection(row) : null;
  }

  private row(userId: string, id: string): Row | null {
    return (this.db.prepare('SELECT * FROM connections WHERE id = ? AND user_id = ?').get(id, userId) as unknown as Row | undefined) ?? null;
  }

  /** Check api_key field values against the connector's fields; returns secrets and plain settings. */
  private splitFields(c: Connector, values: Record<string, unknown>, existing?: { credentials: Record<string, string>; settings: Record<string, string> }) {
    const credentials: Record<string, string> = { ...existing?.credentials };
    const settings: Record<string, string> = { ...existing?.settings };
    for (const f of c.fields) {
      const v = typeof values[f.key] === 'string' ? (values[f.key] as string).trim() : '';
      // An empty secret when editing keeps the stored one.
      if (!v && f.secret && existing) continue;
      if (!v) throw new ConnectorError('bad_request', `${f.label} is required.`);
      (f.secret ? credentials : settings)[f.key] = v;
    }
    return { credentials, settings };
  }

  /** Try credentials without saving them (the setup dialog's Test connection button). */
  async testCredentials(connectorId: string, values: Record<string, unknown>, existingId?: { userId: string; id: string }): Promise<void> {
    const c = this.connector(connectorId);
    let existing;
    if (existingId) {
      const row = this.row(existingId.userId, existingId.id);
      if (!row) throw new ConnectorError('not_found', 'Connection not found.');
      existing = { credentials: decrypt(this.key, row.credentials), settings: JSON.parse(row.settings) as Record<string, string> };
    }
    const { credentials, settings } = this.splitFields(c, values, existing);
    await c.test(this.context({ ...settings, ...credentials }, 1));
  }

  /** Save an api_key connection after testing it. */
  async create(userId: string, input: { connector: string; name?: string; fields: Record<string, unknown> }): Promise<ConnectionInfo> {
    const c = this.connector(input.connector);
    if (!c.authTypes.includes('api_key')) throw new ConnectorError('bad_request', `${c.name} connects with OAuth; use the Connect button.`);
    const { credentials, settings } = this.splitFields(c, input.fields);
    await c.test(this.context({ ...settings, ...credentials }, 1));
    const id = randomUUID();
    const firstSecret = c.fields.find((f) => f.secret)?.key;
    this.db
      .prepare(
        "INSERT INTO connections (id, user_id, connector, name, auth_type, credentials, settings, masked, status, created_at, last_used_at) VALUES (?, ?, ?, ?, 'api_key', ?, ?, ?, 'connected', ?, ?)",
      )
      .run(id, userId, c.id, cleanName(input.name, c), encrypt(this.key, credentials), JSON.stringify(settings), mask(firstSecret ? credentials[firstSecret] : ''), this.now().toISOString(), this.now().toISOString());
    return this.get(userId, id)!;
  }

  /** Rename a connection and/or replace its credentials (re-tested before saving). */
  async update(userId: string, id: string, input: { name?: string; fields?: Record<string, unknown> }): Promise<ConnectionInfo | null> {
    const row = this.row(userId, id);
    if (!row) return null;
    const c = this.connector(row.connector);
    if (input.fields && Object.values(input.fields).some((v) => typeof v === 'string' && v.trim()) && row.auth_type === 'api_key') {
      const existing = { credentials: decrypt(this.key, row.credentials), settings: JSON.parse(row.settings) as Record<string, string> };
      const { credentials, settings } = this.splitFields(c, input.fields, existing);
      await c.test(this.context({ ...settings, ...credentials }, 1));
      const firstSecret = c.fields.find((f) => f.secret)?.key;
      this.db
        .prepare("UPDATE connections SET credentials = ?, settings = ?, masked = ?, status = 'connected', error = NULL WHERE id = ?")
        .run(encrypt(this.key, credentials), JSON.stringify(settings), mask(firstSecret ? credentials[firstSecret] : ''), id);
    }
    if (typeof input.name === 'string' && input.name.trim()) this.db.prepare('UPDATE connections SET name = ? WHERE id = ?').run(cleanName(input.name, c), id);
    return this.get(userId, id);
  }

  delete(userId: string, id: string): boolean {
    return Number(this.db.prepare('DELETE FROM connections WHERE id = ? AND user_id = ?').run(id, userId).changes) > 0;
  }

  /** Test a saved connection and record the outcome as its status. */
  async test(userId: string, id: string): Promise<ConnectionInfo> {
    const row = this.requireRow(userId, id);
    const c = this.connector(row.connector);
    await this.track(row, async (creds) => c.test(this.context(creds, 1)));
    return this.get(userId, id)!;
  }

  private requireRow(userId: string, id: string): Row {
    const row = this.row(userId, id);
    if (!row) throw new ConnectorError('not_found', `No connection with id "${id}". Use list_connections to see the user's connections, or ask the user to add one on the Connectors page.`);
    return row;
  }

  /** Run a request with a connection's credentials, recording success or failure on the connection. */
  private async track<T>(row: Row, fn: (credentials: Record<string, string>) => Promise<T>): Promise<T> {
    try {
      const creds = await this.credentialsFor(row);
      const out = await fn(creds);
      this.db.prepare("UPDATE connections SET status = 'connected', error = NULL, last_used_at = ? WHERE id = ?").run(this.now().toISOString(), row.id);
      return out;
    } catch (e) {
      if (e instanceof ConnectorError && (e.code === 'auth' || e.code === 'forbidden')) {
        const status = e.code === 'auth' && row.auth_type === 'oauth2' ? 'needs_reauth' : 'error';
        this.db.prepare('UPDATE connections SET status = ?, error = ? WHERE id = ?').run(status, e.message, row.id);
      }
      throw e;
    }
  }

  // --- Data -----------------------------------------------------------------------

  /** Run a dataset query. The full result is cached under a handle for a while (see cachedResult). */
  async fetch(userId: string, id: string, datasetId: string, rawParams: unknown): Promise<FetchResult> {
    const row = this.requireRow(userId, id);
    const c = this.connector(row.connector);
    const ds = c.datasets.find((d) => d.id === datasetId);
    if (!ds) throw new ConnectorError('bad_request', `${c.name} has no dataset "${datasetId}". Available: ${c.datasets.map((d) => d.id).join(', ')}.`);
    const parsed = paramsSchema(ds).safeParse(rawParams ?? {});
    if (!parsed.success) throw new ConnectorError('bad_request', `Invalid params for ${datasetId}: ${z.prettifyError(parsed.error)}`);
    const { limit, ...params } = parsed.data as { limit?: number } & Record<string, unknown>;
    const maxRows = limit ?? DEFAULT_MAX_ROWS;
    const res = await this.track(row, (creds) => ds.fetch(this.context(creds, maxRows), params));
    const result = { columns: ds.columns, rows: res.rows, truncated: res.truncated, totalRows: res.rows.length };
    const handle = randomUUID();
    this.pruneResults();
    this.results.set(handle, { userId, connectionId: id, dataset: datasetId, result, expires: Date.now() + RESULT_TTL_MS });
    return { handle, ...result };
  }

  /** A result fetched earlier by this user, or null once it has expired. */
  cachedResult(userId: string, handle: string): FetchResult | null {
    const e = this.results.get(handle);
    if (!e || e.userId !== userId || e.expires < Date.now()) return null;
    return { handle, ...e.result };
  }

  private pruneResults() {
    const now = Date.now();
    for (const [k, v] of this.results) if (v.expires < now) this.results.delete(k);
    while (this.results.size >= MAX_CACHED_RESULTS) this.results.delete(this.results.keys().next().value!);
  }

  private context(credentials: Record<string, string>, maxRows: number): FetchContext {
    return { credentials, maxRows, fetch: this.fetchFn, sleep: this.sleep, now: this.now };
  }

  // --- OAuth 2.0 (authorization code + PKCE) ------------------------------------------

  /** Start the flow: returns the provider's consent URL. The callback must arrive within 10 minutes. */
  oauthStart(userId: string, connectorId: string, name: string | undefined, redirectUri: string): string {
    const c = this.connector(connectorId);
    const cfg = c.oauth;
    const clientId = cfg && process.env[cfg.clientIdEnv];
    if (!cfg || !clientId || !process.env[cfg.clientSecretEnv]) throw new ConnectorError('bad_request', `OAuth is not set up for ${c.name} on this server.`);
    const now = Date.now();
    for (const [k, v] of this.oauthStates) if (v.expires < now) this.oauthStates.delete(k);
    const state = randomBytes(24).toString('base64url');
    const verifier = randomBytes(32).toString('base64url');
    this.oauthStates.set(state, { userId, connector: c.id, name: cleanName(name, c), verifier, redirectUri, expires: now + OAUTH_STATE_TTL_MS });
    const url = new URL(cfg.authorizeUrl);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: cfg.scopes.join(' '),
      state,
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      ...cfg.extraAuthorizeParams,
    }).toString();
    return url.href;
  }

  /** Finish the flow: check the state (CSRF), exchange the code for tokens and save the connection. */
  async oauthCallback(userId: string, state: string, code: string): Promise<ConnectionInfo> {
    const st = this.oauthStates.get(state);
    this.oauthStates.delete(state);
    if (!st || st.userId !== userId || st.expires < Date.now()) throw new ConnectorError('bad_request', 'This sign-in link is invalid or has expired. Start again from the Connectors page.');
    const c = this.connector(st.connector);
    const tokens = await this.tokenRequest(c, { grant_type: 'authorization_code', code, redirect_uri: st.redirectUri, code_verifier: st.verifier });
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO connections (id, user_id, connector, name, auth_type, credentials, settings, masked, status, created_at) VALUES (?, ?, ?, ?, 'oauth2', ?, '{}', 'OAuth', 'connected', ?)",
      )
      .run(id, userId, c.id, st.name, encrypt(this.key, tokens), this.now().toISOString());
    return this.get(userId, id)!;
  }

  /** Credentials for a request, refreshing an OAuth access token that has expired (or is about to). */
  private async credentialsFor(row: Row): Promise<Record<string, string>> {
    const creds = { ...JSON.parse(row.settings), ...decrypt(this.key, row.credentials) } as Record<string, string>;
    if (row.auth_type !== 'oauth2' || !creds.expires_at || Date.parse(creds.expires_at) - 60_000 > this.now().getTime()) return creds;
    const c = this.connector(row.connector);
    if (!creds.refresh_token) throw new ConnectorError('auth', `The ${c.name} sign-in has expired. Reconnect it on the Connectors page.`);
    let fresh;
    try {
      fresh = await this.tokenRequest(c, { grant_type: 'refresh_token', refresh_token: creds.refresh_token });
    } catch (e) {
      if (e instanceof ConnectorError && (e.code === 'auth' || e.code === 'bad_request')) {
        throw new ConnectorError('auth', `The ${c.name} sign-in has expired or was revoked. Reconnect it on the Connectors page.`);
      }
      throw e;
    }
    const next = { ...fresh, refresh_token: fresh.refresh_token || creds.refresh_token };
    this.db.prepare('UPDATE connections SET credentials = ? WHERE id = ?').run(encrypt(this.key, next), row.id);
    return next;
  }

  private async tokenRequest(c: Connector, params: Record<string, string>): Promise<Record<string, string>> {
    const cfg = c.oauth!;
    const body = new URLSearchParams({ ...params, client_id: process.env[cfg.clientIdEnv] ?? '', client_secret: process.env[cfg.clientSecretEnv] ?? '' });
    let res: Response;
    try {
      res = await this.fetchFn(cfg.tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body });
    } catch {
      throw new ConnectorError('unavailable', `${c.name} could not be reached to sign in. Try again.`);
    }
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || typeof data.access_token !== 'string') {
      throw new ConnectorError(res.status >= 500 ? 'unavailable' : 'auth', `${c.name} did not accept the sign-in (HTTP ${res.status}). Try connecting again.`);
    }
    const out: Record<string, string> = { access_token: data.access_token };
    if (typeof data.refresh_token === 'string') out.refresh_token = data.refresh_token;
    if (typeof data.expires_in === 'number') out.expires_at = new Date(this.now().getTime() + data.expires_in * 1000).toISOString();
    return out;
  }
}

function cleanName(name: string | undefined, c: Connector): string {
  return (typeof name === 'string' ? name.trim().slice(0, 100) : '') || c.name;
}

function publicConnection(r: Row): ConnectionInfo {
  return {
    id: r.id,
    connector: r.connector,
    name: r.name,
    authType: r.auth_type,
    status: r.status,
    ...(r.error && r.status !== 'connected' ? { error: r.error } : {}),
    ...(r.masked ? { masked: r.masked } : {}),
    settings: JSON.parse(r.settings) as Record<string, string>,
    createdAt: r.created_at,
    ...(r.last_used_at ? { lastUsedAt: r.last_used_at } : {}),
  };
}

const limitParam = z.number().int().min(1).max(MAX_ROWS).optional().describe(`Maximum rows to fetch. Defaults to ${DEFAULT_MAX_ROWS}.`);

function paramsSchema(ds: Dataset) {
  return z.strictObject({ ...ds.params.shape, limit: limitParam });
}

function paramsJsonSchema(ds: Dataset): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = z.toJSONSchema(paramsSchema(ds)) as Record<string, unknown>;
  return rest;
}
