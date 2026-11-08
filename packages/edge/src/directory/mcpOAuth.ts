// OAuth for Docs' MCP endpoint on the suite's own host (app.freeflow.im/mcp): the authorization server of the ChatGPT
// plugin (docs/plugin/server/oauth.ts) moved into the directory, because authorization happens before an organization is
// known. The same endpoints and rules: discovery, dynamic client registration or a client metadata document, the code flow
// with PKCE, refresh rotation with reuse detection, revocation, and the device grant. What differs: the person is signed in
// by FreeFlow's own session (no sign-in pages here), and consent includes choosing one of their organizations, which every
// code, token and connection then carries. A token stops working when its person leaves that organization.
//
// Only hashes of codes and tokens are stored. Times are milliseconds since the epoch, as in the rest of the directory.
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { accountGate, type Sql } from './core';
import type { AccountState, AppScopeGroup } from '@flow/shared';
import { APP_MANIFESTS } from '@flow/shared/manifests';

/**
 * The consent page's checkboxes, from the apps' manifests (@flow/shared's APP_MANIFESTS, `scopes`): each one a group of
 * scopes, on or off until the person changes it. Docs' files (read, and change), the person's own mail (read, organise and
 * draft; sending is off unless they tick it: an agent drafts, and the person sends), their calendars (read, and change),
 * and the organization's events through subscriptions the agent makes (platform.md §5.2).
 */
export const SCOPE_GROUPS: readonly AppScopeGroup[] = APP_MANIFESTS.flatMap((m) => m.scopes ?? []);

/** Every scope a token can carry, in the groups' order. */
export const MCP_SCOPES: readonly string[] = SCOPE_GROUPS.flatMap((g) => g.scopes);

export type ScopeGroupId = string;
export interface OfferedGroup { id: ScopeGroupId; scopes: string[]; checked: boolean }

/** The groups the page offers for a request's scopes: those it asked for any of, each with only the scopes it asked for. */
export function offeredGroups(scope: string): OfferedGroup[] {
  const asked = new Set(scope.split(' ').filter(Boolean));
  return SCOPE_GROUPS.map((g) => ({ id: g.id, scopes: g.scopes.filter((s) => asked.has(s)), checked: g.checkedByDefault })).filter((g) => g.scopes.length > 0);
}

/**
 * The scopes the person granted: those of the groups they ticked, among the ones offered. `ticked` undefined (a decision
 * posted without the checkboxes) means each group as the page starts it. Null when nothing is granted.
 */
export function grantedScope(scope: string, ticked: readonly string[] | undefined): string | null {
  const groups = offeredGroups(scope).filter((g) => (ticked ? ticked.includes(g.id) : g.checked));
  const granted = MCP_SCOPES.filter((s) => groups.some((g) => g.scopes.includes(s)));
  return granted.length ? granted.join(' ') : null;
}
export const ACCESS_TTL = 60 * 60_000;
export const REFRESH_TTL = 30 * 86_400_000;
/** A device sign-in's access tokens last a week: an agent driving the endpoint by hand often never refreshes. */
export const DEVICE_ACCESS_TTL = 7 * 86_400_000;
const CODE_TTL = 5 * 60_000;
const PENDING_TTL = 15 * 60_000;
const CLIENT_DOC_TTL = 60 * 60_000;
export const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const GRANTS = ['authorization_code', 'refresh_token', DEVICE_GRANT];
const DEVICE_TTL = 10 * 60_000;
const DEVICE_INTERVAL_S = 5;
/** Wrong codes one address may enter on /oauth/device in DEVICE_TTL. */
const DEVICE_TRIES = 10;
/** No vowels (so no words) and none easily read as another; 20^8 codes. */
const USER_CODE_LETTERS = 'BCDFGHJKLMNPQRSTVWXZ';
/** The MCP paths a token can be for: /mcp and its versions. */
export const MCP_ENDPOINT = /^\/mcp(?:\/v\d+)?$/;

/** An OAuth error with the code the spec names; the routes turn it into a status and a JSON body, or a page. */
export class OAuthError extends Error {
  constructor(public readonly code: string, description: string, public readonly status = 400) {
    super(description);
    this.name = 'OAuthError';
  }
}

/** What crosses from the directory object to the Worker: an error's class does not survive the trip. */
export type OAuthAnswer<T> = { ok: true; value: T } | { ok: false; code: string; description: string; status: number };

export interface AuthorizeParams {
  response_type?: string;
  client_id?: string;
  redirect_uri?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  scope?: string;
  state?: string;
  resource?: string;
}

interface PendingParams extends AuthorizeParams {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  scope: string;
  /** A device sign-in: the device code's hash, and where the request came from. */
  device?: string;
  origin?: string;
}

export type AuthorizeOutcome = { kind: 'consent'; pendingId: string } | { kind: 'redirect'; url: string };

/** What the consent page shows. The organizations are named by the route, which asks each organization's object. */
export interface ConsentInfo {
  clientName: string;
  scopes: string[];
  csrf: string;
  /** A device sign-in may have been started by someone else: where it came from. */
  device: { origin: string } | null;
  organizations: string[];
  /** The organization to preselect: the one this person last connected an agent to, else their first. */
  preselect: string | null;
}

/** `accountId`: the grant's account, the person's in `orgId` (platform.md §3.6); null for one made before accounts. */
export interface McpCaller { userId: string; email: string; orgId: string; accountId: string | null; scope: string }
/** A failure is a 401 unless it carries a status (403 for an inactive account). */
export type McpAuth = { ok: true; caller: McpCaller } | { ok: false; reason: string; description: string; status?: number };

export interface McpConnection {
  id: string;
  name: string;
  origin: string;
  endpoint: string;
  organizationId: string;
  connectedAt: string;
  lastActiveAt?: string;
}

interface ClientDoc { client_id: string; redirect_uris: string[]; client_name?: string }

type Row = Record<string, unknown>;

export const sha = (s: string): string => createHash('sha256').update(s).digest('base64url');
const newToken = (): string => randomBytes(32).toString('base64url');
const iso = (ms: number): string => new Date(ms).toISOString();

export function isAllowedRedirect(u: string): boolean {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' || (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1'));
  } catch {
    return false;
  }
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** A registered redirect URI matches exactly, or for a native app on this computer on any port (RFC 8252 §7.3). */
export function redirectMatches(registered: string, requested: string): boolean {
  if (registered === requested) return true;
  try {
    const a = new URL(registered);
    const b = new URL(requested);
    return a.protocol === 'http:' && b.protocol === 'http:' && LOOPBACK.has(a.hostname) && a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search && !b.username && !b.password && !b.hash;
  } catch {
    return false;
  }
}

/** The scopes asked for, cleaned; every scope when none; null when one is unknown. */
export function cleanScope(requested: string | undefined): string | null {
  if (!requested?.trim()) return MCP_SCOPES.join(' ');
  const parts = [...new Set(requested.trim().split(/\s+/))];
  return parts.every((s) => MCP_SCOPES.includes(s)) ? parts.join(' ') : null;
}

/** The resource for an MCP path on an issuer: /mcp, or a version of it (/mcp/v2). */
export const resourceAt = (issuer: string, endpoint: string): string => `${issuer}${endpoint}`;
/** Whether tokens are issued for this resource on this issuer. */
export const isResource = (issuer: string, resource: string): boolean => resource.startsWith(issuer) && MCP_ENDPOINT.test(resource.slice(issuer.length));

/** RFC 9728: where the resource server's tokens come from. */
export function protectedResourceMetadata(issuer: string, endpoint = '/mcp') {
  return { resource: resourceAt(issuer, endpoint), authorization_servers: [issuer], scopes_supported: [...MCP_SCOPES], bearer_methods_supported: ['header'], resource_name: 'FreeFlow Docs and Mail' };
}

/** RFC 8414: the authorization server's endpoints and features. */
export function authorizationServerMetadata(issuer: string) {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    revocation_endpoint: `${issuer}/oauth/revoke`,
    device_authorization_endpoint: `${issuer}/oauth/device_authorization`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: GRANTS,
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
    revocation_endpoint_auth_methods_supported: ['none'],
    scopes_supported: [...MCP_SCOPES],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
  };
}

/** The challenge on a 401 from the MCP endpoint, which starts (or restarts) a client's OAuth flow. */
export function wwwAuthenticate(issuer: string, endpoint: string, error?: string, description?: string): string {
  const parts = [`Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource${endpoint}"`];
  if (error) parts.push(`error="${error}"`);
  if (error && description) parts.push(`error_description="${description.replace(/["\\]/g, "'")}"`);
  return parts.join(', ');
}

export class McpOAuth {
  private readonly clientDocs = new Map<string, { doc: ClientDoc; expires: number }>();

  constructor(private readonly sql: Sql, private readonly fetchFn: typeof fetch = (...a) => fetch(...a)) {}

  private rows(query: string, ...args: unknown[]): Row[] {
    return this.sql.exec(query, ...args).toArray();
  }
  private one(query: string, ...args: unknown[]): Row | undefined {
    return this.rows(query, ...args)[0];
  }
  /** An account there that was not removed (platform.md §3.3); a suspended one is refused by the account gate instead. */
  private isMember(userId: string, orgId: string): boolean {
    return !!this.one("SELECT 1 AS x FROM accounts WHERE user_id = ? AND organization_id = ? AND state <> 'removed'", userId, orgId);
  }
  private activeUser(userId: string): boolean {
    return !!this.one('SELECT 1 AS x FROM users WHERE id = ? AND deleted_at IS NULL', userId);
  }
  private emailOf(userId: string): string | null {
    return (this.one('SELECT email FROM users WHERE id = ? AND deleted_at IS NULL', userId)?.email as string | undefined) ?? null;
  }

  // --- Clients ------------------------------------------------------------------------

  /** Dynamic client registration (RFC 7591), for clients without a metadata document. */
  register(body: unknown) {
    const b = (body ?? {}) as { redirect_uris?: unknown; client_name?: unknown; token_endpoint_auth_method?: unknown; grant_types?: unknown };
    const asked = Array.isArray(b.grant_types) ? b.grant_types.filter((g): g is string => typeof g === 'string' && GRANTS.includes(g)) : [];
    const grants = asked.length ? asked : ['authorization_code', 'refresh_token'];
    const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris.filter((u): u is string => typeof u === 'string') : [];
    if ((grants.includes('authorization_code') && !uris.length) || !uris.every(isAllowedRedirect)) throw new OAuthError('invalid_redirect_uri', 'redirect_uris must be https URLs (or http://localhost for development).');
    if (b.token_endpoint_auth_method !== undefined && b.token_endpoint_auth_method !== 'none') throw new OAuthError('invalid_client_metadata', 'Only token_endpoint_auth_method "none" (public client with PKCE) is supported.');
    const id = `dcr_${randomUUID()}`;
    const name = typeof b.client_name === 'string' && b.client_name.trim() ? b.client_name.trim().slice(0, 100) : uris.length ? new URL(uris[0]!).host : 'An agent';
    this.sql.exec('INSERT INTO oauth_clients (id, name, redirect_uris, created_at) VALUES (?, ?, ?, ?)', id, name, JSON.stringify(uris), Date.now());
    return {
      client_id: id,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: name,
      redirect_uris: uris,
      token_endpoint_auth_method: 'none',
      grant_types: grants,
      response_types: grants.includes('authorization_code') ? ['code'] : [],
    };
  }

  private async clientDocument(url: string): Promise<ClientDoc> {
    const cached = this.clientDocs.get(url);
    if (cached && cached.expires > Date.now()) return cached.doc;
    let res: Response;
    try {
      res = await this.fetchFn(url, { headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(10_000) });
    } catch (e) {
      throw new OAuthError('invalid_client', `Could not fetch the client metadata document: ${(e as Error).message}`, 401);
    }
    if (!res.ok) throw new OAuthError('invalid_client', `The client metadata document returned ${res.status}.`, 401);
    const doc = (await res.json().catch(() => ({}))) as Partial<ClientDoc>;
    if (doc.client_id !== url) throw new OAuthError('invalid_client', 'The client metadata document does not name itself as client_id.', 401);
    if (!Array.isArray(doc.redirect_uris) || !doc.redirect_uris.every((u) => typeof u === 'string' && isAllowedRedirect(u))) throw new OAuthError('invalid_client', 'The client metadata document has no valid redirect_uris.', 401);
    const clean: ClientDoc = { client_id: url, redirect_uris: doc.redirect_uris, ...(typeof doc.client_name === 'string' ? { client_name: doc.client_name.slice(0, 100) } : {}) };
    this.clientDocs.set(url, { doc: clean, expires: Date.now() + CLIENT_DOC_TTL });
    return clean;
  }

  /** The name of a client and the redirect URIs it registered. */
  private async client(clientId: string | undefined): Promise<{ name: string; uris: string[] }> {
    if (!clientId) throw new OAuthError('invalid_request', 'client_id is required.');
    if (/^https:\/\//.test(clientId)) {
      const doc = await this.clientDocument(clientId);
      return { name: doc.client_name ?? new URL(clientId).host, uris: doc.redirect_uris };
    }
    const row = this.one('SELECT name, redirect_uris FROM oauth_clients WHERE id = ?', clientId);
    if (!row) throw new OAuthError('invalid_client', 'Unknown client_id.', 401);
    return { name: row.name as string, uris: JSON.parse(row.redirect_uris as string) as string[] };
  }

  // --- Authorization ------------------------------------------------------------------

  /** Starts the flow: a pending authorization for the consent page, or a redirect carrying an error. A bad client throws. */
  async authorize(issuer: string, q: AuthorizeParams): Promise<AuthorizeOutcome> {
    const client = await this.client(q.client_id);
    if (!q.redirect_uri) throw new OAuthError('invalid_request', 'redirect_uri is required.');
    if (!client.uris.some((u) => redirectMatches(u, q.redirect_uri!))) throw new OAuthError('invalid_request', 'redirect_uri is not registered for this client.');
    const back = (error: string, description: string): AuthorizeOutcome => ({ kind: 'redirect', url: this.redirect(issuer, q.redirect_uri!, { error, error_description: description, state: q.state }) });
    if (q.response_type !== 'code') return back('unsupported_response_type', 'Only response_type=code is supported.');
    if (!q.code_challenge) return back('invalid_request', 'code_challenge is required (PKCE).');
    if ((q.code_challenge_method ?? 'plain') !== 'S256') return back('invalid_request', 'code_challenge_method must be S256.');
    if (q.resource && !isResource(issuer, q.resource)) return back('invalid_target', `Unknown resource; this server issues tokens for ${issuer}/mcp.`);
    const scope = cleanScope(q.scope);
    if (!scope) return back('invalid_scope', `Supported scopes: ${MCP_SCOPES.join(' ')}.`);
    this.purge();
    const params: PendingParams = {
      response_type: 'code', client_id: q.client_id!, redirect_uri: q.redirect_uri, code_challenge: q.code_challenge, code_challenge_method: 'S256', scope,
      ...(q.state !== undefined ? { state: q.state } : {}), ...(q.resource ? { resource: q.resource } : {}),
    };
    return { kind: 'consent', pendingId: this.addPending(params, client.name) };
  }

  private addPending(params: PendingParams, clientName: string): string {
    const id = newToken();
    this.sql.exec('INSERT INTO oauth_pending (id, params, client_name, user_id, csrf, expires_at) VALUES (?, ?, ?, NULL, ?, ?)', id, JSON.stringify(params), clientName, newToken(), Date.now() + PENDING_TTL);
    return id;
  }

  private pending(id: string | undefined): { id: string; params: PendingParams; clientName: string; userId: string | null; csrf: string } | null {
    if (!id) return null;
    const row = this.one('SELECT * FROM oauth_pending WHERE id = ? AND expires_at > ?', id, Date.now());
    return row ? { id: row.id as string, params: JSON.parse(row.params as string) as PendingParams, clientName: row.client_name as string, userId: (row.user_id as string | null) ?? null, csrf: row.csrf as string } : null;
  }

  /** Whether a pending authorization is still there (a page reached without a session sends the person to sign in first). */
  pendingExists(id: string): boolean {
    return !!this.pending(id);
  }

  /**
   * The consent page for the person signed in. The pending authorization is theirs from here on: the decision is only
   * taken from the same person, with the page's CSRF token, so another session cannot finish it.
   */
  consent(pendingId: string, userId: string): ConsentInfo {
    const p = this.pending(pendingId);
    if (!p) throw new OAuthError('invalid_request', 'This sign-in link has expired. Start again from your agent.');
    this.sql.exec('UPDATE oauth_pending SET user_id = ? WHERE id = ?', userId, p.id);
    const organizations = this.rows("SELECT organization_id FROM accounts WHERE user_id = ? AND state <> 'removed' ORDER BY organization_id", userId).map((r) => r.organization_id as string);
    const last = this.rows('SELECT org_id FROM oauth_connections WHERE user_id = ? ORDER BY created_at DESC', userId).map((r) => r.org_id as string).find((o) => organizations.includes(o));
    return {
      clientName: p.clientName,
      scopes: p.params.scope.split(' '),
      csrf: p.csrf,
      device: p.params.device ? { origin: p.params.origin ?? 'an unknown address' } : null,
      organizations,
      preselect: last ?? organizations[0] ?? null,
    };
  }

  /**
   * The person allowed or denied, for one of their organizations: where to send the browser (back to the client, or for a
   * device to the done page). The organization must be one of theirs; a refusal leaves the authorization pending.
   */
  decide(issuer: string, pendingId: string | undefined, userId: string, csrf: string | undefined, allow: boolean, orgId: string | undefined, ticked?: string[]): string {
    const p = this.pending(pendingId);
    if (!p) throw new OAuthError('invalid_request', 'This sign-in link has expired. Start again from your agent.');
    if (p.userId !== userId || !csrf || csrf !== p.csrf) throw new OAuthError('invalid_request', 'This page is out of date or was opened in another account. Start again from your agent.', 403);
    if (allow && (!orgId || !this.isMember(userId, orgId))) throw new OAuthError('access_denied', 'Choose one of your organizations.', 403);
    // What the person ticked on the page, within what the client asked for.
    const scope = grantedScope(p.params.scope, ticked);
    if (allow && !scope) throw new OAuthError('access_denied', 'Choose at least one thing the agent may use.', 403);
    this.sql.exec('DELETE FROM oauth_pending WHERE id = ?', p.id);
    if (p.params.device) {
      const changed = this.rows(
        "UPDATE oauth_device SET status = ?, user_id = ?, org_id = ?, scope = ? WHERE hash = ? AND status = 'pending' AND expires_at >= ? RETURNING hash",
        allow ? 'approved' : 'denied', allow ? userId : null, allow ? orgId! : null, allow ? scope! : p.params.scope, p.params.device, Date.now());
      if (!changed.length) throw new OAuthError('invalid_request', 'This code has expired or was already used. Start again from your agent.');
      return `/oauth/device/done${allow ? '?ok=1' : ''}`;
    }
    if (!allow) return this.redirect(issuer, p.params.redirect_uri, { error: 'access_denied', error_description: 'The user declined.', state: p.params.state });
    const code = newToken();
    this.sql.exec(
      'INSERT INTO oauth_codes (hash, client_id, client_name, user_id, org_id, redirect_uri, code_challenge, scope, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      sha(code), p.params.client_id, p.clientName, userId, orgId!, p.params.redirect_uri, p.params.code_challenge, scope!, Date.now() + CODE_TTL);
    return this.redirect(issuer, p.params.redirect_uri, { code, state: p.params.state });
  }

  private redirect(issuer: string, uri: string, params: Record<string, string | undefined>): string {
    const url = new URL(uri);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
    url.searchParams.set('iss', issuer); // RFC 9207: the client checks who answered.
    return url.href;
  }

  // --- Device sign-in (RFC 8628) -----------------------------------------------------------

  /**
   * An agent without a browser asks to sign in: it shows the person the address and the code, and polls the token endpoint
   * while they enter it on /oauth/device. No verification_uri_complete: typing the code is what makes the person look at it.
   */
  async deviceAuthorization(issuer: string, form: Record<string, string>, origin: string) {
    const client = await this.client(form.client_id);
    const resource = form.resource || resourceAt(issuer, '/mcp');
    if (!isResource(issuer, resource)) throw new OAuthError('invalid_target', `Unknown resource; this server issues tokens for ${issuer}/mcp.`);
    const scope = cleanScope(form.scope);
    if (!scope) throw new OAuthError('invalid_scope', `Supported scopes: ${MCP_SCOPES.join(' ')}.`);
    this.purge();
    const deviceCode = newToken();
    let userCode = '';
    do userCode = Array.from({ length: 8 }, () => USER_CODE_LETTERS[randomInt(USER_CODE_LETTERS.length)]).join('');
    while (this.one('SELECT 1 AS x FROM oauth_device WHERE user_code = ?', userCode));
    this.sql.exec(
      "INSERT INTO oauth_device (hash, user_code, client_id, client_name, scope, resource, origin, status, interval_s, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)",
      sha(deviceCode), userCode, form.client_id, client.name, scope, resource, origin.slice(0, 200), DEVICE_INTERVAL_S, Date.now() + DEVICE_TTL);
    return { device_code: deviceCode, user_code: `${userCode.slice(0, 4)}-${userCode.slice(4)}`, verification_uri: `${issuer}/oauth/device`, expires_in: DEVICE_TTL / 1000, interval: DEVICE_INTERVAL_S };
  }

  /** The person entered a code on /oauth/device: a pending authorization like the code flow's, which ends on the device row. */
  startDevice(input: unknown, address: string): { pendingId: string } | { error: string } {
    const now = Date.now();
    const key = `mcp-device:${address}`;
    const tries = this.one('SELECT window_start, count FROM rate_limit_windows WHERE key = ?', key);
    const counting = tries && (tries.window_start as number) > now - DEVICE_TTL ? (tries.count as number) : 0;
    if (counting >= DEVICE_TRIES) return { error: 'Too many wrong codes. Wait a few minutes, then try again.' };
    const code = typeof input === 'string' ? input.toUpperCase().replace(/[^A-Z]/g, '') : '';
    const row = code.length === 8 ? this.one("SELECT * FROM oauth_device WHERE user_code = ? AND status = 'pending' AND expires_at >= ?", code, now) : undefined;
    if (!row) {
      this.sql.exec(
        `INSERT INTO rate_limit_windows (key, window_start, count) VALUES (?, ?, 1)
         ON CONFLICT (key) DO UPDATE SET count = CASE WHEN window_start <= ? THEN 1 ELSE count + 1 END, window_start = CASE WHEN window_start <= ? THEN ? ELSE window_start END`,
        key, now, now - DEVICE_TTL, now - DEVICE_TTL, now);
      return { error: "That code isn't right, or it has expired. Check the code your agent shows, or start again there." };
    }
    const params: PendingParams = { client_id: row.client_id as string, redirect_uri: '', code_challenge: '', scope: row.scope as string, resource: row.resource as string, device: row.hash as string, origin: row.origin as string };
    return { pendingId: this.addPending(params, row.client_name as string) };
  }

  private exchangeDevice(form: Record<string, string>) {
    if (!form.device_code) throw new OAuthError('invalid_request', 'device_code is required.');
    const row = this.one('SELECT * FROM oauth_device WHERE hash = ?', sha(form.device_code));
    if (!row || (form.client_id && form.client_id !== row.client_id)) throw new OAuthError('invalid_grant', 'The device code is invalid.');
    const now = Date.now();
    if ((row.expires_at as number) < now) {
      this.sql.exec('DELETE FROM oauth_device WHERE hash = ?', row.hash);
      throw new OAuthError('expired_token', 'The device code has expired. Start the sign-in again.');
    }
    const interval = row.interval_s as number;
    // A second of slack for the time a request takes; a slow_down widens the interval for good (RFC 8628 §3.5).
    if (row.last_poll_at !== null && now - (row.last_poll_at as number) < interval * 1000 - 1000) {
      this.sql.exec('UPDATE oauth_device SET interval_s = interval_s + 5, last_poll_at = ? WHERE hash = ?', now, row.hash);
      throw new OAuthError('slow_down', `Poll at most every ${interval + 5} seconds.`);
    }
    this.sql.exec('UPDATE oauth_device SET last_poll_at = ? WHERE hash = ?', now, row.hash);
    if (row.status === 'pending') throw new OAuthError('authorization_pending', 'Waiting for the user to enter the code and allow access.');
    this.sql.exec('DELETE FROM oauth_device WHERE hash = ?', row.hash);
    if (row.status !== 'approved' || !row.user_id || !row.org_id || !this.isMember(row.user_id as string, row.org_id as string)) throw new OAuthError('access_denied', 'The user declined.');
    this.connect(row.hash as string, row.user_id as string, row.org_id as string, row.client_name as string, row.origin as string, row.resource as string);
    return this.issue(row.client_id as string, row.user_id as string, row.org_id as string, row.scope as string, row.hash as string, row.resource as string);
  }

  // --- Tokens ----------------------------------------------------------------------------

  token(issuer: string, form: Record<string, string>, origin = '') {
    if (form.grant_type === 'authorization_code') return this.exchangeCode(issuer, form, origin);
    if (form.grant_type === 'refresh_token') return this.refresh(form);
    if (form.grant_type === DEVICE_GRANT) return this.exchangeDevice(form);
    throw new OAuthError('unsupported_grant_type', `grant_type must be authorization_code, refresh_token or ${DEVICE_GRANT}.`);
  }

  private revokeFamily(family: string): void {
    this.sql.exec('UPDATE oauth_tokens SET revoked_at = ? WHERE family = ? AND revoked_at IS NULL', Date.now(), family);
  }

  private exchangeCode(issuer: string, form: Record<string, string>, origin: string) {
    const { code, code_verifier, redirect_uri, client_id, resource } = form;
    if (!code || !code_verifier) throw new OAuthError('invalid_request', 'code and code_verifier are required.');
    const row = this.one('SELECT * FROM oauth_codes WHERE hash = ?', sha(code));
    if (!row || (row.expires_at as number) < Date.now()) throw new OAuthError('invalid_grant', 'The authorization code is invalid or has expired.');
    if (row.used_at) {
      // A replayed code: whoever holds it may have stolen it, so nothing issued from it stays valid.
      this.revokeFamily(row.hash as string);
      throw new OAuthError('invalid_grant', 'The authorization code was already used.');
    }
    if (client_id && client_id !== row.client_id) throw new OAuthError('invalid_grant', 'client_id does not match the code.');
    if (redirect_uri && redirect_uri !== row.redirect_uri) throw new OAuthError('invalid_grant', 'redirect_uri does not match the code.');
    if (sha(code_verifier) !== row.code_challenge) throw new OAuthError('invalid_grant', 'code_verifier does not match the code challenge.');
    if (resource && !isResource(issuer, resource)) throw new OAuthError('invalid_target', `Unknown resource; this server issues tokens for ${issuer}/mcp.`);
    if (!this.isMember(row.user_id as string, row.org_id as string)) throw new OAuthError('invalid_grant', 'You are no longer a member of the organization this was allowed for.');
    this.sql.exec('UPDATE oauth_codes SET used_at = ? WHERE hash = ?', Date.now(), row.hash);
    // Listed in Docs' Settings, where the person can disconnect it.
    this.connect(row.hash as string, row.user_id as string, row.org_id as string, row.client_name as string, origin, resourceAt(issuer, '/mcp'));
    return this.issue(row.client_id as string, row.user_id as string, row.org_id as string, row.scope as string, row.hash as string);
  }

  private connect(family: string, userId: string, orgId: string, clientName: string, origin: string, resource: string): void {
    this.sql.exec('INSERT OR IGNORE INTO oauth_connections (id, family, user_id, org_id, client_name, origin, resource, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', randomUUID(), family, userId, orgId, clientName, origin.slice(0, 200), resource, Date.now());
  }

  private refresh(form: Record<string, string>) {
    const { refresh_token, scope: wanted } = form;
    if (!refresh_token) throw new OAuthError('invalid_request', 'refresh_token is required.');
    const row = this.tokenRow(refresh_token, 'refresh');
    if (!row) throw new OAuthError('invalid_grant', 'The refresh token is invalid or has expired.');
    if (row.revoked_at) {
      // Reuse of a rotated refresh token: the whole family is treated as stolen.
      this.revokeFamily(row.family as string);
      throw new OAuthError('invalid_grant', 'The refresh token was already used.');
    }
    if (form.client_id && form.client_id !== row.client_id) throw new OAuthError('invalid_grant', 'client_id does not match the refresh token.');
    if (!this.isMember(row.user_id as string, row.org_id as string) || !this.activeUser(row.user_id as string)) {
      this.revokeFamily(row.family as string);
      throw new OAuthError('invalid_grant', 'You are no longer a member of the organization this was allowed for. Sign in again.');
    }
    const scope = wanted ? cleanScope(wanted) : (row.scope as string);
    if (!scope || !scope.split(' ').every((s) => (row.scope as string).split(' ').includes(s))) throw new OAuthError('invalid_scope', 'The requested scope exceeds the original grant.');
    this.sql.exec('UPDATE oauth_tokens SET revoked_at = ? WHERE hash = ?', Date.now(), row.hash);
    return this.issue(row.client_id as string, row.user_id as string, row.org_id as string, scope, row.family as string, (row.resource as string | null) ?? null);
  }

  /** `resource` binds the tokens to that one endpoint (a device sign-in); null leaves them good for every version of it. */
  private issue(clientId: string, userId: string, orgId: string, scope: string, family: string, resource: string | null = null) {
    const access = newToken();
    const refresh = newToken();
    const now = Date.now();
    const accessTtl = resource ? DEVICE_ACCESS_TTL : ACCESS_TTL;
    const insert = 'INSERT INTO oauth_tokens (hash, kind, client_id, user_id, org_id, scope, family, resource, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)';
    this.sql.exec(insert, sha(access), 'access', clientId, userId, orgId, scope, family, resource, now + accessTtl, now);
    this.sql.exec(insert, sha(refresh), 'refresh', clientId, userId, orgId, scope, family, resource, now + REFRESH_TTL, now);
    return { access_token: access, token_type: 'Bearer', expires_in: Math.floor(accessTtl / 1000), refresh_token: refresh, scope };
  }

  /** RFC 7009: the client gives a token back. Revoking a refresh token ends its whole family. */
  revoke(form: Record<string, string>): void {
    if (!form.token) return;
    const row = this.one('SELECT hash, kind, family FROM oauth_tokens WHERE hash = ?', sha(form.token));
    if (!row) return;
    if (row.kind === 'refresh') this.revokeFamily(row.family as string);
    else this.sql.exec('UPDATE oauth_tokens SET revoked_at = ? WHERE hash = ? AND revoked_at IS NULL', Date.now(), row.hash);
  }

  private tokenRow(raw: string, kind: 'access' | 'refresh'): Row | null {
    const row = this.one('SELECT * FROM oauth_tokens WHERE hash = ? AND kind = ?', sha(raw), kind);
    return row && (row.expires_at as number) >= Date.now() ? row : null;
  }

  /**
   * The person and organization behind a bearer token on an MCP path, or why not, as a word for the log and a sentence for
   * the agent holding the token (one driving the endpoint by hand has nothing else to tell it to refresh).
   */
  authenticate(issuer: string, authorization: string | undefined, endpoint = '/mcp'): McpAuth {
    const refresh = `POST ${issuer}/oauth/token as a form with grant_type=refresh_token, refresh_token=<the refresh token from your sign-in> and client_id=<your client id>. Keep the refresh token it returns in place of the old one: each works once.`;
    const m = /^Bearer\s+(\S+)$/i.exec(authorization ?? '');
    if (!m) return { ok: false, reason: 'no_token', description: 'Send an access token as "Authorization: Bearer <token>".' };
    const row = this.one('SELECT * FROM oauth_tokens WHERE hash = ?', sha(m[1]!));
    if (!row) return { ok: false, reason: 'unknown_token', description: `This access token is not known here; it may have expired some time ago. If you have a refresh token, get a new access token without signing in again: ${refresh} Otherwise sign in again.` };
    if (row.kind === 'refresh') return { ok: false, reason: 'refresh_token_sent', description: `That is a refresh token, not an access token. Exchange it for an access token: ${refresh}` };
    if (row.revoked_at) return { ok: false, reason: 'revoked', description: 'This sign-in was disconnected or replaced, so its tokens no longer work. Sign in again.' };
    if ((row.expires_at as number) < Date.now()) return { ok: false, reason: 'expired', description: `This access token has expired. Get a new one without signing in again: ${refresh}` };
    if (row.resource && row.resource !== resourceAt(issuer, endpoint)) return { ok: false, reason: 'wrong_endpoint', description: `This access token is for ${row.resource as string}; send your requests there.` };
    const userId = row.user_id as string;
    const orgId = row.org_id as string;
    const email = this.emailOf(userId);
    if (email === null) return { ok: false, reason: 'no_account', description: 'The account this token was issued to no longer exists.' };
    if (!this.isMember(userId, orgId)) return { ok: false, reason: 'not_a_member', description: 'You are no longer a member of the organization this agent was allowed to use. Sign in again and choose an organization.' };
    const account = this.one('SELECT id, state FROM accounts WHERE user_id = ? AND organization_id = ?', userId, orgId);
    const refused = accountGate(account ? { state: account.state as AccountState } : null);
    if (refused) return { ok: false, reason: refused.code, description: refused.message, status: refused.statusCode };
    return { ok: true, caller: { userId, email, orgId, accountId: (account?.id as string | undefined) ?? null, scope: row.scope as string } };
  }

  // --- Connections (Docs' Settings) --------------------------------------------------------------

  /** The agents connected to this account that can still get tokens, newest first. */
  connections(userId: string): McpConnection[] {
    return this.rows(
      `SELECT c.id, c.client_name, c.origin, c.resource, c.org_id, c.created_at, MAX(t.created_at) AS last_active FROM oauth_connections c
       JOIN oauth_tokens t ON t.family = c.family AND t.kind = 'refresh' AND t.revoked_at IS NULL AND t.expires_at >= ?
       WHERE c.user_id = ? GROUP BY c.id ORDER BY c.created_at DESC`,
      Date.now(), userId,
    ).map((r) => ({
      id: r.id as string,
      name: r.client_name as string,
      origin: r.origin as string,
      endpoint: r.resource as string,
      organizationId: r.org_id as string,
      connectedAt: iso(r.created_at as number),
      ...(r.last_active ? { lastActiveAt: iso(r.last_active as number) } : {}),
    }));
  }

  /** Signs an agent out: every token it holds stops working at once. False when the account has no such agent. */
  disconnect(userId: string, id: string): boolean {
    const row = this.one('SELECT family FROM oauth_connections WHERE id = ? AND user_id = ?', id, userId);
    if (!row) return false;
    this.revokeFamily(row.family as string);
    this.sql.exec('DELETE FROM oauth_connections WHERE id = ?', id);
    return true;
  }

  private purge(): void {
    const now = Date.now();
    this.sql.exec('DELETE FROM oauth_pending WHERE expires_at < ?', now);
    this.sql.exec('DELETE FROM oauth_codes WHERE expires_at < ?', now);
    this.sql.exec('DELETE FROM oauth_tokens WHERE expires_at < ?', now);
    this.sql.exec('DELETE FROM oauth_connections WHERE family NOT IN (SELECT family FROM oauth_tokens)');
    // Kept a while past expiry, so a late poll hears expired_token rather than an unknown code.
    this.sql.exec('DELETE FROM oauth_device WHERE expires_at < ?', now - DEVICE_TTL);
    this.sql.exec("DELETE FROM rate_limit_windows WHERE key LIKE 'mcp-device:%' AND window_start < ?", now - DEVICE_TTL);
  }
}
