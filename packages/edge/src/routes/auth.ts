// /v1/auth/* and /v1/me: the same paths, bodies and answers as packages/server/src/routes/index.ts.
import { Hono, type Context } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { ZodTypeAny, z } from 'zod';
import { AppLinkExchangeBody, AppleAuthBody, CompleteSignupBody, ConsumeSigninLinkBody, ForgotPasswordBody, GoogleAuthBody, LoginBody, RegisterBody, ResetPasswordBody, SigninLinkBody, type UserDTO } from '@flow/shared';
import type { DirectoryCore } from '../directory/core';
import type { Directory } from '../directory/object';
import { ApiError, badRequest, unauthorized } from '../errors';
import { appleProfile, googleProfile } from '../oauth';

const SESSION_COOKIE = 'sid';
const SESSION_TTL = 30 * 86400;

export interface AuthEnv {
  DIRECTORY: DurableObjectNamespace<Directory>;
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

/** A bearer header, or the cookie the Workspace app's pages carry. */
export const requireAuth = async (c: C, next: () => Promise<void>) => {
  const header = c.req.header('authorization');
  const token = (header?.startsWith('Bearer ') ? header.slice(7).trim() : getCookie(c, SESSION_COOKIE)) || null;
  if (!token) throw unauthorized('missing bearer token');
  const { user, kind } = await directory(c, 'authenticate', token);
  c.set('user', user);
  c.set('token', token);
  c.set('authKind', kind);
  await next();
};

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
  return signedIn(c, { ...(await directory(c, 'signInWithOAuth', profile, agent(c))), autoJoined: [] }, 201);
});
authRoutes.post('/v1/auth/apple', async (c) => {
  const body = await bodyOf(AppleAuthBody, c);
  const profile = await appleProfile(body.identityToken, body.name, c.env.APPLE_AUDIENCE);
  return signedIn(c, { ...(await directory(c, 'signInWithOAuth', profile, agent(c))), autoJoined: [] }, 201);
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
authRoutes.get('/v1/me', requireAuth, (c) => c.json(c.get('user')));
authRoutes.get('/v1/me/identities', requireAuth, async (c) => c.json({ identities: await directory(c, 'listIdentities', c.get('user').id) }));
authRoutes.get('/v1/users/:id', requireAuth, async (c) => c.json(await directory(c, 'getUser', c.req.param('id'), c.get('user').id)));
