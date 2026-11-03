import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { hashPassword, verifyPassword } from './passwords';
import { DirectoryCore, hashToken, newId, type Mail, type Sql } from './core';

/** A real argon2 hash from the server's native library, of 'correct horse'. */
const NATIVE_ARGON2 = '$argon2id$v=19$m=19456,t=2,p=1$dOGITGpb+aQryD4cyJhifg$4AnUlxHn8Rap47Tc/l19RR185Wgh/k8LPlA6pJ8HXPo';

function nodeSql(): Sql {
  const db = new DatabaseSync(':memory:');
  return {
    exec(query: string, ...args: unknown[]) {
      const statements = query.trim().replace(/;$/, '');
      if (!args.length && statements.includes(';')) {
        db.exec(query);
        return { toArray: () => [] };
      }
      const stmt = db.prepare(query);
      const rows = stmt.columns().length ? stmt.all(...(args as never[])) : (stmt.run(...(args as never[])), []);
      return { toArray: () => rows as Record<string, unknown>[] };
    },
  };
}

/** The database a core runs over, for a test to change a row behind its back. */
const nodeSqlOf = (c: DirectoryCore) => (c as unknown as { sql: Sql }).sql;

let sent: Mail[];
let core: DirectoryCore;
const lastLink = (param: string) => new RegExp(`[?]${param}=([A-Za-z0-9_-]+)`).exec(sent.at(-1)!.text)![1]!;

beforeEach(() => {
  sent = [];
  core = new DirectoryCore(nodeSql(), { webUrlBase: 'https://app.test', registrationEnabled: true, send: async (m) => void sent.push(m) });
});

async function signUp(email = 'a@example.com', password = 'pw-pw-pw-pw') {
  await core.register(email);
  return core.completeSignup(lastLink('signup'), 'Ann', password, 'test');
}

describe('passwords', () => {
  it('accepts a hash made by the server\'s native argon2, and refuses a wrong password', async () => {
    expect(await verifyPassword(NATIVE_ARGON2, 'correct horse')).toBe(true);
    expect(await verifyPassword(NATIVE_ARGON2, 'wrong')).toBe(false);
  });
  it('round-trips its own hashes', async () => {
    expect(await verifyPassword(hashPassword('x'), 'x')).toBe(true);
    expect(await verifyPassword(hashPassword('x'), 'y')).toBe(false);
  });
  it('never matches a sentinel', async () => {
    expect(await verifyPassword('!google:abc', '!google:abc')).toBe(false);
  });
});

describe('registering', () => {
  it('creates nothing until the link is used, then signs in', async () => {
    expect(await core.register('a@example.com')).toEqual({ requiresVerification: true, email: 'a@example.com' });
    await expect(core.login('a@example.com', 'x')).rejects.toThrow('invalid email or password');
    const res = await core.completeSignup(lastLink('signup'), 'Ann', 'secret-pw');
    expect(res.user.displayName).toBe('Ann');
    expect((await core.authenticate(res.token)).user.id).toBe(res.user.id);
  });
  it('tells an existing account by mail, and says the same to the caller', async () => {
    await signUp();
    expect(await core.register('A@EXAMPLE.com')).toEqual({ requiresVerification: true, email: 'A@EXAMPLE.com' });
    expect(sent.at(-1)!.subject).toBe('You already have a Flow account');
  });
  it('uses a signup link once', async () => {
    await core.register('a@example.com');
    const link = lastLink('signup');
    await core.completeSignup(link, 'Ann', 'pw');
    await expect(core.completeSignup(link, 'Ann', 'pw')).rejects.toThrow('invalid or expired signup link');
  });
});

describe('signing in', () => {
  it('matches the address in any case', async () => {
    await signUp();
    expect((await core.login('A@Example.COM', 'pw-pw-pw-pw')).user.email).toBe('a@example.com');
  });
  it('refuses a wrong password', async () => {
    await signUp();
    await expect(core.login('a@example.com', 'nope')).rejects.toThrow('invalid email or password');
  });
  it('ends a session on logout', async () => {
    const { token } = await signUp();
    await core.logout(token);
    await expect(core.authenticate(token)).rejects.toThrow();
  });
  it('a reset changes the password and ends every other session', async () => {
    const { token } = await signUp();
    await core.forgotPassword('a@example.com');
    const fresh = await core.resetPassword(lastLink('reset'), 'new-password');
    await expect(core.authenticate(token)).rejects.toThrow();
    expect((await core.authenticate(fresh.token)).kind).toBe('session');
    expect((await core.login('a@example.com', 'new-password')).token).toBeTruthy();
  });
  it('says nothing about an unknown address', async () => {
    await core.forgotPassword('nobody@example.com');
    await core.sendSigninLink('nobody@example.com');
    expect(sent).toEqual([]);
  });
  it('a sign-in link works once and keeps other sessions', async () => {
    const { token } = await signUp();
    await core.sendSigninLink('a@example.com');
    const link = lastLink('signin');
    expect((await core.consumeSigninLink(link)).token).toBeTruthy();
    expect((await core.authenticate(token)).kind).toBe('session');
    await expect(core.consumeSigninLink(link)).rejects.toThrow();
  });
  it('an app link is single use', async () => {
    const { user } = await signUp();
    const { code } = await core.createAppLink(user.id);
    expect((await core.exchangeAppLink(code)).user.id).toBe(user.id);
    await expect(core.exchangeAppLink(code)).rejects.toThrow();
  });
  it('the desktop app\'s key is ready once approved, and trades for a session once', async () => {
    const { user } = await signUp();
    const key = 'k'.repeat(43);
    expect(await core.desktopHandoffReady(key)).toBe(false);
    await expect(core.exchangeDesktopHandoff(key)).rejects.toThrow();
    await core.approveDesktopHandoff(key, user.id);
    expect(await core.desktopHandoffReady(key)).toBe(true);
    const token = await core.exchangeDesktopHandoff(key);
    expect((await core.authenticate(token)).user.id).toBe(user.id);
    expect(await core.desktopHandoffReady(key)).toBe(false);
    await expect(core.exchangeDesktopHandoff(key)).rejects.toThrow();
  });
});

describe('the web-to-app handoff', () => {
  const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url');
  const opaque = () => b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challengeOf = async (v: string) => b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v))));
  let h: DirectoryCore;
  beforeEach(() => {
    h = new DirectoryCore(nodeSql(), {
      webUrlBase: 'https://app.test', registrationEnabled: true, send: async (m) => void sent.push(m),
      handoffReturnUrls: ['flow://signin', 'https://app.test/', 'https://other.test/'], allowedWebOrigins: ['https://other.test'],
    });
  });
  const nativeContext = () => ({ connectionId: 'conn-1', operationId: opaque(), state: opaque(), serverOrigin: 'https://app.test', clientOrigin: null, returnUrl: 'flow://signin' });
  async function person() {
    await h.register('p@example.com');
    return h.completeSignup(lastLink('signup'), 'Pat', 'pw-pw-pw-pw');
  }
  async function begin(context: Omit<ReturnType<typeof nativeContext>, 'clientOrigin'> & { clientOrigin: string | null } = nativeContext(), origin?: string) {
    const verifier = opaque();
    const { requestId, expiresAt } = await h.startHandoff({ ...context, codeChallenge: await challengeOf(verifier), codeChallengeMethod: 'S256' }, origin, '1.2.3.4');
    return { bound: { ...context, requestId }, verifier, expiresAt };
  }
  const codeOf = (callbackUrl: string) => new URL(callbackUrl).searchParams.get('code')!;

  it('starts, is approved by a signed-in person, and is exchanged once for their session', async () => {
    const { user } = await person();
    const { bound, verifier, expiresAt } = await begin();
    expect(Date.parse(expiresAt) - Date.now()).toBeGreaterThan(9 * 60_000);
    const approved = await h.approveHandoff(user.id, bound);
    const cb = new URL(approved.callbackUrl);
    expect(cb.protocol + cb.host + cb.pathname).toBe('flow:signin');
    expect(cb.searchParams.get('state')).toBe(bound.state);
    expect(cb.searchParams.get('operationId')).toBe(bound.operationId);
    const res = await h.exchangeHandoff({ ...bound, code: codeOf(approved.callbackUrl), codeVerifier: verifier }, undefined, '1.2.3.4', 'Flow for Mac');
    expect(res.user.id).toBe(user.id);
    expect((await h.authenticate(res.token)).user.id).toBe(user.id);
    await expect(h.exchangeHandoff({ ...bound, code: codeOf(approved.callbackUrl), codeVerifier: verifier }, undefined, '1.2.3.4')).rejects.toThrow('Invalid, expired, or mismatched handoff');
  });
  it('refuses a wrong PKCE verifier, and the right one still works after', async () => {
    const { user } = await person();
    const { bound, verifier } = await begin();
    const code = codeOf((await h.approveHandoff(user.id, bound)).callbackUrl);
    await expect(h.exchangeHandoff({ ...bound, code, codeVerifier: opaque() }, undefined, '1.2.3.4')).rejects.toThrow('Invalid, expired, or mismatched handoff');
    expect((await h.exchangeHandoff({ ...bound, code, codeVerifier: verifier }, undefined, '1.2.3.4')).user.id).toBe(user.id);
  });
  it('binds every part of the context', async () => {
    const { user } = await person();
    const { bound, verifier } = await begin();
    await expect(h.approveHandoff(user.id, { ...bound, state: opaque() })).rejects.toThrow('Unknown, expired, or already approved');
    await expect(h.approveHandoff(user.id, { ...bound, connectionId: 'other' })).rejects.toThrow('Unknown, expired, or already approved');
    const code = codeOf((await h.approveHandoff(user.id, bound)).callbackUrl);
    await expect(h.approveHandoff(user.id, bound)).rejects.toThrow('already approved');
    await expect(h.exchangeHandoff({ ...bound, operationId: opaque(), code, codeVerifier: verifier }, undefined, '1.2.3.4')).rejects.toThrow('mismatched');
  });
  it('is not exchanged before it is approved', async () => {
    await person();
    const { bound, verifier } = await begin();
    await expect(h.exchangeHandoff({ ...bound, code: opaque(), codeVerifier: verifier }, undefined, '1.2.3.4')).rejects.toThrow('mismatched');
  });
  it('checks the server, the return URL and the client origin', async () => {
    await expect(begin({ ...nativeContext(), serverOrigin: 'https://elsewhere.test' })).rejects.toThrow('initiating Flow server');
    await expect(begin({ ...nativeContext(), returnUrl: 'flow://other' })).rejects.toThrow('not allowlisted');
    await expect(begin({ ...nativeContext(), returnUrl: 'https://app.test/?x=1' })).rejects.toThrow('not allowlisted');
    // A native client sends no Origin; a browser must say the origin it binds.
    await expect(begin(nativeContext(), 'https://app.test')).rejects.toThrow('does not match the initiating client');
    const web = { ...nativeContext(), clientOrigin: 'https://app.test', returnUrl: 'https://app.test/' };
    await expect(begin(web)).rejects.toThrow('does not match the initiating client');
    expect((await begin(web, 'https://app.test')).bound.requestId).toBeTruthy();
    expect((await begin({ ...web, clientOrigin: 'https://other.test', returnUrl: 'https://other.test/' }, 'https://other.test')).bound.requestId).toBeTruthy();
    await expect(begin({ ...web, returnUrl: 'https://other.test/' }, 'https://app.test')).rejects.toThrow('must belong to the initiating origin');
    // The desktop app's renderer sends its own Origin and binds no client origin, as a native app does.
    expect((await begin(nativeContext(), 'app://flow')).bound.requestId).toBeTruthy();
  });
  it('validates bodies as the server does', async () => {
    await expect(h.startHandoff({ ...nativeContext(), codeChallenge: 'short', codeChallengeMethod: 'S256' }, undefined, 'ip')).rejects.toThrow('codeChallenge');
    await expect(h.startHandoff({ ...nativeContext(), codeChallenge: 'a'.repeat(43), codeChallengeMethod: 'plain' }, undefined, 'ip')).rejects.toThrow('codeChallengeMethod');
    await expect(h.startHandoff({ ...nativeContext(), extra: 1 as unknown, codeChallenge: 'a'.repeat(43), codeChallengeMethod: 'S256' }, undefined, 'ip')).rejects.toThrow('Unrecognized key');
    await expect(h.startHandoff(undefined, undefined, 'ip')).rejects.toMatchObject({ code: 'validation' });
  });
  it('is off without return URLs', async () => {
    await expect(core.startHandoff({ ...nativeContext(), codeChallenge: 'a'.repeat(43), codeChallengeMethod: 'S256' }, undefined, 'ip')).rejects.toThrow('not allowlisted');
  });
  it('limits starts to 30 per address in ten minutes', async () => {
    for (let i = 0; i < 30; i++) await begin();
    await expect(begin()).rejects.toMatchObject({ statusCode: 429, code: 'rate_limited' });
  });
  it('signs in no agent', async () => {
    const { user } = await person();
    const { bound, verifier } = await begin();
    const code = codeOf((await h.approveHandoff(user.id, bound)).callbackUrl);
    nodeSqlOf(h).exec('UPDATE users SET is_agent = 1 WHERE id = ?', user.id);
    await expect(h.exchangeHandoff({ ...bound, code, codeVerifier: verifier }, undefined, '1.2.3.4')).rejects.toThrow();
  });
});

describe('OAuth', () => {
  const google = { provider: 'google' as const, sub: 'g1', email: 'a@example.com', hostedDomain: null, name: 'Ann G' };
  it('creates a provider-first account no password can open', async () => {
    const res = await core.signInWithOAuth(google);
    expect(res.user.displayName).toBe('Ann G');
    await expect(core.login('a@example.com', '!google:')).rejects.toThrow();
  });
  it('links to an existing account by verified address, and finds it again by subject', async () => {
    const { user } = await signUp();
    expect((await core.signInWithOAuth(google)).user.id).toBe(user.id);
    expect((await core.signInWithOAuth({ ...google, email: 'changed@example.com' })).user.id).toBe(user.id);
    expect(core.listIdentities(user.id)[0]!.email).toBe('changed@example.com');
  });
});

describe('organizations', () => {
  it('knows an organization once someone has joined it', async () => {
    const a = await signUp('a@example.com');
    const org = newId();
    expect(core.organizationKnown(org)).toBe(false);
    await core.applyOrgChanges(org, [{ kind: 'join', id: org, user_id: a.user.id, role: 'owner', payload: null }]);
    expect(core.organizationKnown(org)).toBe(true);
    expect(core.organizationKnown(newId())).toBe(false);
  });
});

describe('profiles', () => {
  it('hides a stranger from a stranger', async () => {
    const a = await signUp('a@example.com');
    const b = await signUp('b@example.com');
    expect(() => core.getUser(a.user.id, b.user.id)).toThrow('user not found');
    expect(core.getUser(a.user.id, a.user.id).email).toBe('a@example.com');
  });
});

it('makes UUIDv7 ids and hex token hashes', async () => {
  expect(newId()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(await hashToken('x')).toMatch(/^[0-9a-f]{64}$/);
});
