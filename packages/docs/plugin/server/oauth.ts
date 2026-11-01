// OAuth 2.1 authorization server for the plugin, the way ChatGPT (and Claude) connect to a remote MCP server:
// discovery documents, client identification by metadata document or dynamic registration, the
// authorization code flow with PKCE, a sign-in page that checks the app's own accounts (password or Google),
// a consent page, opaque access and refresh tokens, and bearer validation for /mcp. Someone without an account
// can create one from the sign-in page (email and password, then the emailed link, which comes back to the
// same sign-in). An agent without a browser
// (mcp-remote --device-code, say) signs in with the device authorization grant instead (RFC 8628): the person
// enters its code on /oauth/device, and its tokens are bound to the versioned endpoint it asked for, never /mcp.
//
// State lives in a small SQLite file of its own (plugin.db); only hashes of codes and tokens are stored.
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { validateCredentials, type AuthService, type User } from '../../server/auth.ts';
import type { Mailer } from '../../server/mail.ts';
import type { ConnectedAgent } from '../../shared/types.ts';
import { GoogleLoginError, type GoogleLogin } from '../../server/googleAuth.ts';

export const SCOPES = ['files:read', 'files:write'] as const;
export const ACCESS_TTL_MS = 60 * 60 * 1000;
export const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * How long an access token from a device sign-in works. Much longer than the hour of the code flow's: an agent
 * that drives the endpoint by hand often never refreshes, and would ask its person for a new code every hour.
 * The person can cut one off on the Settings page.
 */
export const DEVICE_ACCESS_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CODE_TTL_MS = 5 * 60 * 1000;
const PENDING_TTL_MS = 15 * 60 * 1000;
/** How long a sign-in waits for someone who is creating an account to open the emailed link. */
const SIGNUP_TTL_MS = 60 * 60 * 1000;
const CLIENT_DOC_TTL_MS = 60 * 60 * 1000;
export const DEVICE_GRANT = 'urn:ietf:params:oauth:grant-type:device_code';
const GRANTS = ['authorization_code', 'refresh_token', DEVICE_GRANT];
const DEVICE_TTL_MS = 10 * 60 * 1000;
const DEVICE_INTERVAL_S = 5;
/** Wrong codes one address may enter on /oauth/device before it has to wait. */
const DEVICE_TRIES = 10;
/** Letters for user codes: no vowels (so no words) and none easily read as another; 20^8 codes. */
const USER_CODE_LETTERS = 'BCDFGHJKLMNPQRSTVWXZ';

export interface OAuthOptions {
  db: DatabaseSync;
  /** Public origin of the plugin server, e.g. https://docs-mcp.example.com. */
  issuer: string;
  /** The resource tokens are for: the MCP endpoint. */
  resource: string;
  auth: AuthService;
  /** The email behind an account id, for the consent page. */
  profile: (userId: string) => { email: string } | null;
  google?: GoogleLogin | null;
  /** Sends the verification link of a new account. Without it the sign-in page does not offer to create one. */
  sendMail?: Mailer;
  /** False when this address has been sent too many emails lately (the app's limit); asking counts as one. */
  mailAllowed?: (email: string) => boolean;
  /** Tests pass a fake, to serve client metadata documents. */
  fetchFn?: typeof fetch;
  appName?: string;
}

/** An OAuth error with the code the spec names; the HTTP layer maps it to a status and JSON body. */
export class OAuthError extends Error {
  code: string;
  status: number;
  constructor(code: string, description: string, status = 400) {
    super(description);
    this.code = code;
    this.status = status;
  }
}

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

interface Pending {
  id: string;
  /** A device sign-in has no redirect_uri or code_challenge (both ''); it names the device code's hash and where the request came from. */
  params: AuthorizeParams & { client_id: string; redirect_uri: string; code_challenge: string; scope: string; device?: string; origin?: string };
  client_name: string;
  user_id: string | null;
}

export type AuthorizeOutcome = { kind: 'page'; pendingId: string } | { kind: 'redirect'; url: string };

const sha = (s: string) => createHash('sha256').update(s).digest('base64url');
const token = () => randomBytes(32).toString('base64url');
const now = () => Date.now();
const iso = (ms: number) => new Date(ms).toISOString();

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export class OAuthServer {
  private readonly db: DatabaseSync;
  readonly issuer: string;
  readonly resource: string;
  private readonly auth: AuthService;
  private readonly profile: OAuthOptions['profile'];
  private readonly google: GoogleLogin | null;
  private readonly sendMail: Mailer | null;
  private readonly mailAllowed: (email: string) => boolean;
  private readonly fetchFn: typeof fetch;
  private readonly appName: string;
  private readonly clientDocs = new Map<string, { doc: ClientDoc; expires: number }>();
  /** Wrong codes entered on /oauth/device, by address. */
  private readonly deviceTries = new Map<string, { count: number; until: number }>();

  constructor(opts: OAuthOptions) {
    this.db = opts.db;
    this.issuer = opts.issuer.replace(/\/$/, '');
    this.resource = opts.resource;
    this.auth = opts.auth;
    this.profile = opts.profile;
    this.google = opts.google ?? null;
    this.sendMail = opts.sendMail ?? null;
    this.mailAllowed = opts.mailAllowed ?? (() => true);
    this.fetchFn = opts.fetchFn ?? fetch;
    this.appName = opts.appName ?? 'Universal Docs';
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS oauth_clients (id TEXT PRIMARY KEY, name TEXT NOT NULL, redirect_uris TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS oauth_pending (id TEXT PRIMARY KEY, params TEXT NOT NULL, client_name TEXT NOT NULL, user_id TEXT, expires_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS oauth_codes (hash TEXT PRIMARY KEY, client_id TEXT NOT NULL, user_id TEXT NOT NULL, redirect_uri TEXT NOT NULL, code_challenge TEXT NOT NULL, scope TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT);
      CREATE TABLE IF NOT EXISTS oauth_tokens (hash TEXT PRIMARY KEY, kind TEXT NOT NULL, client_id TEXT NOT NULL, user_id TEXT NOT NULL, scope TEXT NOT NULL, family TEXT NOT NULL, expires_at TEXT NOT NULL, revoked_at TEXT, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS oauth_tokens_family ON oauth_tokens(family);
      CREATE TABLE IF NOT EXISTS oauth_connections (id TEXT PRIMARY KEY, family TEXT NOT NULL UNIQUE, user_id TEXT NOT NULL, client_name TEXT NOT NULL, origin TEXT NOT NULL, resource TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS oauth_device (hash TEXT PRIMARY KEY, user_code TEXT NOT NULL UNIQUE, client_id TEXT NOT NULL, client_name TEXT NOT NULL, scope TEXT NOT NULL, resource TEXT NOT NULL, origin TEXT NOT NULL, status TEXT NOT NULL, user_id TEXT, interval_s INTEGER NOT NULL, last_poll_at INTEGER, expires_at TEXT NOT NULL);
    `);
    // The resource a token is bound to (a device sign-in's endpoint), or NULL for every endpoint.
    const cols = this.db.prepare('PRAGMA table_info(oauth_tokens)').all() as { name: string }[];
    if (!cols.some((c) => c.name === 'resource')) this.db.exec('ALTER TABLE oauth_tokens ADD COLUMN resource TEXT');
  }

  get googleEnabled(): boolean {
    return !!this.google;
  }

  /**
   * The resource for an MCP path. Every version of the endpoint (/mcp, /mcp/v2) is the same server with the same
   * accounts, so a token for one is good for all of them.
   */
  private resourceAt(endpoint: string): string {
    return endpoint === '/mcp' ? this.resource : `${this.resource}${endpoint.slice('/mcp'.length)}`;
  }

  /** Whether tokens are issued for this resource: the MCP endpoint, or a version of it. */
  private isResource(resource: string): boolean {
    return resource === this.resource || (resource.startsWith(`${this.resource}/v`) && /^\/v\d+$/.test(resource.slice(this.resource.length)));
  }

  // --- Discovery ----------------------------------------------------------------------

  /** RFC 9728: where the resource server's tokens come from. */
  protectedResourceMetadata(endpoint = '/mcp') {
    return {
      resource: this.resourceAt(endpoint),
      authorization_servers: [this.issuer],
      scopes_supported: [...SCOPES],
      bearer_methods_supported: ['header'],
      resource_name: this.appName,
    };
  }

  /** RFC 8414: the authorization server's endpoints and features. */
  authorizationServerMetadata() {
    return {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/oauth/authorize`,
      token_endpoint: `${this.issuer}/oauth/token`,
      registration_endpoint: `${this.issuer}/oauth/register`,
      revocation_endpoint: `${this.issuer}/oauth/revoke`,
      device_authorization_endpoint: `${this.issuer}/oauth/device_authorization`,
      response_types_supported: ['code'],
      response_modes_supported: ['query'],
      grant_types_supported: GRANTS,
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      revocation_endpoint_auth_methods_supported: ['none'],
      scopes_supported: [...SCOPES],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    };
  }

  /** The challenge for a 401 on the MCP endpoint, which makes ChatGPT start (or redo) the OAuth flow. */
  wwwAuthenticate(error?: string, endpoint = '/mcp', description?: string): string {
    const parts = [`Bearer resource_metadata="${this.issuer}/.well-known/oauth-protected-resource${endpoint}"`];
    if (error) parts.push(`error="${error}"`);
    if (error && description) parts.push(`error_description="${description.replace(/["\\]/g, "'")}"`);
    return parts.join(', ');
  }

  // --- Clients ------------------------------------------------------------------------

  /** Dynamic client registration (RFC 7591), for clients without a metadata document. */
  register(body: unknown) {
    const b = (body ?? {}) as { redirect_uris?: unknown; client_name?: unknown; token_endpoint_auth_method?: unknown; grant_types?: unknown };
    const asked = Array.isArray(b.grant_types) ? b.grant_types.filter((g): g is string => typeof g === 'string' && GRANTS.includes(g)) : [];
    const grants = asked.length ? asked : ['authorization_code', 'refresh_token'];
    const uris = Array.isArray(b.redirect_uris) ? b.redirect_uris.filter((u): u is string => typeof u === 'string') : [];
    // A client that only signs in with the device grant never comes back to a redirect URI.
    if ((grants.includes('authorization_code') && !uris.length) || !uris.every(isAllowedRedirect)) throw new OAuthError('invalid_redirect_uri', 'redirect_uris must be https URLs (or http://localhost for development).');
    if (b.token_endpoint_auth_method !== undefined && b.token_endpoint_auth_method !== 'none') throw new OAuthError('invalid_client_metadata', 'Only token_endpoint_auth_method "none" (public client with PKCE) is supported.');
    const id = `dcr_${randomUUID()}`;
    const name = typeof b.client_name === 'string' && b.client_name.trim() ? b.client_name.trim().slice(0, 100) : uris.length ? new URL(uris[0]).host : 'An agent';
    this.db.prepare('INSERT INTO oauth_clients (id, name, redirect_uris, created_at) VALUES (?, ?, ?, ?)').run(id, name, JSON.stringify(uris), iso(now()));
    return {
      client_id: id,
      client_id_issued_at: Math.floor(now() / 1000),
      client_name: name,
      redirect_uris: uris,
      token_endpoint_auth_method: 'none',
      grant_types: grants,
      response_types: grants.includes('authorization_code') ? ['code'] : [],
    };
  }

  /** The name of a client that has no redirect URI to check (a device sign-in). */
  private async clientName(clientId: string | undefined): Promise<string> {
    if (!clientId) throw new OAuthError('invalid_request', 'client_id is required.');
    if (/^https:\/\//.test(clientId)) return (await this.clientDocument(clientId)).client_name ?? new URL(clientId).host;
    const row = this.db.prepare('SELECT name FROM oauth_clients WHERE id = ?').get(clientId) as { name: string } | undefined;
    if (!row) throw new OAuthError('invalid_client', 'Unknown client_id.', 401);
    return row.name;
  }

  /** Who the client is, and whether it may use this redirect URI. */
  async resolveClient(clientId: string | undefined, redirectUri: string | undefined): Promise<{ name: string }> {
    if (!clientId) throw new OAuthError('invalid_request', 'client_id is required.');
    if (!redirectUri) throw new OAuthError('invalid_request', 'redirect_uri is required.');
    let name: string;
    let uris: string[];
    if (/^https:\/\//.test(clientId)) {
      // Client ID metadata document: the id is an https URL to a JSON document describing the client.
      const doc = await this.clientDocument(clientId);
      name = doc.client_name ?? new URL(clientId).host;
      uris = doc.redirect_uris;
    } else {
      const row = this.db.prepare('SELECT name, redirect_uris FROM oauth_clients WHERE id = ?').get(clientId) as { name: string; redirect_uris: string } | undefined;
      if (!row) throw new OAuthError('invalid_client', 'Unknown client_id.', 401);
      name = row.name;
      uris = JSON.parse(row.redirect_uris) as string[];
    }
    if (!uris.some((u) => redirectMatches(u, redirectUri))) throw new OAuthError('invalid_request', 'redirect_uri is not registered for this client.');
    return { name };
  }

  private async clientDocument(url: string): Promise<ClientDoc> {
    const cached = this.clientDocs.get(url);
    if (cached && cached.expires > now()) return cached.doc;
    let res: Response;
    try {
      res = await this.fetchFn(url, { headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(10_000) });
    } catch (e) {
      throw new OAuthError('invalid_client', `Could not fetch the client metadata document: ${(e as Error).message}`, 401);
    }
    if (!res.ok) throw new OAuthError('invalid_client', `The client metadata document returned ${res.status}.`, 401);
    const doc = (await res.json()) as Partial<ClientDoc>;
    if (doc.client_id !== url) throw new OAuthError('invalid_client', 'The client metadata document does not name itself as client_id.', 401);
    if (!Array.isArray(doc.redirect_uris) || !doc.redirect_uris.every((u) => typeof u === 'string' && isAllowedRedirect(u))) throw new OAuthError('invalid_client', 'The client metadata document has no valid redirect_uris.', 401);
    const clean: ClientDoc = { client_id: url, redirect_uris: doc.redirect_uris, client_name: typeof doc.client_name === 'string' ? doc.client_name.slice(0, 100) : undefined };
    this.clientDocs.set(url, { doc: clean, expires: now() + CLIENT_DOC_TTL_MS });
    return clean;
  }

  // --- Authorization ------------------------------------------------------------------

  /**
   * Start the flow. Returns a pending sign-in to show a page for, or (once the client and redirect URI are
   * known to be genuine) a redirect carrying an error. Problems with the client itself throw.
   */
  async authorize(q: AuthorizeParams): Promise<AuthorizeOutcome> {
    const client = await this.resolveClient(q.client_id, q.redirect_uri);
    const back = (error: string, description: string) => ({ kind: 'redirect' as const, url: this.redirect(q.redirect_uri!, { error, error_description: description, state: q.state }) });
    if (q.response_type !== 'code') return back('unsupported_response_type', 'Only response_type=code is supported.');
    if (!q.code_challenge) return back('invalid_request', 'code_challenge is required (PKCE).');
    if ((q.code_challenge_method ?? 'plain') !== 'S256') return back('invalid_request', 'code_challenge_method must be S256.');
    if (q.resource && !this.isResource(q.resource)) return back('invalid_target', `Unknown resource; this server issues tokens for ${this.resource}.`);
    const scope = this.cleanScope(q.scope);
    if (!scope) return back('invalid_scope', `Supported scopes: ${SCOPES.join(' ')}.`);
    this.purge();
    const id = token();
    const params = { ...q, client_id: q.client_id!, redirect_uri: q.redirect_uri!, code_challenge: q.code_challenge, scope };
    this.db.prepare('INSERT INTO oauth_pending (id, params, client_name, user_id, expires_at) VALUES (?, ?, ?, NULL, ?)').run(id, JSON.stringify(params), client.name, iso(now() + PENDING_TTL_MS));
    return { kind: 'page', pendingId: id };
  }

  pending(id: string | undefined): Pending | null {
    if (!id) return null;
    const row = this.db.prepare('SELECT id, params, client_name, user_id, expires_at FROM oauth_pending WHERE id = ?').get(id) as { id: string; params: string; client_name: string; user_id: string | null; expires_at: string } | undefined;
    if (!row || row.expires_at < iso(now())) return null;
    return { id: row.id, params: JSON.parse(row.params) as Pending['params'], client_name: row.client_name, user_id: row.user_id };
  }

  /** The account signed in with email and password. */
  async passwordLogin(pendingId: string, email: unknown, password: unknown): Promise<{ ok: true } | { ok: false; error: string }> {
    const p = this.pending(pendingId);
    if (!p) return { ok: false, error: 'This sign-in link has expired. Start again from ChatGPT.' };
    if (typeof email !== 'string' || typeof password !== 'string' || !email.trim() || !password) return { ok: false, error: 'Enter your email and password.' };
    const user = await this.auth.login(email.trim(), password);
    if (user === 'unverified') {
      // The password was right, so this is the account's owner: send a link that comes back to this sign-in.
      const account = this.auth.unverifiedUser(email);
      if (account && this.sendMail && this.mailAllowed(account.email)) {
        await this.sendVerification(p, account);
        return { ok: false, error: `This account has not verified its email address yet. We sent a new link to ${account.email}; open it to continue.` };
      }
      return { ok: false, error: 'This account has not verified its email address yet. Check your inbox for the verification link.' };
    }
    if (!user) return { ok: false, error: 'Wrong email or password.' };
    this.setUser(pendingId, user.id);
    return { ok: true };
  }

  // --- Creating an account ------------------------------------------------------------------

  get signUpEnabled(): boolean {
    return !!this.sendMail;
  }

  /** A new account, as the app makes one: it has to verify its email, and the emailed link continues this sign-in. */
  async signUp(pendingId: string, email: unknown, password: unknown): Promise<{ ok: true; email: string } | { ok: false; error: string }> {
    const p = this.pending(pendingId);
    if (!p || !this.sendMail) return { ok: false, error: 'This sign-in link has expired. Start again from ChatGPT.' };
    const problem = validateCredentials(email, password);
    if (problem) return { ok: false, error: problem };
    if (!this.mailAllowed(email as string)) return { ok: false, error: 'Too many sign-up attempts for this address. Try again in an hour.' };
    const user = await this.auth.register(email as string, password as string);
    if (user === 'exists') return { ok: false, error: 'An account with this email already exists. Sign in instead.' };
    try {
      await this.sendVerification(p, user);
    } catch (e) {
      console.error('verification email failed', e);
      return { ok: false, error: 'The verification email could not be sent. Try again later.' };
    }
    return { ok: true, email: user.email };
  }

  /** Emails the link that verifies the address and comes back to this sign-in, which waits longer for it. */
  private async sendVerification(p: Pending, user: User): Promise<void> {
    const { token } = this.auth.createEmailVerification(user.id);
    this.db.prepare('UPDATE oauth_pending SET expires_at = ? WHERE id = ?').run(iso(now() + SIGNUP_TTL_MS), p.id);
    const link = `${this.issuer}/oauth/verify?p=${encodeURIComponent(p.id)}&token=${token}`;
    await this.sendMail!({
      to: user.email,
      subject: `Verify your email for ${this.appName}`,
      text: `Welcome to ${this.appName}! Confirm that ${user.email} is your address and continue connecting ${p.client_name} by opening this link in the browser you started in (it works for an hour):\n${link}\n\nIf you didn't create a ${this.appName} account, you can ignore this email.`,
    });
  }

  /** The emailed link was opened and confirmed: the address is verified, and the sign-in continues as that account. */
  verifyEmail(pendingId: string | undefined, token: string | undefined): { next: string } | { error: string } {
    const user = token ? this.auth.verifyEmail(token) : null;
    if (!user) return { error: 'This verification link is invalid or has expired. Sign in with your email and password to get a new one.' };
    const p = this.pending(pendingId);
    if (!p) return { error: 'Your email address is verified, but this sign-in has expired. Start again from the app you were connecting, and sign in with your new account.' };
    this.setUser(p.id, user.id);
    return { next: `/oauth/consent?p=${encodeURIComponent(p.id)}` };
  }

  /** Where to send the browser for "Continue with Google"; the callback lands on googleFinish. */
  googleStart(pendingId: string, redirectUri: string): string | null {
    if (!this.google || !this.pending(pendingId)) return null;
    return this.google.start(redirectUri, `/oauth/consent?p=${encodeURIComponent(pendingId)}`).url;
  }

  /** Back from Google: sign the account in (creating it like the app does) and return where to continue. */
  async googleFinish(state: string | undefined, code: string | undefined, error: string | undefined): Promise<{ next: string } | { error: string }> {
    if (!this.google) return { error: 'Google sign-in is not set up on this server.' };
    if (error === 'access_denied') return { error: 'The Google sign-in was cancelled.' };
    if (error || !state || !code) return { error: 'Google sign-in failed. Try again.' };
    try {
      const { identity, next } = await this.google.finish(state, code);
      const pendingId = new URL(next, this.issuer).searchParams.get('p') ?? '';
      if (!this.pending(pendingId)) return { error: 'This sign-in link has expired. Start again from ChatGPT.' };
      const user = this.auth.loginWithGoogle(identity);
      if (user === 'unverified') return { error: "Your Google account's email address isn't verified, so it can't be used to sign in." };
      this.setUser(pendingId, user.id);
      return { next };
    } catch (e) {
      if (e instanceof GoogleLoginError) return { error: e.message };
      throw e;
    }
  }

  setUser(pendingId: string, userId: string): void {
    this.db.prepare('UPDATE oauth_pending SET user_id = ? WHERE id = ?').run(userId, pendingId);
  }

  /** "Not you?": forget the account picked up from the app session and ask for a sign-in instead. */
  clearUser(pendingId: string): void {
    this.db.prepare('UPDATE oauth_pending SET user_id = NULL WHERE id = ?').run(pendingId);
  }

  /** The user allowed or denied: where to send the browser (back to the client, or for a device to the done page). */
  decide(pendingId: string | undefined, allow: boolean): string {
    const p = this.pending(pendingId);
    if (!p) throw new OAuthError('invalid_request', 'This sign-in link has expired. Start again from ChatGPT.');
    this.db.prepare('DELETE FROM oauth_pending WHERE id = ?').run(p.id);
    if (p.params.device) {
      const ok = allow && !!p.user_id;
      const changed = this.db.prepare("UPDATE oauth_device SET status = ?, user_id = ? WHERE hash = ? AND status = 'pending' AND expires_at >= ?").run(ok ? 'approved' : 'denied', ok ? p.user_id : null, p.params.device, iso(now()));
      if (!changed.changes) throw new OAuthError('invalid_request', 'This code has expired or was already used. Start again from your agent.');
      return `/oauth/device/done${ok ? '?ok=1' : ''}`;
    }
    if (!allow || !p.user_id) return this.redirect(p.params.redirect_uri, { error: 'access_denied', error_description: 'The user declined.', state: p.params.state });
    const code = token();
    this.db
      .prepare('INSERT INTO oauth_codes (hash, client_id, user_id, redirect_uri, code_challenge, scope, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(sha(code), p.params.client_id, p.user_id, p.params.redirect_uri, p.params.code_challenge, p.params.scope, iso(now() + CODE_TTL_MS));
    return this.redirect(p.params.redirect_uri, { code, state: p.params.state });
  }

  private redirect(uri: string, params: Record<string, string | undefined>): string {
    const url = new URL(uri);
    for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
    url.searchParams.set('iss', this.issuer); // RFC 9207: the client checks who answered.
    return url.href;
  }

  // --- Device sign-in (RFC 8628) -----------------------------------------------------------

  /**
   * An agent without a browser asks to sign in. It shows the person the address and the code; they enter the
   * code on /oauth/device and sign in there, while the agent polls the token endpoint. There is deliberately
   * no verification_uri_complete: typing the code is what makes the person look at it, so a link someone
   * else started cannot be approved with one click.
   */
  async deviceAuthorization(form: Record<string, string>, origin: string) {
    const clientName = await this.clientName(form.client_id);
    // Only a versioned endpoint: /mcp is the version ChatGPT reviewed, and it signs in with the code flow.
    if (!form.resource || form.resource === this.resource || !this.isResource(form.resource)) throw new OAuthError('invalid_target', `Device sign-in is for a versioned endpoint, such as ${this.resource}/v2; name it as resource.`);
    const scope = this.cleanScope(form.scope);
    if (!scope) throw new OAuthError('invalid_scope', `Supported scopes: ${SCOPES.join(' ')}.`);
    this.purge();
    const deviceCode = token();
    let userCode = '';
    do userCode = Array.from({ length: 8 }, () => USER_CODE_LETTERS[randomInt(USER_CODE_LETTERS.length)]).join('');
    while (this.db.prepare('SELECT 1 FROM oauth_device WHERE user_code = ?').get(userCode));
    this.db
      .prepare("INSERT INTO oauth_device (hash, user_code, client_id, client_name, scope, resource, origin, status, interval_s, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)")
      .run(sha(deviceCode), userCode, form.client_id, clientName, scope, form.resource, origin.slice(0, 200), DEVICE_INTERVAL_S, iso(now() + DEVICE_TTL_MS));
    return { device_code: deviceCode, user_code: `${userCode.slice(0, 4)}-${userCode.slice(4)}`, verification_uri: `${this.issuer}/oauth/device`, expires_in: DEVICE_TTL_MS / 1000, interval: DEVICE_INTERVAL_S };
  }

  /** The person entered a code on /oauth/device: a sign-in like the code flow's, which ends on the device row instead of a redirect. */
  startDevice(input: unknown, address: string): { pendingId: string } | { error: string } {
    const t = now();
    const tries = this.deviceTries.get(address);
    const counting = tries && tries.until > t ? tries : null;
    if (counting && counting.count >= DEVICE_TRIES) return { error: 'Too many wrong codes. Wait a few minutes, then try again.' };
    const code = typeof input === 'string' ? input.toUpperCase().replace(/[^A-Z]/g, '') : '';
    const row = code.length === 8
      ? (this.db.prepare("SELECT hash, client_id, client_name, scope, resource, origin FROM oauth_device WHERE user_code = ? AND status = 'pending' AND expires_at >= ?").get(code, iso(t)) as { hash: string; client_id: string; client_name: string; scope: string; resource: string; origin: string } | undefined)
      : undefined;
    if (!row) {
      this.deviceTries.set(address, { count: (counting?.count ?? 0) + 1, until: counting?.until ?? t + DEVICE_TTL_MS });
      return { error: "That code isn't right, or it has expired. Check the code your agent shows, or start again there." };
    }
    const id = token();
    const params = { client_id: row.client_id, redirect_uri: '', code_challenge: '', scope: row.scope, resource: row.resource, device: row.hash, origin: row.origin };
    this.db.prepare('INSERT INTO oauth_pending (id, params, client_name, user_id, expires_at) VALUES (?, ?, ?, NULL, ?)').run(id, JSON.stringify(params), row.client_name, iso(t + PENDING_TTL_MS));
    return { pendingId: id };
  }

  /** The agent polls: still waiting, too fast, declined, expired, or its tokens (once). */
  private exchangeDevice(form: Record<string, string>) {
    if (!form.device_code) throw new OAuthError('invalid_request', 'device_code is required.');
    const row = this.db.prepare('SELECT * FROM oauth_device WHERE hash = ?').get(sha(form.device_code)) as
      | { hash: string; client_id: string; client_name: string; origin: string; scope: string; resource: string; status: string; user_id: string | null; interval_s: number; last_poll_at: number | null; expires_at: string }
      | undefined;
    if (!row || (form.client_id && form.client_id !== row.client_id)) throw new OAuthError('invalid_grant', 'The device code is invalid.');
    if (row.expires_at < iso(now())) {
      this.db.prepare('DELETE FROM oauth_device WHERE hash = ?').run(row.hash);
      throw new OAuthError('expired_token', 'The device code has expired. Start the sign-in again.');
    }
    const t = now();
    // A second of slack for the time a request takes; a slow_down widens the interval for good (RFC 8628 3.5).
    if (row.last_poll_at !== null && t - row.last_poll_at < row.interval_s * 1000 - 1000) {
      this.db.prepare('UPDATE oauth_device SET interval_s = interval_s + 5, last_poll_at = ? WHERE hash = ?').run(t, row.hash);
      throw new OAuthError('slow_down', `Poll at most every ${row.interval_s + 5} seconds.`);
    }
    this.db.prepare('UPDATE oauth_device SET last_poll_at = ? WHERE hash = ?').run(t, row.hash);
    if (row.status === 'pending') throw new OAuthError('authorization_pending', 'Waiting for the user to enter the code and allow access.');
    this.db.prepare('DELETE FROM oauth_device WHERE hash = ?').run(row.hash);
    if (row.status !== 'approved' || !row.user_id) throw new OAuthError('access_denied', 'The user declined.');
    // Listed on the Settings page, where the person can disconnect it.
    this.db.prepare('INSERT INTO oauth_connections (id, family, user_id, client_name, origin, resource, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(randomUUID(), row.hash, row.user_id, row.client_name, row.origin, row.resource, iso(now()));
    return this.issue(row.client_id, row.user_id, row.scope, row.hash, row.resource);
  }

  /** The agents signed in to this account with a device code that can still get tokens, newest first. */
  connectedAgents(userId: string): ConnectedAgent[] {
    const rows = this.db
      .prepare(
        `SELECT c.id, c.client_name, c.origin, c.resource, c.created_at, MAX(t.created_at) AS last_active FROM oauth_connections c
         JOIN oauth_tokens t ON t.family = c.family AND t.kind = 'refresh' AND t.revoked_at IS NULL AND t.expires_at >= ?
         WHERE c.user_id = ? GROUP BY c.id ORDER BY c.created_at DESC`,
      )
      .all(iso(now()), userId) as { id: string; client_name: string; origin: string; resource: string; created_at: string; last_active: string }[];
    return rows.map((r) => ({ id: r.id, name: r.client_name, origin: r.origin, endpoint: r.resource, connectedAt: r.created_at, lastActiveAt: r.last_active }));
  }

  /** Signs an agent out: every token it holds stops working at once. False when the account has no such agent. */
  disconnectAgent(userId: string, id: string): boolean {
    const row = this.db.prepare('SELECT family FROM oauth_connections WHERE id = ? AND user_id = ?').get(id, userId) as { family: string } | undefined;
    if (!row) return false;
    this.db.prepare('UPDATE oauth_tokens SET revoked_at = ? WHERE family = ? AND revoked_at IS NULL').run(iso(now()), row.family);
    this.db.prepare('DELETE FROM oauth_connections WHERE id = ?').run(id);
    return true;
  }

  // --- Tokens ----------------------------------------------------------------------------

  token(form: Record<string, string>) {
    if (form.grant_type === 'authorization_code') return this.exchangeCode(form);
    if (form.grant_type === 'refresh_token') return this.refresh(form);
    if (form.grant_type === DEVICE_GRANT) return this.exchangeDevice(form);
    throw new OAuthError('unsupported_grant_type', `grant_type must be authorization_code, refresh_token or ${DEVICE_GRANT}.`);
  }

  private exchangeCode(form: Record<string, string>) {
    const { code, code_verifier, redirect_uri, client_id, resource } = form;
    if (!code || !code_verifier) throw new OAuthError('invalid_request', 'code and code_verifier are required.');
    const row = this.db.prepare('SELECT * FROM oauth_codes WHERE hash = ?').get(sha(code)) as
      | { hash: string; client_id: string; user_id: string; redirect_uri: string; code_challenge: string; scope: string; expires_at: string; used_at: string | null }
      | undefined;
    if (!row || row.expires_at < iso(now())) throw new OAuthError('invalid_grant', 'The authorization code is invalid or has expired.');
    if (row.used_at) {
      // A replayed code: whoever holds it may have stolen it, so nothing issued from it stays valid.
      this.db.prepare("UPDATE oauth_tokens SET revoked_at = ? WHERE family = ? AND revoked_at IS NULL").run(iso(now()), row.hash);
      throw new OAuthError('invalid_grant', 'The authorization code was already used.');
    }
    if (client_id && client_id !== row.client_id) throw new OAuthError('invalid_grant', 'client_id does not match the code.');
    if (redirect_uri && redirect_uri !== row.redirect_uri) throw new OAuthError('invalid_grant', 'redirect_uri does not match the code.');
    if (sha(code_verifier) !== row.code_challenge) throw new OAuthError('invalid_grant', 'code_verifier does not match the code challenge.');
    if (resource && !this.isResource(resource)) throw new OAuthError('invalid_target', `Unknown resource; this server issues tokens for ${this.resource}.`);
    this.db.prepare('UPDATE oauth_codes SET used_at = ? WHERE hash = ?').run(iso(now()), row.hash);
    return this.issue(row.client_id, row.user_id, row.scope, row.hash);
  }

  private refresh(form: Record<string, string>) {
    const { refresh_token, scope: wanted } = form;
    if (!refresh_token) throw new OAuthError('invalid_request', 'refresh_token is required.');
    const row = this.tokenRow(refresh_token, 'refresh');
    if (!row) throw new OAuthError('invalid_grant', 'The refresh token is invalid or has expired.');
    if (row.revoked_at) {
      // Reuse of a rotated refresh token: treat the whole family as compromised.
      this.db.prepare('UPDATE oauth_tokens SET revoked_at = ? WHERE family = ? AND revoked_at IS NULL').run(iso(now()), row.family);
      throw new OAuthError('invalid_grant', 'The refresh token was already used.');
    }
    const scope = wanted ? this.cleanScope(wanted) : row.scope;
    if (!scope || !scope.split(' ').every((s) => row.scope.split(' ').includes(s))) throw new OAuthError('invalid_scope', 'The requested scope exceeds the original grant.');
    this.db.prepare('UPDATE oauth_tokens SET revoked_at = ? WHERE hash = ?').run(iso(now()), row.hash);
    return this.issue(row.client_id, row.user_id, scope, row.family, row.resource);
  }

  /** resource binds the tokens to that one endpoint; null leaves them good for every version of it. */
  private issue(clientId: string, userId: string, scope: string, family: string, resource: string | null = null) {
    const access = token();
    const refresh = token();
    const t = now();
    // Only a device sign-in binds its tokens to an endpoint, and its access tokens are the long ones.
    const accessTtl = resource ? DEVICE_ACCESS_TTL_MS : ACCESS_TTL_MS;
    const ins = this.db.prepare('INSERT INTO oauth_tokens (hash, kind, client_id, user_id, scope, family, expires_at, created_at, resource) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    ins.run(sha(access), 'access', clientId, userId, scope, family, iso(t + accessTtl), iso(t), resource);
    ins.run(sha(refresh), 'refresh', clientId, userId, scope, family, iso(t + REFRESH_TTL_MS), iso(t), resource);
    return { access_token: access, token_type: 'Bearer', expires_in: Math.floor(accessTtl / 1000), refresh_token: refresh, scope };
  }

  /** RFC 7009: the client gives a token back. Revoking a refresh token ends its whole family. */
  revoke(form: Record<string, string>): void {
    const given = form.token;
    if (!given) return;
    const row = this.db.prepare('SELECT hash, kind, family FROM oauth_tokens WHERE hash = ?').get(sha(given)) as { hash: string; kind: string; family: string } | undefined;
    if (!row) return;
    if (row.kind === 'refresh') this.db.prepare('UPDATE oauth_tokens SET revoked_at = ? WHERE family = ? AND revoked_at IS NULL').run(iso(now()), row.family);
    else this.db.prepare('UPDATE oauth_tokens SET revoked_at = ? WHERE hash = ? AND revoked_at IS NULL').run(iso(now()), row.hash);
  }

  /** The account behind a bearer token on an MCP path (/mcp, /mcp/v2), or null. */
  authenticate(authorization: string | undefined, endpoint = '/mcp'): { userId: string; scope: string } | null {
    const m = /^Bearer\s+(\S+)$/i.exec(authorization ?? '');
    if (!m) return null;
    const row = this.tokenRow(m[1], 'access');
    if (!row || row.revoked_at) return null;
    if (row.resource && row.resource !== this.resourceAt(endpoint)) return null;
    return { userId: row.user_id, scope: row.scope };
  }

  /**
   * Why authenticate refused a request, as a word for the log and a sentence for the agent holding the token:
   * one that drives the endpoint by hand has nothing else to tell it to refresh rather than sign in again.
   */
  refusal(authorization: string | undefined, endpoint = '/mcp'): { reason: string; description: string } {
    const refresh = `POST ${this.issuer}/oauth/token as a form with grant_type=refresh_token, refresh_token=<the refresh token from your sign-in> and client_id=<your client id>. Keep the refresh token it returns in place of the old one: each works once.`;
    const m = /^Bearer\s+(\S+)$/i.exec(authorization ?? '');
    if (!m) return { reason: 'no_token', description: `Send an access token as "Authorization: Bearer <token>". How to sign in: ${this.issuer}/llms.txt` };
    const row = this.db.prepare('SELECT kind, resource, expires_at, revoked_at FROM oauth_tokens WHERE hash = ?').get(sha(m[1])) as { kind: string; resource: string | null; expires_at: string; revoked_at: string | null } | undefined;
    if (!row) return { reason: 'unknown_token', description: `This access token is not known here; it may have expired some time ago. If you have a refresh token, get a new access token without signing in again: ${refresh} Otherwise sign in again.` };
    if (row.kind === 'refresh') return { reason: 'refresh_token_sent', description: `That is a refresh token, not an access token. Exchange it for an access token: ${refresh}` };
    if (row.revoked_at) return { reason: 'revoked', description: 'This sign-in was disconnected or replaced, so its tokens no longer work. Sign in again.' };
    if (row.expires_at < iso(now())) return { reason: 'expired', description: `This access token has expired. Get a new one without signing in again: ${refresh}` };
    return { reason: 'wrong_endpoint', description: `This access token is for ${row.resource}; send your requests there.` };
  }

  private tokenRow(raw: string, kind: 'access' | 'refresh') {
    const row = this.db.prepare('SELECT * FROM oauth_tokens WHERE hash = ? AND kind = ?').get(sha(raw), kind) as
      | { hash: string; kind: string; client_id: string; user_id: string; scope: string; family: string; expires_at: string; revoked_at: string | null; resource: string | null }
      | undefined;
    return row && row.expires_at >= iso(now()) ? row : null;
  }

  private cleanScope(requested: string | undefined): string | null {
    if (!requested?.trim()) return SCOPES.join(' ');
    const parts = [...new Set(requested.trim().split(/\s+/))];
    return parts.every((s) => (SCOPES as readonly string[]).includes(s)) ? parts.join(' ') : null;
  }

  private purge(): void {
    const t = iso(now());
    this.db.prepare('DELETE FROM oauth_pending WHERE expires_at < ?').run(t);
    this.db.prepare('DELETE FROM oauth_codes WHERE expires_at < ?').run(t);
    this.db.prepare('DELETE FROM oauth_tokens WHERE expires_at < ?').run(t);
    this.db.prepare('DELETE FROM oauth_connections WHERE family NOT IN (SELECT family FROM oauth_tokens)').run();
    // Kept a while past expiry, so a late poll hears expired_token rather than an unknown code.
    this.db.prepare('DELETE FROM oauth_device WHERE expires_at < ?').run(iso(now() - DEVICE_TTL_MS));
    for (const [address, tries] of this.deviceTries) if (tries.until < now()) this.deviceTries.delete(address);
  }

  // --- Pages -------------------------------------------------------------------------------

  signInPage(pendingId: string, error?: string): string {
    const p = this.pending(pendingId);
    if (!p) return this.errorPage('This sign-in link has expired. Start again from ChatGPT.');
    const id = escapeHtml(pendingId);
    return page(
      `Sign in to ${this.appName}`,
      `<h1>Sign in to ${escapeHtml(this.appName)}</h1>
<p class="muted"><strong>${escapeHtml(p.client_name)}</strong> wants to read and edit the files in your ${escapeHtml(this.appName)} library: documents, presentations, spreadsheets, Markdown files, pictures and other stored files. Sign in to continue; you can choose what to allow on the next page.</p>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
${this.google ? `<a class="btn google" href="/oauth/google/start?p=${id}">Continue with Google</a><div class="or">or</div>` : ''}
<form method="post" action="/oauth/login">
  <input type="hidden" name="p" value="${id}">
  <label>Email <input type="email" name="email" autocomplete="username" required autofocus></label>
  <label>Password <input type="password" name="password" autocomplete="current-password" required></label>
  <button class="btn primary" type="submit">Sign in</button>
</form>
${this.sendMail ? `<p class="muted">New here? <a href="/oauth/signup?p=${id}">Create an account</a></p>` : ''}
${POLICY_LINKS}`,
    );
  }

  signUpPage(pendingId: string, error?: string, email?: string): string {
    const p = this.pending(pendingId);
    if (!p || !this.sendMail) return this.errorPage('This sign-in link has expired. Start again from ChatGPT.');
    const id = escapeHtml(pendingId);
    return page(
      `Create your ${this.appName} account`,
      `<h1>Create your ${escapeHtml(this.appName)} account</h1>
<p class="muted"><strong>${escapeHtml(p.client_name)}</strong> works with the files in a ${escapeHtml(this.appName)} library. Create an account to continue; we will email you a link to verify your address.</p>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
${this.google ? `<a class="btn google" href="/oauth/google/start?p=${id}">Continue with Google</a><div class="or">or</div>` : ''}
<form method="post" action="/oauth/signup">
  <input type="hidden" name="p" value="${id}">
  <label>Email <input type="email" name="email" autocomplete="username" value="${escapeHtml(email ?? '')}" required autofocus></label>
  <label>Password <input type="password" name="password" autocomplete="new-password" minlength="8" required></label>
  <button class="btn primary" type="submit">Create account</button>
</form>
<p class="muted">Already have an account? <a href="/oauth/switch?p=${id}">Sign in</a></p>
${POLICY_LINKS}`,
    );
  }

  /** After signing up: the sign-in waits for the emailed link. */
  checkEmailPage(pendingId: string, email: string): string {
    const p = this.pending(pendingId);
    return page(
      'Check your email',
      `<h1>Check your email</h1>
<p>We sent a link to <strong>${escapeHtml(email)}</strong>. Open it in this browser within the hour to verify your address and continue connecting ${escapeHtml(p?.client_name ?? 'your app')}.</p>
<p class="muted">You can close this page. Nothing arrived? <a href="/oauth/signup?p=${escapeHtml(pendingId)}">Try again</a>.</p>`,
    );
  }

  /** The emailed link lands here. Verifying takes a click, so a mail scanner that opens links does not use up the token. */
  verifyPage(pendingId: string, token: string): string {
    return page(
      'Verify your email',
      `<h1>Verify your email</h1>
<p class="muted">Confirm your address to finish creating your ${escapeHtml(this.appName)} account and continue.</p>
<form method="post" action="/oauth/verify">
  <input type="hidden" name="p" value="${escapeHtml(pendingId)}">
  <input type="hidden" name="token" value="${escapeHtml(token)}">
  <button class="btn primary" type="submit">Verify and continue</button>
</form>`,
    );
  }

  consentPage(pendingId: string): string {
    const p = this.pending(pendingId);
    if (!p || !p.user_id) return this.errorPage('This sign-in link has expired. Start again from ChatGPT.');
    const who = this.profile(p.user_id);
    const id = escapeHtml(pendingId);
    // A device sign-in may have been started by someone else, who sent this person the address and code.
    const device = p.params.device
      ? `<p class="error">Only allow this if you started this sign-in yourself, from an agent you trust. The request came from ${escapeHtml(p.params.origin ?? 'an unknown address')}, and "${escapeHtml(p.client_name)}" is the name the agent gave itself.</p>`
      : '';
    const scopes = p.params.scope.split(' ').map((s) => `<li>${escapeHtml({ 'files:read': 'See the names of your files and read their contents: documents, presentations, spreadsheets, Markdown files, pictures and other stored files', 'files:write': 'Create, change, import and delete those files' }[s] ?? s)}</li>`).join('');
    return page(
      `Allow ${p.client_name}?`,
      `<h1>Allow ${escapeHtml(p.client_name)}?</h1>
<p class="muted">Signed in as <strong>${escapeHtml(who?.email ?? '')}</strong>. <a href="/oauth/switch?p=${id}">Not you?</a></p>
${device}
<p>${escapeHtml(p.client_name)} will be able to:</p>
<ul>${scopes}</ul>
<form method="post" action="/oauth/decision" class="row">
  <input type="hidden" name="p" value="${id}">
  <button class="btn" type="submit" name="allow" value="no">Deny</button>
  <button class="btn primary" type="submit" name="allow" value="yes">Allow</button>
</form>
<p class="muted">It will also see the email address of this account.${p.params.device ? '' : ' You can disconnect it in ChatGPT at any time.'}</p>
${POLICY_LINKS}`,
    );
  }

  /** Where the person enters the code an agent showed them. */
  devicePage(error?: string): string {
    return page(
      'Connect an agent',
      `<h1>Connect an agent to ${escapeHtml(this.appName)}</h1>
<p class="muted">Enter the code your agent showed you.</p>
<p><strong>Only enter a code from an agent you started yourself.</strong> Whoever started it will be able to read and change your files.</p>
${error ? `<p class="error">${escapeHtml(error)}</p>` : ''}
<form method="post" action="/oauth/device">
  <label>Code <input name="code" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="XXXX-XXXX" required autofocus></label>
  <button class="btn primary" type="submit">Continue</button>
</form>
${POLICY_LINKS}`,
    );
  }

  deviceDonePage(allowed: boolean): string {
    return allowed
      ? page('Agent connected', `<h1>Agent connected</h1><p>You can close this page and go back to your agent.</p>`)
      : page('Not connected', `<h1>Not connected</h1><p class="muted">You did not allow access, so the agent cannot use your files.</p>`);
  }

  errorPage(message: string): string {
    return page('Sign-in problem', `<h1>Sign-in problem</h1><p class="error">${escapeHtml(message)}</p>`);
  }
}

interface ClientDoc {
  client_id: string;
  redirect_uris: string[];
  client_name?: string;
}

function isAllowedRedirect(u: string): boolean {
  try {
    const url = new URL(u);
    return url.protocol === 'https:' || (url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1'));
  } catch {
    return false;
  }
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Whether the address a client asked to be sent back to is one it registered. An exact match, except for a
 * native app listening on this computer (http on a loopback host): it gets a free port when it starts, so it
 * registers the address without one and any port matches (RFC 8252, section 7.3). Claude Code does this.
 */
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

/** The app's privacy policy and terms, shown before anyone signs in or allows access (the app serves them). */
const POLICY_LINKS = '<p class="muted"><a href="/privacy" target="_blank" rel="noopener">Privacy Policy</a> · <a href="/terms" target="_blank" rel="noopener">Terms of Service</a></p>';

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>
<style>
body{margin:0;background:#f0f4f9;font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:#1f1f1f}
main{max-width:420px;margin:48px auto;background:#fff;border:1px solid #dadce0;border-radius:12px;padding:28px}
h1{font-size:22px;font-weight:500;margin:0 0 12px}.muted{color:#5f6368}.error{color:#d93025}
label{display:block;margin:12px 0 4px;font-weight:500}input{width:100%;box-sizing:border-box;padding:9px 10px;border:1px solid #dadce0;border-radius:8px;font:inherit}
.btn{display:inline-block;box-sizing:border-box;padding:9px 16px;border:1px solid #dadce0;border-radius:8px;background:#fff;font:inherit;cursor:pointer;text-decoration:none;color:inherit;text-align:center}
.btn.primary{background:#1a73e8;border-color:#1a73e8;color:#fff}.btn.google{width:100%}form .btn.primary{margin-top:16px;width:100%}
.or{text-align:center;color:#5f6368;margin:14px 0 2px}.row{display:flex;gap:10px;justify-content:flex-end;margin-top:16px}.row .btn{width:auto}
</style></head><body><main>${body}</main></body></html>`;
}
