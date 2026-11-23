// Signing a hosted app's users in to other services by OAuth (docs/specs/user-apps.md §6.5). These functions run inside
// the Org object's database scope (withDb). The suite runs the whole sign-in: it keeps the app's client secret (set by an
// owner or admin, or by a draft's author for its dev install), sends the person to the provider with a one-use state and
// PKCE, takes the code at one callback on the suite's own origin, and keeps each person's token, encrypted. The app's code
// never sees the client secret; it asks for its caller's token by the provider's id.
import { and, eq, lt } from 'drizzle-orm';
import { createHash, randomBytes } from 'node:crypto';
import type { AppOAuthProvider, UserAppManifest } from '@flow/shared';
import { db, schema } from '../db/index.js';
import { decryptBody, encryptBody } from '../crypto/index.js';
import { badRequest } from '../../errors';

const { userAppOAuthClients, userAppOAuthStates, userAppOAuthTokens } = schema;

/** How long a sign-in may take, from the start to the callback. */
export const OAUTH_STATE_MS = 10 * 60_000;
/** The callback's path on the suite's origin: the one address every app's OAuth client registers. */
export const OAUTH_CALLBACK_PATH = '/v1/apps/oauth/callback';
/** A token this close to its end is refreshed before it is handed out. */
const REFRESH_EARLY_MS = 60_000;
/** The longest wait for a provider's token endpoint. */
const TOKEN_TIMEOUT_MS = 15_000;

/** The install is `''`; a dev install is its author's account (§9.3). */
export type AppInstall = { name: string; dev: string };

/** The callback address for a suite served from `webBase`. */
export const oauthCallbackUrl = (webBase: string): string => `${webBase.replace(/\/+$/, '')}${OAUTH_CALLBACK_PATH}`;

export function providerOf(manifest: UserAppManifest, id: string): AppOAuthProvider {
  const p = (manifest.oauth ?? []).find((o) => o.id === id);
  if (!p) throw badRequest('validation', `this app declares no OAuth provider "${id}" (manifest "oauth")`);
  return p;
}

const sha256 = (s: string): Buffer => createHash('sha256').update(s).digest();
const b64url = (b: Buffer): string => b.toString('base64url');

// ---- the client (id and secret) ----

export interface AppOAuthClientDTO { provider: string; label: string; clientId: string | null; set: boolean; inherited: boolean; updatedAt: number | null }

/**
 * Each provider the manifest declares, and whether its client is set. A dev install without its own client uses the
 * install's (`inherited`) when its provider is the same one (`sameProvider`).
 */
export async function listOAuthClients(at: AppInstall, manifest: UserAppManifest, installed: UserAppManifest | null): Promise<AppOAuthClientDTO[]> {
  const rows = await db.select().from(userAppOAuthClients).where(and(eq(userAppOAuthClients.name, at.name), eq(userAppOAuthClients.dev, at.dev)));
  const live = at.dev ? await db.select().from(userAppOAuthClients).where(and(eq(userAppOAuthClients.name, at.name), eq(userAppOAuthClients.dev, ''))) : [];
  return (manifest.oauth ?? []).map((p) => {
    const own = rows.find((r) => r.provider === p.id);
    const base = installed && sameProvider(installed, p) ? live.find((r) => r.provider === p.id) : undefined;
    const row = own ?? base;
    return { provider: p.id, label: p.label, clientId: row?.clientId ?? null, set: !!row, inherited: !own && !!base, updatedAt: row?.updatedAt ?? null };
  });
}

export async function setOAuthClient(at: AppInstall, manifest: UserAppManifest, p: { provider: string; clientId: string; clientSecret: string; by: string }): Promise<void> {
  providerOf(manifest, p.provider);
  const clientId = p.clientId.trim();
  const clientSecret = p.clientSecret.trim();
  if (!clientId || clientId.length > 500) throw badRequest('validation', 'the client id is 1-500 characters');
  if (!clientSecret || clientSecret.length > 2000) throw badRequest('validation', 'the client secret is 1-2000 characters');
  const enc = encryptBody(clientSecret);
  const cols = { clientId, secret: enc.body, secretNonce: enc.bodyNonce, encKeyId: enc.encKeyId, encScheme: enc.encScheme, updatedBy: p.by, updatedAt: Date.now() };
  await db
    .insert(userAppOAuthClients)
    .values({ name: at.name, dev: at.dev, provider: p.provider, ...cols })
    .onConflictDoUpdate({ target: [userAppOAuthClients.name, userAppOAuthClients.dev, userAppOAuthClients.provider], set: cols });
}

export async function deleteOAuthClient(at: AppInstall, provider: string): Promise<void> {
  await db.delete(userAppOAuthClients).where(and(eq(userAppOAuthClients.name, at.name), eq(userAppOAuthClients.dev, at.dev), eq(userAppOAuthClients.provider, provider)));
}

/** Whether a draft's provider is the install's: same id and the same two addresses, so the install's secret goes only where an admin approved. */
function sameProvider(installed: UserAppManifest, p: AppOAuthProvider): boolean {
  const i = (installed.oauth ?? []).find((o) => o.id === p.id);
  return !!i && i.authorizeUrl === p.authorizeUrl && i.tokenUrl === p.tokenUrl;
}

/** The client for a provider: the install's own; a dev install's own, or else the install's when the provider is the same. */
async function clientFor(at: AppInstall, p: AppOAuthProvider, installed: UserAppManifest | null): Promise<{ clientId: string; clientSecret: string }> {
  const find = async (dev: string) =>
    (await db.select().from(userAppOAuthClients).where(and(eq(userAppOAuthClients.name, at.name), eq(userAppOAuthClients.dev, dev), eq(userAppOAuthClients.provider, p.id))).limit(1))[0];
  const row = (await find(at.dev)) ?? (at.dev && installed && sameProvider(installed, p) ? await find('') : undefined);
  if (!row) {
    throw badRequest('oauth_not_set_up', at.dev
      ? `${p.label} sign-in is not set up for this draft: add its client id and secret on the Build page`
      : `${p.label} sign-in is not set up: an owner or admin adds its client id and secret in Admin › Apps`);
  }
  return { clientId: row.clientId, clientSecret: decryptBody({ body: row.secret, bodyNonce: row.secretNonce, encKeyId: row.encKeyId, encScheme: row.encScheme }) };
}

// ---- the sign-in ----

/**
 * Starts a sign-in for `accountId`: a one-use state (its organization in front, so the callback knows where to go) and a
 * PKCE verifier are kept; back comes the provider's address to open in a window.
 */
export async function beginOAuth(p: {
  at: AppInstall; organizationId: string; manifest: UserAppManifest; installed: UserAppManifest | null;
  provider: string; accountId: string; returnOrigin: string; redirectUri: string;
}): Promise<{ url: string }> {
  const provider = providerOf(p.manifest, p.provider);
  const client = await clientFor(p.at, provider, p.installed);
  await db.delete(userAppOAuthStates).where(lt(userAppOAuthStates.expiresAt, Date.now()));
  const state = `${p.organizationId}.${b64url(randomBytes(24))}`;
  const verifier = b64url(randomBytes(32));
  await db.insert(userAppOAuthStates).values({
    stateHash: sha256(state), name: p.at.name, dev: p.at.dev, provider: provider.id, accountId: p.accountId, verifier,
    returnOrigin: p.returnOrigin, expiresAt: Date.now() + OAUTH_STATE_MS,
  });
  const url = new URL(provider.authorizeUrl);
  // The manifest's own settings first; the ones the suite sets (checked at publish) always win.
  for (const [k, v] of Object.entries(provider.authorizeParams ?? {})) url.searchParams.set(k, v);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', client.clientId);
  url.searchParams.set('redirect_uri', p.redirectUri);
  url.searchParams.set('state', state);
  if (provider.scopes?.length) url.searchParams.set('scope', provider.scopes.join(' '));
  url.searchParams.set('code_challenge', b64url(sha256(verifier)));
  url.searchParams.set('code_challenge_method', 'S256');
  return { url: url.toString() };
}

/** The organization a state names, or null: the callback's first step, before any object is asked. */
export function organizationOfState(state: string): string | null {
  const m = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.[A-Za-z0-9_-]{32}$/.exec(state);
  return m ? m[1]! : null;
}

/** A sign-in's state, taken: it is deleted at once, so a state works once. Null when unknown or too old. */
export async function takeOAuthState(state: string): Promise<typeof userAppOAuthStates.$inferSelect | null> {
  const [row] = await db.select().from(userAppOAuthStates).where(eq(userAppOAuthStates.stateHash, sha256(state))).limit(1);
  if (!row) return null;
  await db.delete(userAppOAuthStates).where(eq(userAppOAuthStates.stateHash, row.stateHash));
  return row.expiresAt < Date.now() ? null : row;
}

interface TokenSet { accessToken: string; tokenType: string; refreshToken: string | null; scope: string | null; expiresAt: number | null }

/**
 * Asks the provider's token endpoint, with the client in the form body or, for `tokenAuth: "basic"`, in an HTTP Basic
 * header (RFC 6749 §2.3.1: each part form-encoded first). The answer is JSON, or form-encoded (GitHub's default).
 */
async function tokenRequest(p: AppOAuthProvider, client: { clientId: string; clientSecret: string }, form: Record<string, string>, fetcher: typeof fetch): Promise<TokenSet> {
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'user-agent': 'FreeFlow-Apps/1' };
  const body = new URLSearchParams(form);
  if (p.tokenAuth === 'basic') {
    const part = (t: string) => encodeURIComponent(t).replace(/%20/g, '+');
    headers.authorization = `Basic ${btoa(`${part(client.clientId)}:${part(client.clientSecret)}`)}`;
  } else {
    body.set('client_id', client.clientId);
    body.set('client_secret', client.clientSecret);
  }
  let res: Response;
  try {
    res = await fetcher(p.tokenUrl, {
      method: 'POST',
      headers,
      body: body.toString(),
      signal: AbortSignal.timeout(TOKEN_TIMEOUT_MS),
    });
  } catch (err) {
    throw badRequest('oauth_failed', `the provider could not be reached: ${(err as Error).message}`.slice(0, 300));
  }
  const text = (await res.text()).slice(0, 64_000);
  let o: Record<string, unknown> = {};
  try { o = JSON.parse(text) as Record<string, unknown>; } catch { o = Object.fromEntries(new URLSearchParams(text)); }
  if (typeof o.error === 'string') throw badRequest('oauth_failed', `the provider refused: ${o.error}${typeof o.error_description === 'string' ? ` (${o.error_description})` : ''}`.slice(0, 300));
  if (!res.ok || typeof o.access_token !== 'string' || !o.access_token) throw badRequest('oauth_failed', `the provider answered ${res.status} without a token`);
  const expiresIn = Number(o.expires_in);
  return {
    accessToken: o.access_token,
    tokenType: typeof o.token_type === 'string' ? o.token_type : 'bearer',
    refreshToken: typeof o.refresh_token === 'string' && o.refresh_token ? o.refresh_token : null,
    scope: typeof o.scope === 'string' ? o.scope : null,
    expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : null,
  };
}

async function keepToken(at: AppInstall, provider: string, accountId: string, t: TokenSet): Promise<void> {
  const enc = encryptBody(JSON.stringify({ accessToken: t.accessToken, tokenType: t.tokenType, refreshToken: t.refreshToken }));
  const cols = { body: enc.body, bodyNonce: enc.bodyNonce, encKeyId: enc.encKeyId, encScheme: enc.encScheme, scope: t.scope, expiresAt: t.expiresAt, updatedAt: Date.now() };
  await db
    .insert(userAppOAuthTokens)
    .values({ name: at.name, dev: at.dev, provider, accountId, ...cols })
    .onConflictDoUpdate({ target: [userAppOAuthTokens.name, userAppOAuthTokens.dev, userAppOAuthTokens.provider, userAppOAuthTokens.accountId], set: cols });
}

/** The callback's work: the code exchanged with the client secret and the verifier, the token kept for whoever started it. */
export async function finishOAuth(p: {
  state: typeof userAppOAuthStates.$inferSelect; code: string; manifest: UserAppManifest; installed: UserAppManifest | null; redirectUri: string; fetcher?: typeof fetch;
}): Promise<{ provider: AppOAuthProvider }> {
  const at = { name: p.state.name, dev: p.state.dev };
  const provider = providerOf(p.manifest, p.state.provider);
  const client = await clientFor(at, provider, p.installed);
  const t = await tokenRequest(provider, client, {
    grant_type: 'authorization_code', code: p.code, redirect_uri: p.redirectUri, code_verifier: p.state.verifier,
  }, p.fetcher ?? fetch);
  await keepToken(at, provider.id, p.state.accountId, t);
  return { provider };
}

// ---- the app's side: the caller's connection ----

export interface AppOAuthStatus { provider: string; label: string; connected: boolean; scope: string | null; expiresAt: number | null }

export async function oauthStatus(at: AppInstall, manifest: UserAppManifest, provider: string, accountId: string): Promise<AppOAuthStatus> {
  const p = providerOf(manifest, provider);
  const [row] = await db.select().from(userAppOAuthTokens).where(tokenKey(at, p.id, accountId)).limit(1);
  return { provider: p.id, label: p.label, connected: !!row, scope: row?.scope ?? null, expiresAt: row?.expiresAt ?? null };
}

const tokenKey = (at: AppInstall, provider: string, accountId: string) =>
  and(eq(userAppOAuthTokens.name, at.name), eq(userAppOAuthTokens.dev, at.dev), eq(userAppOAuthTokens.provider, provider), eq(userAppOAuthTokens.accountId, accountId));

export interface AppOAuthToken { accessToken: string; tokenType: string; scope: string | null; expiresAt: number | null }

/**
 * The caller's token, or null when they have not signed in. One that has run out is refreshed first when the provider gave
 * a refresh token; when that fails, the connection is dropped and null comes back, so the app asks them to sign in again.
 */
export async function oauthToken(at: AppInstall, manifest: UserAppManifest, installed: UserAppManifest | null, provider: string, accountId: string, fetcher: typeof fetch = fetch): Promise<AppOAuthToken | null> {
  const p = providerOf(manifest, provider);
  const [row] = await db.select().from(userAppOAuthTokens).where(tokenKey(at, p.id, accountId)).limit(1);
  if (!row) return null;
  const kept = JSON.parse(decryptBody({ body: row.body, bodyNonce: row.bodyNonce, encKeyId: row.encKeyId, encScheme: row.encScheme })) as { accessToken: string; tokenType: string; refreshToken: string | null };
  if (row.expiresAt === null || row.expiresAt - REFRESH_EARLY_MS > Date.now()) {
    return { accessToken: kept.accessToken, tokenType: kept.tokenType, scope: row.scope, expiresAt: row.expiresAt };
  }
  if (kept.refreshToken) {
    try {
      const client = await clientFor(at, p, installed);
      const t = await tokenRequest(p, client, { grant_type: 'refresh_token', refresh_token: kept.refreshToken }, fetcher);
      const next = { ...t, refreshToken: t.refreshToken ?? kept.refreshToken, scope: t.scope ?? row.scope };
      await keepToken(at, p.id, accountId, next);
      return { accessToken: next.accessToken, tokenType: next.tokenType, scope: next.scope, expiresAt: next.expiresAt };
    } catch (err) {
      console.error(`[apps] oauth refresh ${at.name}/${p.id}: ${(err as Error).message}`);
    }
  }
  await db.delete(userAppOAuthTokens).where(tokenKey(at, p.id, accountId));
  return null;
}

export async function oauthDisconnect(at: AppInstall, manifest: UserAppManifest, provider: string, accountId: string): Promise<void> {
  const p = providerOf(manifest, provider);
  await db.delete(userAppOAuthTokens).where(tokenKey(at, p.id, accountId));
}

/** Everything an install (or a dev install) kept: removing the app, or deleting the draft. */
export async function removeAppOAuth(at: AppInstall): Promise<void> {
  for (const t of [userAppOAuthClients, userAppOAuthTokens, userAppOAuthStates]) await db.delete(t).where(and(eq(t.name, at.name), eq(t.dev, at.dev)));
}
