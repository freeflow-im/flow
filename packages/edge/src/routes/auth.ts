// /v1/auth/* and /v1/me: the same paths, bodies and answers as packages/server/src/routes/index.ts.
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { ZodTypeAny, z } from 'zod';
import { AgentLoginBody, AppLinkExchangeBody, AppleAuthBody, CompleteSignupBody, ConsumeSigninLinkBody, ForgotPasswordBody, GoogleAuthBody, LoginBody, RegisterBody, ResetPasswordBody, SigninLinkBody, emailDomain, type UserDTO } from '@flow/shared';
import { accountGate, type DirectoryCore } from '../directory/core';
import type { CallerContext } from '../org/routes/compat';
import type { Directory } from '../directory/object';
import type { Org } from '../org/object';
import { ApiError, badRequest, unauthorized } from '../errors';
import { appleProfile, googleProfile } from '../oauth';

const SESSION_COOKIE = 'sid';
const SESSION_TTL = 30 * 86400;

export interface AuthEnv {
  DIRECTORY: DurableObjectNamespace<Directory>;
  ORG: DurableObjectNamespace<Org>;
  WEB_URL_BASE: string;
  GOOGLE_CLIENT_ID?: string;
  APPLE_AUDIENCE?: string;
}
type Vars = { user: UserDTO; token: string; authKind: 'session' | 'agent' };
type C = Context<{ Bindings: AuthEnv; Variables: Vars }>;

/** Calls the directory object, turning its answer back into a value or an `ApiError`. */
export async function directory<M extends keyof DirectoryCore>(c: { env: AuthEnv }, method: M, ...args: unknown[]): Promise<Awaited<DirectoryCore[M] extends (...a: never[]) => infer R ? R : never>> {
  const stub = c.env.DIRECTORY.get(c.env.DIRECTORY.idFromName('directory'));
  const answer = (await stub.call(method as never, args)) as { ok: true; value: never } | { ok: false; status: number; code: string; message: string };
  if (!answer.ok) throw new ApiError(answer.status, answer.code, answer.message);
  return answer.value;
}

async function bodyOf<S extends ZodTypeAny>(schema: S, c: C): Promise<z.output<S>> {
  const r = schema.safeParse(await c.req.json().catch(() => undefined));
  if (!r.success) {
    const issue = r.error.issues[0];
    throw badRequest('validation', issue ? `${issue.path.join('.')}: ${issue.message}` : 'invalid request');
  }
  return r.data;
}

function signedIn<T extends { token: string }>(c: C, res: T, status: 200 | 201 = 200) {
  setCookie(c, SESSION_COOKIE, res.token, { path: '/', httpOnly: true, sameSite: 'Lax', secure: c.env.WEB_URL_BASE.startsWith('https://'), maxAge: SESSION_TTL });
  return c.json(res, status);
}

/** The bearer token, or the `sid` cookie the web client and the Workspace app's pages carry. */
export function tokenOf(c: Context): string | null {
  const header = c.req.header('authorization');
  return (header?.startsWith('Bearer ') ? header.slice(7).trim() : getCookie(c, SESSION_COOKIE)) || null;
}

/**
 * The caller context (platform.md §3.6), resolved once per request: the principal from the token, and when the request
 * names an organization, the account there, in one call to the directory. No token is no user (the route decides whether
 * that is allowed); no account there is a null account; a suspended or removed account is refused here (`account_inactive`).
 */
export async function resolveCaller<E extends AuthEnv>(c: Context<{ Bindings: E }>, organizationId?: string | null): Promise<CallerContext> {
  const token = tokenOf(c);
  const ip = c.req.header('cf-connecting-ip') ?? '';
  const org = organizationId ?? null;
  if (!token) return { user: null, token: null, authKind: null, ip, organizationId: org, account: null };
  const { user, kind, account } = await directory(c, 'authenticateIn', token, org);
  const refused = accountGate(account);
  if (refused) throw refused;
  return { user, token, authKind: kind, ip, organizationId: org, account };
}

/**
 * The caller context for a person's own app (Mail, Calendar), whose requests name an organization only by `?workspace=`
 * (or `?org=`). Naming none is fine while the person has one usable account: that one is used. With several, the request
 * has to say which; with none (in no organization yet), the context carries no account. A signed-in caller is required.
 */
export async function resolveAppCaller<E extends AuthEnv>(c: Context<{ Bindings: E }>): Promise<CallerContext & { user: UserDTO }> {
  const named = c.req.query('workspace') || c.req.query('org') || null;
  const who = await resolveCaller(c, named);
  if (!who.user) throw unauthorized('missing bearer token');
  if (named) return who as CallerContext & { user: UserDTO };
  const usable = (await directory(c, 'accountsOf', who.user.id)).filter((a) => !accountGate(a));
  if (usable.length > 1) throw badRequest('organization_required', 'name an organization: ?workspace=<id>');
  const account = usable[0] ?? null;
  return { ...who, user: who.user, organizationId: account?.organizationId ?? null, account };
}

/** A bearer header, or the cookie the Workspace app's pages carry. */
export const requireAuth = async (c: C, next: () => Promise<void>) => {
  const token = tokenOf(c);
  if (!token) throw unauthorized('missing bearer token');
  const { user, kind } = await directory(c, 'authenticate', token);
  c.set('user', user);
  c.set('token', token);
  c.set('authKind', kind);
  await next();
};

/** Every organization that opened its doors to this address's domain gains the person. One failure must not sink a sign-in. */
async function withDomainJoins<T extends { user: UserDTO }>(c: C, profile: { email: string }, res: T): Promise<T & { autoJoined: unknown[] }> {
  const domain = emailDomain(profile.email);
  const ids = domain ? await directory(c, 'organizationsForDomain', domain) : [];
  const autoJoined: unknown[] = [];
  for (const id of ids) {
    try {
      const joined = await (c.env.ORG.get(c.env.ORG.idFromName(id)) as unknown as { joinByDomain(u: UserDTO): Promise<unknown> }).joinByDomain(res.user);
      if (joined) autoJoined.push(joined);
    } catch (err) {
      console.error(`domain join ${id}: ${(err as Error).message}`);
    }
  }
  return { ...res, autoJoined };
}

export const authRoutes = new Hono<{ Bindings: AuthEnv; Variables: Vars }>();
const agent = (c: C) => c.req.header('user-agent');

authRoutes.post('/v1/auth/register', async (c) => {
  const body = await bodyOf(RegisterBody, c);
  return c.json(await directory(c, 'register', body.email), 201);
});
authRoutes.post('/v1/auth/register/complete', async (c) => {
  const body = await bodyOf(CompleteSignupBody, c);
  return signedIn(c, await directory(c, 'completeSignup', body.token, body.displayName, body.password, agent(c)), 201);
});
authRoutes.post('/v1/auth/login', async (c) => {
  const body = await bodyOf(LoginBody, c);
  return signedIn(c, await directory(c, 'login', body.email, body.password, agent(c)));
});
authRoutes.post('/v1/auth/password/forgot', async (c) => {
  await directory(c, 'forgotPassword', (await bodyOf(ForgotPasswordBody, c)).email);
  return c.json({ ok: true });
});
authRoutes.post('/v1/auth/password/reset', async (c) => {
  const body = await bodyOf(ResetPasswordBody, c);
  return signedIn(c, await directory(c, 'resetPassword', body.token, body.password, agent(c)));
});
authRoutes.post('/v1/auth/signin-link', async (c) => {
  await directory(c, 'sendSigninLink', (await bodyOf(SigninLinkBody, c)).email);
  return c.json({ ok: true });
});
authRoutes.post('/v1/auth/signin-link/consume', async (c) => {
  return signedIn(c, await directory(c, 'consumeSigninLink', (await bodyOf(ConsumeSigninLinkBody, c)).token, agent(c)));
});
authRoutes.post('/v1/auth/google', async (c) => {
  const profile = await googleProfile((await bodyOf(GoogleAuthBody, c)).idToken, c.env.GOOGLE_CLIENT_ID);
  return signedIn(c, await withDomainJoins(c, profile, await directory(c, 'signInWithOAuth', profile, agent(c))), 201);
});
authRoutes.post('/v1/auth/apple', async (c) => {
  const body = await bodyOf(AppleAuthBody, c);
  const profile = await appleProfile(body.identityToken, body.name, c.env.APPLE_AUDIENCE);
  return signedIn(c, await withDomainJoins(c, profile, await directory(c, 'signInWithOAuth', profile, agent(c))), 201);
});
authRoutes.post('/v1/auth/logout', requireAuth, async (c) => {
  await directory(c, 'logout', c.get('token'));
  deleteCookie(c, SESSION_COOKIE, { path: '/' });
  return c.json({ ok: true });
});
authRoutes.post('/v1/auth/session-cookie', requireAuth, (c) => {
  setCookie(c, SESSION_COOKIE, c.get('token'), { path: '/', httpOnly: true, sameSite: 'Lax', secure: c.env.WEB_URL_BASE.startsWith('https://'), maxAge: SESSION_TTL });
  return c.json({ ok: true });
});
authRoutes.post('/v1/auth/app-link', requireAuth, async (c) => c.json(await directory(c, 'createAppLink', c.get('user').id)));
authRoutes.post('/v1/auth/app-link/exchange', async (c) => {
  return signedIn(c, await directory(c, 'exchangeAppLink', (await bodyOf(AppLinkExchangeBody, c)).code, agent(c)));
});
// The connection-bound handoff (directory/authHandoff.ts), separate so old app-link exchanges cannot downgrade PKCE.
// The bodies go to the directory as they came: it counts the attempt before it reads them, as the server does.
const ip = (c: C) => c.req.header('cf-connecting-ip') ?? '';
const rawBody = (c: C) => c.req.json().catch(() => undefined);
authRoutes.post('/v1/auth/handoff/start', async (c) => {
  const res = await directory(c, 'startHandoff', await rawBody(c), c.req.header('origin'), ip(c));
  c.header('Cache-Control', 'no-store');
  return c.json(res, 201);
});
authRoutes.post('/v1/auth/handoff/approve', requireAuth, async (c) => {
  if (c.get('authKind') !== 'session' || c.get('user').isAgent) throw unauthorized('A human session is required');
  const res = await directory(c, 'approveHandoff', c.get('user').id, await rawBody(c));
  c.header('Cache-Control', 'no-store');
  return c.json(res);
});
authRoutes.post('/v1/auth/handoff/exchange', async (c) => {
  const res = await directory(c, 'exchangeHandoff', await rawBody(c), c.req.header('origin'), ip(c), agent(c));
  c.header('Cache-Control', 'no-store');
  return signedIn(c, res);
});
authRoutes.post('/v1/agents/login', async (c) => {
  const body = await bodyOf(AgentLoginBody, c);
  return c.json(await directory(c, 'agentLogin', body.username.toLowerCase(), body.key), 201);
});
// The accounts ride along on /v1/me (platform.md §3.3); UserDTO itself is unchanged, and clients ignore the extra field.
authRoutes.get('/v1/me', requireAuth, async (c) => c.json({ ...c.get('user'), accounts: await directory(c, 'accountsOf', c.get('user').id) }));
authRoutes.get('/v1/me/accounts', requireAuth, async (c) => c.json({ accounts: await directory(c, 'accountsOf', c.get('user').id) }));
authRoutes.get('/v1/me/identities', requireAuth, async (c) => c.json({ identities: await directory(c, 'listIdentities', c.get('user').id) }));
authRoutes.get('/v1/users/:id', requireAuth, async (c) => c.json(await directory(c, 'getUser', c.req.param('id'), c.get('user').id)));
