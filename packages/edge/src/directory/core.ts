// Identity: accounts, sessions and sign-in. Ported from packages/server/src/services/auth.ts and oauthAccounts.ts, with
// the same rules and the same mail. It runs over any `SqlStorage`-shaped database, so tests can use node:sqlite.
import type { AuthResponse, OAuthIdentityDTO, RegisterResponse, UserDTO } from '@flow/shared';
import { ApiError, conflict, notFound, unauthorized } from '../errors';
import { hashPassword, verifyPassword } from './passwords';
import { DIRECTORY_MIGRATIONS } from './schema';
import { HandoffApprove, HandoffExchange, HandoffStart, parseBody, pkceChallenge, validateContext, type HandoffContext, type HandoffPolicy } from './authHandoff';

export interface Sql {
  exec(query: string, ...bindings: unknown[]): { toArray(): Record<string, unknown>[] };
}

export interface Mail { to: string; subject: string; text: string }

export interface DirectoryDeps {
  webUrlBase: string;
  registrationEnabled: boolean;
  send(mail: Mail): Promise<void>;
  /** FLOW_HANDOFF_RETURN_URLS and FLOW_ALLOWED_WEB_ORIGINS, for the web-to-app handoff. Without return URLs it is off. */
  handoffReturnUrls?: string[];
  allowedWebOrigins?: string[];
}

export type AuthKind = 'session' | 'agent';
export type OAuthProvider = 'google' | 'apple';
export interface OAuthProfile { provider: OAuthProvider; sub: string; email: string; hostedDomain: string | null; name?: string | undefined }

const DAY = 86_400_000;
const SESSION_TTL_DAYS = 30;
const VERIFY_TTL_HOURS = 48;
const RESET_TTL_MINUTES = 60;
const SIGNIN_TTL_MINUTES = 15;
const APP_LINK_TTL = 2 * 60_000;
const DESKTOP_HANDOFF_TTL = 10 * 60_000;
const AGENT_TOUCH = 60_000;
const HANDOFF_TTL = 10 * 60_000;
const HANDOFF_CODE_TTL = 60_000;
const HANDOFF_RATE_WINDOW = 10 * 60_000;

type Row = Record<string, unknown>;

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return Buffer.from(digest).toString('hex');
}
export const newToken = () => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');

/** A UUIDv7, the id format the server already uses. */
export function newId(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  const now = Date.now();
  for (let i = 0; i < 6; i++) b[i] = Math.floor(now / 2 ** (8 * (5 - i))) & 0xff;
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = Buffer.from(b).toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const iso = (ms: unknown) => new Date(ms as number).toISOString();

/** A privacy-mode address goes out as '': the native clients decode `email` as a non-optional string. */
export function toUserDTO(u: Row, viewerId?: string): UserDTO {
  return {
    id: u.id as string,
    email: u.privacy_mode && u.id !== viewerId ? '' : (u.email as string),
    privacyMode: !!u.privacy_mode,
    displayName: u.display_name as string,
    avatarUrl: (u.avatar_url as string | null) ?? null,
    timezone: u.timezone as string,
    statusEmoji: u.status_emoji as string,
    statusText: u.status_text as string,
    website: u.website as string,
    bio: u.bio as string,
    title: u.title as string,
    isAgent: !!u.is_agent,
    sponsorId: u.is_agent ? ((u.sponsor_user_id as string | null) ?? null) : null,
    notificationPrefs: JSON.parse(u.notification_prefs as string),
    statusSuppressAlerts: !!u.status_suppress_alerts,
    createdAt: iso(u.created_at),
  } as UserDTO;
}

export class DirectoryCore {
  constructor(private readonly sql: Sql, private readonly deps: DirectoryDeps) {
    this.sql.exec('CREATE TABLE IF NOT EXISTS _migrations (n INTEGER PRIMARY KEY)');
    const done = (this.sql.exec('SELECT COALESCE(MAX(n), -1) AS n FROM _migrations').toArray()[0]!.n as number) + 1;
    DIRECTORY_MIGRATIONS.slice(done).forEach((m, i) => {
      this.sql.exec(m);
      this.sql.exec('INSERT INTO _migrations (n) VALUES (?)', done + i);
    });
  }

  private rows(query: string, ...args: unknown[]): Row[] {
    return this.sql.exec(query, ...args).toArray();
  }
  private userById(id: string): Row | undefined {
    return this.rows('SELECT * FROM users WHERE id = ?', id)[0];
  }
  private userByEmail(email: string): Row | undefined {
    return this.rows('SELECT * FROM users WHERE email = ?', email)[0];
  }
  private insertUser(v: { email: string; passwordHash: string; displayName: string }): Row | undefined {
    const now = Date.now();
    return this.rows(
      `INSERT INTO users (id, email, password_hash, display_name, email_verified_at, created_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (email) DO NOTHING RETURNING *`,
      newId(), v.email, v.passwordHash, v.displayName, now, now,
    )[0];
  }

  /** Every sign-in path ends here, so they all yield the same session. */
  async issueSession(userId: string, clientInfo?: string): Promise<string> {
    const token = newToken();
    const now = Date.now();
    this.sql.exec('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, client_info) VALUES (?, ?, ?, ?, ?)',
      await hashToken(token), userId, now, now + SESSION_TTL_DAYS * DAY, clientInfo ?? null);
    return token;
  }

  private async mintEmailToken(userId: string, purpose: string, ttl: number): Promise<string> {
    const now = Date.now();
    this.sql.exec('DELETE FROM email_tokens WHERE expires_at < ?', now);
    this.sql.exec('DELETE FROM email_tokens WHERE user_id = ? AND purpose = ?', userId, purpose);
    const token = newToken();
    this.sql.exec('INSERT INTO email_tokens (token_hash, user_id, purpose, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
      await hashToken(token), userId, purpose, now, now + ttl);
    return token;
  }

  private async consumeEmailToken(token: string, purpose: string): Promise<Row | undefined> {
    const used = this.rows('DELETE FROM email_tokens WHERE token_hash = ? AND purpose = ? AND expires_at > ? RETURNING user_id',
      await hashToken(token), purpose, Date.now())[0];
    return used ? this.userById(used.user_id as string) : undefined;
  }

  async register(email: string): Promise<RegisterResponse> {
    if (!this.deps.registrationEnabled) throw new ApiError(403, 'registration_disabled', 'Account registration is disabled on this server');
    const existing = this.userByEmail(email);
    if (existing && !existing.is_bot) {
      await this.deps.send({
        to: email,
        subject: 'You already have a Flow account',
        text: `Hi ${existing.display_name},\n\nSomeone (hopefully you) tried to create a Flow account with this address, but it already has one. You can sign in here:\n\n${this.deps.webUrlBase}/\n\nForgot your password? Use "Forgot password?" on the sign-in screen.\n`,
      });
    } else if (!existing) {
      const now = Date.now();
      this.sql.exec('DELETE FROM pending_signups WHERE expires_at < ?', now);
      this.sql.exec('DELETE FROM pending_signups WHERE email = ?', email);
      const token = newToken();
      this.sql.exec('INSERT INTO pending_signups (token_hash, email, created_at, expires_at) VALUES (?, ?, ?, ?)',
        await hashToken(token), email, now, now + VERIFY_TTL_HOURS * 3_600_000);
      await this.deps.send({
        to: email,
        subject: 'Finish creating your Flow account',
        text: `Welcome to Flow!\n\nConfirm your email address and finish setting up your account:\n\n${this.deps.webUrlBase}/?signup=${token}\n\nThis link expires in ${VERIFY_TTL_HOURS} hours. If you didn't request a Flow account, you can ignore this email.\n`,
      });
    }
    return { requiresVerification: true, email };
  }

  async completeSignup(token: string, displayName: string, password: string, clientInfo?: string): Promise<AuthResponse> {
    if (!this.deps.registrationEnabled) throw new ApiError(403, 'registration_disabled', 'Account registration is disabled on this server');
    const used = this.rows('DELETE FROM pending_signups WHERE token_hash = ? AND expires_at > ? RETURNING email', await hashToken(token), Date.now())[0];
    if (!used) throw unauthorized('invalid or expired signup link');
    const user = this.insertUser({ email: used.email as string, passwordHash: hashPassword(password), displayName });
    if (!user) throw conflict('email_taken', 'an account with this email already exists');
    return { token: await this.issueSession(user.id as string, clientInfo), user: toUserDTO(user, user.id as string) };
  }

  async login(email: string, password: string, clientInfo?: string): Promise<AuthResponse> {
    const user = this.userByEmail(email);
    if (!user || !(await verifyPassword(user.password_hash as string, password))) throw unauthorized('invalid email or password');
    if ((user.password_hash as string).startsWith('scrypt$')) this.sql.exec('UPDATE users SET password_hash = ? WHERE id = ?', hashPassword(password), user.id);
    if (!user.email_verified_at && !user.is_bot) {
      throw new ApiError(403, 'email_not_verified', 'this email is unverified — use "Forgot password?" to verify it');
    }
    return { token: await this.issueSession(user.id as string, clientInfo), user: toUserDTO(user, user.id as string) };
  }

  async forgotPassword(email: string): Promise<void> {
    const user = this.userByEmail(email);
    if (!user || user.is_bot) return;
    const token = await this.mintEmailToken(user.id as string, 'password_reset', RESET_TTL_MINUTES * 60_000);
    await this.deps.send({
      to: user.email as string,
      subject: 'Reset your Flow password',
      text: `Hi ${user.display_name},\n\nSomeone (hopefully you) asked to reset the password for this Flow account.\n\n${this.deps.webUrlBase}/?reset=${token}\n\nThis link expires in ${RESET_TTL_MINUTES} minutes and can be used once. If you didn't ask for this, you can ignore this email — your password is unchanged.\n`,
    });
  }

  /** Sets the password, ends every existing session and signs in fresh. The link proves the address, so it verifies too. */
  async resetPassword(token: string, password: string, clientInfo?: string): Promise<AuthResponse> {
    const user = await this.consumeEmailToken(token, 'password_reset');
    if (!user) throw unauthorized('invalid or expired reset link');
    this.sql.exec('UPDATE users SET password_hash = ?, email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?', hashPassword(password), Date.now(), user.id);
    this.sql.exec('DELETE FROM sessions WHERE user_id = ?', user.id);
    return { token: await this.issueSession(user.id as string, clientInfo), user: toUserDTO(user, user.id as string) };
  }

  async sendSigninLink(email: string): Promise<void> {
    const user = this.userByEmail(email);
    if (!user || user.is_bot) return;
    const token = await this.mintEmailToken(user.id as string, 'signin', SIGNIN_TTL_MINUTES * 60_000);
    await this.deps.send({
      to: user.email as string,
      subject: 'Your Flow sign-in link',
      text: `Hi ${user.display_name},\n\nSomeone (hopefully you) asked to sign in to Flow with this email.\n\n${this.deps.webUrlBase}/?signin=${token}\n\nThis link expires in ${SIGNIN_TTL_MINUTES} minutes and can be used once. If you didn't ask for this, you can ignore this email — no one can sign in without it.\n`,
    });
  }

  async consumeSigninLink(token: string, clientInfo?: string): Promise<AuthResponse> {
    const user = await this.consumeEmailToken(token, 'signin');
    if (!user) throw unauthorized('invalid or expired sign-in link');
    if (!user.email_verified_at) this.sql.exec('UPDATE users SET email_verified_at = ? WHERE id = ?', Date.now(), user.id);
    return { token: await this.issueSession(user.id as string, clientInfo), user: toUserDTO(user, user.id as string) };
  }

  async logout(token: string): Promise<void> {
    this.sql.exec('DELETE FROM sessions WHERE token_hash = ?', await hashToken(token));
  }

  /** Sessions first, with a sliding expiry written at most daily; then agent tokens, which do not expire but can be revoked. */
  async authenticate(token: string): Promise<{ user: UserDTO; kind: AuthKind }> {
    const hash = await hashToken(token);
    const now = Date.now();
    const session = this.rows('SELECT user_id, expires_at FROM sessions WHERE token_hash = ? AND expires_at > ?', hash, now)[0];
    if (session) {
      const user = this.userById(session.user_id as string);
      if (!user || user.deleted_at) throw unauthorized();
      if ((session.expires_at as number) < now + (SESSION_TTL_DAYS - 1) * DAY) {
        this.sql.exec('UPDATE sessions SET expires_at = ? WHERE token_hash = ?', now + SESSION_TTL_DAYS * DAY, hash);
      }
      return { user: toUserDTO(user, user.id as string), kind: 'session' };
    }
    const agent = this.rows('SELECT user_id, last_used_at FROM agent_tokens WHERE token_hash = ? AND revoked_at IS NULL', hash)[0];
    const user = agent && this.userById(agent.user_id as string);
    if (!agent || !user) throw unauthorized();
    if (!agent.last_used_at || now - (agent.last_used_at as number) > AGENT_TOUCH) {
      this.sql.exec('UPDATE agent_tokens SET last_used_at = ? WHERE token_hash = ?', now, hash);
    }
    return { user: toUserDTO(user, user.id as string), kind: 'agent' };
  }

  async createAppLink(userId: string): Promise<{ code: string; expiresAt: string }> {
    const now = Date.now();
    this.sql.exec('DELETE FROM app_link_codes WHERE expires_at < ?', now);
    const code = newToken();
    this.sql.exec('INSERT INTO app_link_codes (code_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)', await hashToken(code), userId, now, now + APP_LINK_TTL);
    return { code, expiresAt: iso(now + APP_LINK_TTL) };
  }

  async exchangeAppLink(code: string, clientInfo?: string): Promise<AuthResponse> {
    const used = this.rows('DELETE FROM app_link_codes WHERE code_hash = ? AND expires_at > ? RETURNING user_id', await hashToken(code), Date.now())[0];
    const user = used && this.userById(used.user_id as string);
    if (!user) throw unauthorized('invalid or expired app link code');
    return { token: await this.issueSession(user.id as string, clientInfo), user: toUserDTO(user, user.id as string) };
  }

  /**
   * The MCP Docs desktop app's sign-in (routes/handoff.ts): the person, signed in in their browser, approves the key
   * the app made; the app, asking after it, trades it once for a session of its own.
   */
  async approveDesktopHandoff(key: string, userId: string): Promise<void> {
    const now = Date.now();
    this.sql.exec('DELETE FROM desktop_handoffs WHERE expires_at < ?', now);
    this.sql.exec('INSERT OR REPLACE INTO desktop_handoffs (key_hash, user_id, expires_at) VALUES (?, ?, ?)', await hashToken(key), userId, now + DESKTOP_HANDOFF_TTL);
  }

  async desktopHandoffReady(key: string): Promise<boolean> {
    return this.rows('SELECT 1 FROM desktop_handoffs WHERE key_hash = ? AND expires_at > ?', await hashToken(key), Date.now()).length > 0;
  }

  async exchangeDesktopHandoff(key: string, clientInfo?: string): Promise<string> {
    const used = this.rows('DELETE FROM desktop_handoffs WHERE key_hash = ? AND expires_at > ? RETURNING user_id', await hashToken(key), Date.now())[0];
    const user = used && this.userById(used.user_id as string);
    if (!user || user.deleted_at) throw unauthorized('invalid or expired sign-in key');
    return this.issueSession(user.id as string, clientInfo);
  }

  /** The server's `rateAllowDb`: a fixed window per key. True when the call is allowed. */
  private rateAllow(key: string, limit: number, windowMs: number): boolean {
    const now = Date.now();
    const count = this.rows(
      `INSERT INTO rate_limit_windows (key, window_start, count) VALUES (?, ?, 1)
       ON CONFLICT (key) DO UPDATE SET
         count = CASE WHEN window_start <= ? THEN 1 ELSE count + 1 END,
         window_start = CASE WHEN window_start <= ? THEN ? ELSE window_start END
       RETURNING count`,
      key, now, now - windowMs, now - windowMs, now)[0]?.count as number | undefined;
    return count === undefined || count <= limit;
  }

  private handoffPolicy(): HandoffPolicy {
    return { webUrlBase: this.deps.webUrlBase, returnUrls: this.deps.handoffReturnUrls ?? [], allowedWebOrigins: this.deps.allowedWebOrigins ?? [] };
  }

  /** The row an approval or exchange names: every part of the context it started with, unexpired. */
  private handoffBinding(body: HandoffContext, requestHash: string): [string, unknown[]] {
    const client = body.clientOrigin === null ? [] : [body.clientOrigin];
    return [
      `request_hash = ? AND connection_id = ? AND operation_id = ? AND state = ? AND server_origin = ? AND
       ${body.clientOrigin === null ? 'client_origin IS NULL' : 'client_origin = ?'} AND return_url = ? AND expires_at > ?`,
      [requestHash, body.connectionId, body.operationId, body.state, body.serverOrigin, ...client, body.returnUrl, Date.now()],
    ];
  }

  /**
   * The web-to-app sign-in handoff (authHandoff.ts), the server's services/handoff.ts. A client with no session starts
   * an operation with its PKCE challenge; `origin` is the request's Origin header and `ip` the caller's address.
   */
  async startHandoff(raw: unknown, origin: string | undefined, ip: string): Promise<{ requestId: string; expiresAt: string }> {
    if (!this.rateAllow(`handoff-start:${ip}`, 30, HANDOFF_RATE_WINDOW)) throw new ApiError(429, 'rate_limited', 'Too many handoff attempts');
    const body = parseBody(HandoffStart, raw);
    validateContext(body, origin, true, this.handoffPolicy());
    const now = Date.now();
    this.sql.exec('DELETE FROM auth_handoffs WHERE expires_at < ?', now);
    this.sql.exec('DELETE FROM rate_limit_windows WHERE window_start < ?', now - DAY);
    const requestId = newToken();
    const expiresAt = now + HANDOFF_TTL;
    this.sql.exec(
      `INSERT INTO auth_handoffs (request_hash, connection_id, operation_id, state, server_origin, client_origin, return_url, code_challenge, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      await hashToken(requestId), body.connectionId, body.operationId, body.state, body.serverOrigin, body.clientOrigin, body.returnUrl, body.codeChallenge, expiresAt);
    return { requestId, expiresAt: iso(expiresAt) };
  }

  /** The person, signed in on the web, approves it: a one-minute code, sent back to the client in its return URL. */
  async approveHandoff(userId: string, raw: unknown): Promise<{ callbackUrl: string; expiresAt: string }> {
    const body = parseBody(HandoffApprove, raw);
    validateContext(body, undefined, false, this.handoffPolicy());
    const code = newToken();
    const codeHash = await hashToken(code);
    const [where, args] = this.handoffBinding(body, await hashToken(body.requestId));
    const expiresAt = Date.now() + HANDOFF_CODE_TTL;
    const row = this.rows(`UPDATE auth_handoffs SET user_id = ?, code_hash = ?, expires_at = ? WHERE ${where} AND code_hash IS NULL RETURNING *`,
      userId, codeHash, expiresAt, ...args)[0];
    if (!row) throw unauthorized('Unknown, expired, or already approved handoff operation');
    const callback = new URL(row.return_url as string);
    // No backend URL or session credential in the callback. The client resolves its pending operation.
    callback.searchParams.set('code', code);
    callback.searchParams.set('state', row.state as string);
    callback.searchParams.set('operationId', row.operation_id as string);
    return { callbackUrl: callback.href, expiresAt: iso(expiresAt) };
  }

  /** The client trades the code and its PKCE verifier, once, for a session of the person who approved. */
  async exchangeHandoff(raw: unknown, origin: string | undefined, ip: string, clientInfo?: string): Promise<AuthResponse> {
    if (!this.rateAllow(`handoff-exchange:${ip}`, 60, HANDOFF_RATE_WINDOW)) throw new ApiError(429, 'rate_limited', 'Too many handoff attempts');
    const body = parseBody(HandoffExchange, raw);
    validateContext(body, origin, true, this.handoffPolicy());
    const [where, args] = this.handoffBinding(body, await hashToken(body.requestId));
    const codeHash = await hashToken(body.code);
    const challenge = await pkceChallenge(body.codeVerifier);
    // Found, checked and used up with no await between: as the server's transaction, a refused person leaves the row.
    const row = this.rows(`SELECT * FROM auth_handoffs WHERE ${where} AND code_hash = ? AND code_challenge = ?`, ...args, codeHash, challenge)[0];
    if (!row?.user_id) throw unauthorized('Invalid, expired, or mismatched handoff');
    const user = this.userById(row.user_id as string);
    if (!user || user.deleted_at || user.is_bot || user.is_agent) throw unauthorized();
    this.sql.exec('DELETE FROM auth_handoffs WHERE request_hash = ?', row.request_hash);
    return { token: await this.issueSession(user.id as string, clientInfo), user: toUserDTO(user, user.id as string) };
  }

  /** Match by (provider, sub), then by verified email, else create a provider-first account. */
  resolveOAuthUser(p: OAuthProfile): string {
    const known = this.rows('SELECT user_id FROM oauth_identities WHERE provider = ? AND provider_subject = ?', p.provider, p.sub)[0];
    if (known) {
      this.sql.exec('UPDATE oauth_identities SET email = ?, hosted_domain = ? WHERE provider = ? AND provider_subject = ?', p.email, p.hostedDomain, p.provider, p.sub);
      return known.user_id as string;
    }
    const link = (userId: string) => this.sql.exec(
      'INSERT INTO oauth_identities (provider, provider_subject, user_id, email, hosted_domain, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      p.provider, p.sub, userId, p.email, p.hostedDomain, Date.now());
    const existing = this.userByEmail(p.email);
    if (existing) {
      if (existing.is_bot || existing.is_agent) throw conflict('email_reserved', 'that email belongs to a bot or agent account');
      if (existing.deleted_at) throw conflict('email_reserved', 'that account has been removed');
      link(existing.id as string);
      if (!existing.email_verified_at) this.sql.exec('UPDATE users SET email_verified_at = ? WHERE id = ?', Date.now(), existing.id);
      return existing.id as string;
    }
    if (!this.deps.registrationEnabled) throw new ApiError(403, 'registration_disabled', 'Account registration is disabled on this server');
    const user = this.insertUser({ email: p.email, passwordHash: `!${p.provider}:${newToken()}`, displayName: p.name?.trim() || p.email.split('@')[0]! });
    if (!user) throw conflict('email_taken', 'an account with this email already exists');
    link(user.id as string);
    return user.id as string;
  }

  async signInWithOAuth(p: OAuthProfile, clientInfo?: string): Promise<AuthResponse> {
    const userId = this.resolveOAuthUser(p);
    const user = this.userById(userId);
    if (!user) throw new ApiError(500, 'internal', 'user vanished during sign-in');
    return { token: await this.issueSession(userId, clientInfo), user: toUserDTO(user, userId) };
  }

  listIdentities(userId: string): OAuthIdentityDTO[] {
    return this.rows('SELECT * FROM oauth_identities WHERE user_id = ?', userId).map((r) => ({
      provider: r.provider as OAuthProvider,
      email: r.email as string,
      hostedDomain: (r.hosted_domain as string | null) ?? null,
      linkedAt: iso(r.created_at),
    })) as OAuthIdentityDTO[];
  }

  /** New ids and membership changes, reported by an organization's object (org/object.ts). Safe to apply twice. */
  async applyOrgChanges(organizationId: string, changes: { kind: string; id: string; user_id: string | null; role: string | null; payload: string | null }[]): Promise<void> {
    for (const c of changes) {
      if (c.kind === 'agent_user') {
        const a = JSON.parse(c.payload!) as { username: string | null; keyHash: string | null; passwordHash: string; email: string; displayName: string; sponsorId: string | null; createdAt: number };
        this.sql.exec(
          `INSERT INTO users (id, email, password_hash, display_name, is_agent, sponsor_user_id, agent_username, agent_key_hash, email_verified_at, created_at)
           VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE SET display_name = excluded.display_name, agent_username = excluded.agent_username, agent_key_hash = excluded.agent_key_hash`,
          c.id, a.email, a.passwordHash, a.displayName, a.sponsorId, a.username, a.keyHash, a.createdAt, a.createdAt);
      } else if (c.kind === 'agent_token') {
        this.sql.exec('INSERT OR IGNORE INTO agent_tokens (id, token_hash, user_id, created_at) VALUES (?, ?, ?, ?)', c.id, c.payload, c.user_id, Date.now());
      } else if (c.kind === 'agent_revoke') {
        this.sql.exec('UPDATE agent_tokens SET revoked_at = ? WHERE id = ?', Date.now(), c.id);
      } else if (c.kind === 'domain') {
        if (c.payload) this.sql.exec('INSERT OR REPLACE INTO organization_domains (organization_id, domain) VALUES (?, ?)', organizationId, c.payload);
        else this.sql.exec('DELETE FROM organization_domains WHERE organization_id = ?', organizationId);
      } else if (c.kind === 'token') this.sql.exec('INSERT OR IGNORE INTO id_index (id, organization_id) VALUES (?, ?)', await hashToken(c.id), organizationId);
      else if (c.kind === 'index') this.sql.exec('INSERT OR IGNORE INTO id_index (id, organization_id) VALUES (?, ?)', c.id, organizationId);
      else if (c.kind === 'join') this.sql.exec('INSERT OR REPLACE INTO memberships (user_id, organization_id, role) VALUES (?, ?, ?)', c.user_id, organizationId, c.role);
      else if (c.kind === 'leave') this.sql.exec('DELETE FROM memberships WHERE user_id = ? AND organization_id = ?', c.user_id, organizationId);
    }
  }

  /** A workspace's slug is unique across every organization, which no single object can check. */
  reserveSlug(slug: string, organizationId: string): void {
    const taken = this.rows('INSERT INTO organization_slugs (slug, organization_id) VALUES (?, ?) ON CONFLICT (slug) DO NOTHING RETURNING slug', slug, organizationId);
    if (!taken.length) throw conflict('slug_taken', 'that URL is already taken');
  }

  releaseSlug(slug: string, organizationId: string): void {
    this.sql.exec('DELETE FROM organization_slugs WHERE slug = ? AND organization_id = ?', slug, organizationId);
  }

  /** The one place a person's profile is written. The Worker then copies it to their organizations. */
  patchUser(userId: string, patch: Record<string, unknown>): UserDTO {
    const user = this.userById(userId);
    if (!user) throw notFound('user not found');
    const columns: Record<string, string> = {
      displayName: 'display_name', timezone: 'timezone', statusEmoji: 'status_emoji', statusText: 'status_text', website: 'website',
      bio: 'bio', title: 'title', statusSuppressAlerts: 'status_suppress_alerts', unfurlOwnLinks: 'unfurl_own_links', privacyMode: 'privacy_mode', avatarUrl: 'avatar_url',
    };
    for (const [key, column] of Object.entries(columns)) {
      const value = patch[key];
      if (value !== undefined) this.sql.exec(`UPDATE users SET ${column} = ? WHERE id = ?`, typeof value === 'boolean' ? Number(value) : value, userId);
    }
    if (patch.notificationPrefs !== undefined) {
      this.sql.exec('UPDATE users SET notification_prefs = json_patch(notification_prefs, ?) WHERE id = ?', JSON.stringify(patch.notificationPrefs), userId);
    }
    return toUserDTO(this.userById(userId)!, userId);
  }

  /** Username and key to a fresh token, which ends every earlier one. The "lost agent.json" path. */
  async agentLogin(username: string, key: string): Promise<{ agentToken: string; user: UserDTO }> {
    for (const user of this.rows('SELECT * FROM users WHERE agent_username = ? AND is_agent = 1', username)) {
      if (!user.agent_key_hash || !(await verifyPassword(user.agent_key_hash as string, key))) continue;
      const now = Date.now();
      this.sql.exec('UPDATE agent_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', now, user.id);
      const agentToken = `flow-agent-token-${newToken()}`;
      this.sql.exec('INSERT INTO agent_tokens (id, token_hash, user_id, created_at) VALUES (?, ?, ?, ?)', newId(), await hashToken(agentToken), user.id, now);
      return { agentToken, user: toUserDTO(user, user.id as string) };
    }
    throw unauthorized('invalid agent credentials');
  }

  organizationsForDomain(domain: string): string[] {
    return this.rows('SELECT organization_id FROM organization_domains WHERE domain = ?', domain).map((r) => r.organization_id as string);
  }

  /** The directory's half of deleting an account. The row stays for authorship; the address is freed. */
  tombstoneUser(userId: string): void {
    this.sql.exec('DELETE FROM sessions WHERE user_id = ?', userId);
    this.sql.exec('DELETE FROM oauth_identities WHERE user_id = ?', userId);
    this.sql.exec('DELETE FROM memberships WHERE user_id = ?', userId);
    this.sql.exec("UPDATE users SET deleted_at = ?, email = 'deleted-' || id || '@deleted.invalid', password_hash = '!deleted', display_name = 'Deleted user', avatar_url = NULL WHERE id = ?", Date.now(), userId);
  }

  organizationsOf(userId: string): string[] {
    return this.rows('SELECT organization_id FROM memberships WHERE user_id = ?', userId).map((r) => r.organization_id as string);
  }

  organizationOfId(id: string): string | null {
    return (this.rows('SELECT organization_id FROM id_index WHERE id = ?', id)[0]?.organization_id as string | undefined) ?? null;
  }

  getUser(id: string, viewerId: string): UserDTO {
    const user = this.userById(id);
    if (!user) throw notFound('user not found');
    if (id !== viewerId) {
      const shared = this.rows('SELECT 1 FROM memberships a JOIN memberships b ON a.organization_id = b.organization_id WHERE a.user_id = ? AND b.user_id = ? LIMIT 1', id, viewerId);
      if (!shared.length) throw notFound('user not found');
    }
    return toUserDTO(user, viewerId);
  }
}
