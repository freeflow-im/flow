import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashPassword, verifyPassword } from './passwords';
import { DirectoryCore, accountGate, hashToken, newId, type Mail, type Sql } from './core';
import { DIRECTORY_MIGRATIONS } from './schema';
import { FakeMailProvider } from '../mailprovider/fake';
import { ProviderError } from '../mailprovider/provider';
import { decryptBlob } from '../org/crypto/index';

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

describe('accounts', () => {
  const join = (org: string, userId: string, role = 'member') => core.applyOrgChanges(org, [{ kind: 'join', id: org, user_id: userId, role, payload: null }]);
  const leave = (org: string, userId: string) => core.applyOrgChanges(org, [{ kind: 'leave', id: org, user_id: userId, role: null, payload: null }]);

  it('backfills an account and an address for every membership, the first time it sees the migration', () => {
    const sql = nodeSql();
    const accountsAt = DIRECTORY_MIGRATIONS.findIndex((m) => m.includes('CREATE TABLE accounts'));
    sql.exec('CREATE TABLE _migrations (n INTEGER PRIMARY KEY)');
    DIRECTORY_MIGRATIONS.slice(0, accountsAt).forEach((m, i) => { sql.exec(m); sql.exec('INSERT INTO _migrations (n) VALUES (?)', i); });
    const user = (id: string, name: string, agent?: string) => sql.exec(
      'INSERT INTO users (id, email, password_hash, display_name, is_agent, agent_username, created_at) VALUES (?, ?, ?, ?, ?, ?, 1)',
      id, `${id}@example.com`, 'x', name, agent ? 1 : 0, agent ?? null);
    user('u1', 'Ann Smith'); user('u2', 'Ann  Smith'); user('u3', 'José'); user('u4', 'Builder Bot', 'builder_bot');
    sql.exec("INSERT INTO organization_slugs (slug, organization_id) VALUES ('acme', 'o1'), ('beta', 'o2')");
    for (const [u, o, r] of [['u1', 'o1', 'owner'], ['u2', 'o1', 'member'], ['u3', 'o1', 'admin'], ['u4', 'o1', 'member'], ['u1', 'o2', 'member']]) {
      sql.exec('INSERT INTO memberships (user_id, organization_id, role) VALUES (?, ?, ?)', u, o, r);
    }
    const c = new DirectoryCore(sql, { webUrlBase: 'https://app.test', registrationEnabled: true, send: async () => {} });
    const addresses = (u: string) => c.accountsOf(u).map((a) => a.address).sort();
    expect(addresses('u1')).toEqual(['ann.smith@acme.freeflow.im', 'ann.smith@beta.freeflow.im']);
    expect(addresses('u2')).toEqual(['ann.smith2@acme.freeflow.im']);
    expect(addresses('u3')).toEqual(['jose@acme.freeflow.im']);
    expect(addresses('u4')).toEqual(['builder.bot@acme.freeflow.im']);
    expect(c.accountFor('u3', 'o1')).toMatchObject({ principalId: 'u3', organizationId: 'o1', displayName: 'José', role: 'admin', kind: 'native', state: 'active' });
    expect(sql.exec('SELECT COUNT(*) AS n FROM addresses').toArray()[0]!.n).toBe(5);
    expect(c.organization('o1')).toEqual({ id: 'o1', slug: 'acme', ownerUserId: 'u1', policies: {} });
    expect(c.organization('o2')!.ownerUserId).toBeNull();
    c.backfillAccounts();
    new DirectoryCore(sql, { webUrlBase: 'https://app.test', registrationEnabled: true, send: async () => {} });
    expect(sql.exec('SELECT COUNT(*) AS n FROM accounts').toArray()[0]!.n).toBe(5);
  });

  it('makes an account on join, marks it removed on leave keeping the address, and reactivates it on rejoin', async () => {
    const { user } = await signUp();
    const org = newId();
    core.reserveSlug('Acme', org);
    await join(org, user.id, 'member');
    const made = core.accountFor(user.id, org)!;
    expect(made).toMatchObject({ address: 'ann@acme.freeflow.im', role: 'member', state: 'active' });
    await join(org, user.id, 'admin');
    expect(core.accountFor(user.id, org)).toMatchObject({ id: made.id, role: 'admin', state: 'active' });
    await leave(org, user.id);
    expect(core.organizationsOf(user.id)).toEqual([]);
    expect(core.accountFor(user.id, org)).toMatchObject({ id: made.id, state: 'removed', address: made.address });
    expect(core.accountByAddress(made.address)!.id).toBe(made.id);
    await join(org, user.id, 'member');
    expect(core.accountFor(user.id, org)).toMatchObject({ id: made.id, role: 'member', state: 'active', address: made.address });
    expect(core.accountsOf(user.id)).toHaveLength(1);
  });

  it('finds an account by address whatever the case', async () => {
    const { user } = await signUp();
    const org = newId();
    core.reserveSlug('acme', org);
    await join(org, user.id);
    expect(core.accountByAddress('ANN@Acme.FreeFlow.im')!.principalId).toBe(user.id);
    expect(core.accountByAddress('nobody@acme.freeflow.im')).toBeNull();
  });

  it('takes the owner from the owner\'s join and keeps it through a later admin\'s join', async () => {
    const a = await signUp('a@example.com');
    const b = await signUp('b@example.com');
    const org = newId();
    core.reserveSlug('acme', org);
    expect(core.organization(org)).toMatchObject({ slug: 'acme', ownerUserId: null });
    await join(org, a.user.id, 'owner');
    await join(org, b.user.id, 'admin');
    expect(core.organization(org)!.ownerUserId).toBe(a.user.id);
    expect(core.accountFor(b.user.id, org)!.address).toBe('ann2@acme.freeflow.im');
    core.setOwner(org, b.user.id);
    core.setPolicies(org, { invite: 'admins' });
    expect(core.organization(org)).toMatchObject({ ownerUserId: b.user.id, policies: { invite: 'admins' } });
  });

  it('ensures an account before the member row: creates it, then the outbox join changes nothing', async () => {
    const { user } = await signUp();
    const org = newId();
    core.reserveSlug('acme', org);
    const made = core.ensureAccount(user.id, org, 'owner', 'Ann Lee');
    expect(made).toMatchObject({ principalId: user.id, organizationId: org, address: 'ann.lee@acme.freeflow.im', displayName: 'Ann Lee', role: 'owner', state: 'active' });
    expect(core.organization(org)!.ownerUserId).toBe(user.id);
    await join(org, user.id, 'owner');
    expect(core.accountsOf(user.id)).toEqual([made]);
    expect(nodeSqlOf(core).exec('SELECT COUNT(*) AS n FROM addresses').toArray()[0]!.n).toBe(1);
  });

  it('ensures an account: reactivates a removed one and sets the role, keeping the address', async () => {
    const { user } = await signUp();
    const org = newId();
    core.reserveSlug('acme', org);
    const made = core.ensureAccount(user.id, org, 'admin');
    expect(made).toMatchObject({ address: 'ann@acme.freeflow.im', role: 'admin' });
    await leave(org, user.id);
    expect(core.ensureAccount(user.id, org, 'member')).toMatchObject({ id: made.id, address: made.address, role: 'member', state: 'active' });
    expect(() => core.ensureAccount(newId(), org, 'member')).toThrow('user not found');
  });

  it('lists an organization\'s accounts, and follows the owner and policies the Org object reports', async () => {
    const a = await signUp('a@example.com');
    const b = await signUp('b@example.com');
    const org = newId();
    core.reserveSlug('acme', org);
    await join(org, a.user.id, 'owner');
    await join(org, b.user.id, 'member');
    await core.applyOrgChanges(newId(), [{ kind: 'join', id: 'x', user_id: a.user.id, role: 'member', payload: null }]);
    expect(core.accountsOfOrganization(org).map((x) => x.address).sort()).toEqual(['ann2@acme.freeflow.im', 'ann@acme.freeflow.im']);
    await core.applyOrgChanges(org, [
      { kind: 'join', id: org, user_id: b.user.id, role: 'owner', payload: null },
      { kind: 'owner', id: org, user_id: b.user.id, role: null, payload: null },
      { kind: 'join', id: org, user_id: a.user.id, role: 'admin', payload: null },
      { kind: 'policies', id: org, user_id: null, role: null, payload: '{"inviteBy":"admins","agentsBy":"members","linkSharing":true}' },
    ]);
    expect(core.organization(org)).toMatchObject({ ownerUserId: b.user.id, policies: { inviteBy: 'admins', agentsBy: 'members', linkSharing: true } });
    expect(core.accountFor(a.user.id, org)!.role).toBe('admin');
    expect(core.accountFor(b.user.id, org)!.role).toBe('owner');
  });
});

describe('domains (platform.md §3.2)', () => {
  let txt: string[];
  let lookups: number;
  const resolve = async (name: string, type: 'TXT' | 'MX') => {
    lookups++;
    return type === 'TXT' && name === '_freeflow.acme.test' ? txt : [];
  };
  beforeEach(() => {
    txt = [];
    lookups = 0;
    core = new DirectoryCore(nodeSql(), { webUrlBase: 'https://app.test', registrationEnabled: true, send: async (m) => void sent.push(m), resolve });
  });
  const join = (org: string, userId: string, role = 'member') => core.applyOrgChanges(org, [{ kind: 'join', id: org, user_id: userId, role, payload: null }]);

  it('gives a new organization its platform domain, verified and primary', () => {
    const org = newId();
    core.reserveSlug('Acme', org);
    expect(core.domainsOf(org)).toEqual([expect.objectContaining({ domain: 'acme.freeflow.im', kind: 'platform', verified: true, primary: true, verifyToken: null })]);
    expect(core.primaryDomainOf(org)).toBe('acme.freeflow.im');
    core.releaseSlug('Acme', org);
    expect(core.domainsOf(org)).toEqual([]);
  });

  it('backfills a platform domain for every organization', () => {
    const sql = nodeSql();
    const domainsAt = DIRECTORY_MIGRATIONS.findIndex((m) => m.includes('CREATE TABLE domains'));
    sql.exec('CREATE TABLE _migrations (n INTEGER PRIMARY KEY)');
    DIRECTORY_MIGRATIONS.slice(0, domainsAt).forEach((m, i) => { sql.exec(m); sql.exec('INSERT INTO _migrations (n) VALUES (?)', i); });
    sql.exec("INSERT INTO organizations (id, slug, created_at) VALUES ('o1', 'Acme', 1), ('o2', 'beta', 2)");
    const c = new DirectoryCore(sql, { webUrlBase: 'https://app.test', registrationEnabled: true, send: async () => {} });
    expect(c.domainsOf('o1')).toEqual([expect.objectContaining({ domain: 'acme.freeflow.im', kind: 'platform', verified: true, primary: true })]);
    expect(c.primaryDomainOf('o2')).toBe('beta.freeflow.im');
  });

  it('adds a domain with a token, refuses another organization\'s and what is no domain or is ours', () => {
    const org = newId(), other = newId();
    core.reserveSlug('acme', org);
    core.reserveSlug('other', other);
    const added = core.addDomain(org, 'Acme.TEST');
    expect(added).toMatchObject({ domain: 'acme.test', kind: 'own', verified: false, primary: false });
    expect(added.verifyToken).toMatch(/^freeflow-verify=[0-9a-f]{32}$/);
    expect(core.addDomain(org, 'acme.test').verifyToken).toBe(added.verifyToken);
    expect(() => core.addDomain(other, 'ACME.test')).toThrow(expect.objectContaining({ statusCode: 409, code: 'domain_taken' }));
    expect(() => core.addDomain(org, 'not a domain')).toThrow(expect.objectContaining({ code: 'invalid_domain' }));
    expect(() => core.addDomain(org, 'other.freeflow.im')).toThrow(expect.objectContaining({ code: 'domain_reserved' }));
    expect(core.domainsOf(org).map((d) => d.domain)).toEqual(['acme.freeflow.im', 'acme.test']);
  });

  it('verifies only when the TXT carries the token, and makes only a verified domain primary', async () => {
    const org = newId();
    core.reserveSlug('acme', org);
    const { verifyToken } = core.addDomain(org, 'acme.test');
    expect(() => core.setPrimaryDomain(org, 'acme.test')).toThrow(expect.objectContaining({ code: 'domain_unverified' }));
    txt = ['freeflow-verify=wrong'];
    expect(await core.verifyDomain(org, 'acme.test')).toEqual({ verified: false, found: ['freeflow-verify=wrong'] });
    txt = [verifyToken!];
    expect(await core.verifyDomain(org, 'acme.test')).toEqual({ verified: true, found: [verifyToken] });
    await expect(core.verifyDomain(newId(), 'acme.test')).rejects.toThrow('domain not found');
    expect(core.setPrimaryDomain(org, 'acme.test')).toMatchObject({ primary: true });
    expect(core.domainsOf(org).map((d) => [d.domain, d.primary])).toEqual([['acme.freeflow.im', false], ['acme.test', true]]);
    expect(core.primaryDomainOf(org)).toBe('acme.test');
  });

  it('makes new addresses on the primary domain and leaves existing ones; refuses to remove a domain in use', async () => {
    const a = await signUp('a@example.com');
    const org = newId();
    core.reserveSlug('acme', org);
    core.ensureAccount(a.user.id, org, 'owner', 'Ann');
    const { verifyToken } = core.addDomain(org, 'acme.test');
    txt = [verifyToken!];
    await core.verifyDomain(org, 'acme.test');
    expect(() => core.removeDomain(org, 'acme.freeflow.im')).toThrow(expect.objectContaining({ code: 'domain_platform' }));
    core.setPrimaryDomain(org, 'acme.test');
    expect(() => core.removeDomain(org, 'acme.test')).toThrow(expect.objectContaining({ code: 'domain_primary' }));
    expect(core.accountFor(a.user.id, org)!.address).toBe('ann@acme.freeflow.im');
    await core.register('c@example.com');
    const carol = await core.completeSignup(lastLink('signup'), 'Carol', 'pw-pw-pw-pw', 'test');
    await join(org, carol.user.id);
    expect(core.accountFor(carol.user.id, org)!.address).toBe('carol@acme.test');
    core.setPrimaryDomain(org, 'acme.freeflow.im');
    expect(() => core.removeDomain(org, 'acme.test')).toThrow(expect.objectContaining({ code: 'domain_in_use' }));
    core.addDomain(org, 'spare.test');
    core.removeDomain(org, 'spare.test');
    expect(core.domainsOf(org).map((d) => d.domain)).toEqual(['acme.freeflow.im', 'acme.test']);
  });

  it('describes each domain with its records and their status, reusing a check for a minute', async () => {
    const org = newId();
    core.reserveSlug('acme', org);
    const { verifyToken } = core.addDomain(org, 'acme.test');
    txt = [verifyToken!];
    const [platform, own] = await core.describeDomains(org);
    expect(platform).toMatchObject({ domain: 'acme.freeflow.im', kind: 'platform', verified: true, primary: true, status: [] });
    expect(own!.records[0]).toEqual({ type: 'TXT', name: '_freeflow.acme.test', value: verifyToken, purpose: 'verification' });
    expect(own!.records.find((r) => r.type === 'MX')!.value).toBe('mx.example.invalid');
    expect(own!.status.map((s) => s.record)).toEqual(['present', 'missing', 'missing', 'missing']);
    const before = lookups;
    await core.describeDomains(org);
    await core.describeDomains(org, true);
    expect(lookups).toBe(before);
  });
});

describe('domains with a mail provider (phase 5.2)', () => {
  let provider: FakeMailProvider;
  let txt: string[];
  beforeAll(() => { process.env.FLOW_DATA_KEY ??= randomBytes(32).toString('base64'); });
  beforeEach(() => {
    provider = new FakeMailProvider();
    txt = [];
    const resolve = async (name: string, type: 'TXT' | 'MX') => (type === 'TXT' && name === '_freeflow.acme.test' ? txt : []);
    core = new DirectoryCore(nodeSql(), { webUrlBase: 'https://app.test', registrationEnabled: true, send: async () => {}, resolve, mailProvider: provider });
  });
  const verified = async (org: string) => {
    txt = [core.addDomain(org, 'acme.test').verifyToken!];
    await core.verifyDomain(org, 'acme.test');
  };

  it('lists the provider\'s MX and SPF', async () => {
    const org = newId();
    core.reserveSlug('acme', org);
    core.addDomain(org, 'acme.test');
    const [platform, own] = await core.describeDomains(org);
    expect(own!.records.find((r) => r.purpose === 'mx')).toEqual({ type: 'MX', name: 'acme.test', value: 'mx.fake-mail.test', priority: 10, purpose: 'mx' });
    expect(own!.records.find((r) => r.purpose === 'spf')!.value).toBe('v=spf1 include:_spf.fake-mail.test ~all');
    expect(platform!.records.find((r) => r.purpose === 'mx')!.value).toBe('mx.fake-mail.test');
    expect(own!.records.some((r) => r.purpose === 'dkim')).toBe(false);
  });

  it('sets DKIM on a verified domain: the provider gets the key, the directory keeps it sealed, the list shows the TXT', async () => {
    const org = newId();
    core.reserveSlug('acme', org);
    core.addDomain(org, 'acme.test');
    await expect(core.setDomainDkim(org, 'acme.test')).rejects.toMatchObject({ code: 'domain_unverified' });
    await verified(org);
    const out = await core.setDomainDkim(org, 'acme.test');
    expect(out).toMatchObject({ domain: 'acme.test', kind: 'own', selector: expect.stringMatching(/^ff\d{6}$/) });
    expect(out.record).toMatchObject({ type: 'TXT', name: `${out.selector}._domainkey.acme.test`, purpose: 'dkim' });
    expect(out.record.value).toMatch(/^v=DKIM1; k=rsa; p=[A-Za-z0-9+/=]+$/);
    expect(provider.calls.map((c) => c.method)).toEqual(['createDomain', 'setDkim']);
    const given = provider.domains.get('acme.test')!.dkim!;
    expect(given.selector).toBe(out.selector);
    const row = nodeSqlOf(core).exec('SELECT * FROM domain_keys WHERE domain = ?', 'acme.test').toArray()[0]!;
    expect(decryptBlob(Buffer.from(row.key_sealed as Uint8Array), row.key_id as string).toString('utf8')).toBe(given.privateKeyPem);
    expect(Buffer.from(row.key_sealed as Uint8Array).toString('utf8')).not.toContain('PRIVATE KEY');
    const own = (await core.describeDomains(org)).find((d) => d.domain === 'acme.test')!;
    expect(own.records.at(-1)).toEqual(out.record);
    expect(own.status).toHaveLength(own.records.length);
    // The platform domain is verified from the start.
    expect((await core.setDomainDkim(org, 'acme.freeflow.im')).kind).toBe('platform');
    core.addDomain(org, 'spare.test');
    nodeSqlOf(core).exec("UPDATE domains SET verified_at = 1 WHERE domain = 'spare.test'");
    await core.setDomainDkim(org, 'spare.test');
    core.removeDomain(org, 'spare.test');
    expect(nodeSqlOf(core).exec("SELECT 1 FROM domain_keys WHERE domain = 'spare.test'").toArray()).toEqual([]);
  });

  it('with a provider that manages DKIM (MXRoute): makes the domain there, returns its record, keeps no key', async () => {
    const managed = new FakeMailProvider() as FakeMailProvider & { managesDkim: boolean };
    managed.managesDkim = true;
    const base = managed.records.bind(managed);
    managed.records = async (domain, dkim) => ({ ...(await base(domain, dkim)), verification: { name: `_da-verify-abc.${domain}`, value: 'domain-verified' }, ...(managed.domains.has(domain) ? { dkim: { selector: 'x', value: 'v=DKIM1; p=THEIRS' } } : {}) });
    core = new DirectoryCore(nodeSql(), { webUrlBase: 'https://app.test', registrationEnabled: true, send: async () => {}, resolve: async (name, type) => (type === 'TXT' && name === '_freeflow.acme.test' ? txt : []), mailProvider: managed });
    const org = newId();
    core.reserveSlug('acme', org);
    await verified(org);
    const before = (await core.describeDomains(org)).find((d) => d.domain === 'acme.test')!;
    expect(before.records.map((r) => r.purpose)).toEqual(['verification', 'provider', 'mx', 'spf', 'dmarc']);
    expect(before.records[1]).toMatchObject({ name: '_da-verify-abc.acme.test', value: 'domain-verified' });
    const out = await core.setDomainDkim(org, 'acme.test');
    expect(managed.calls.map((c) => c.method)).toEqual(['createDomain']);
    expect(out).toEqual({ domain: 'acme.test', kind: 'own', selector: 'x', record: { type: 'TXT', name: 'x._domainkey.acme.test', value: 'v=DKIM1; p=THEIRS', purpose: 'dkim' } });
    expect(nodeSqlOf(core).exec('SELECT 1 FROM domain_keys').toArray()).toEqual([]);
    const after = (await core.describeDomains(org)).find((d) => d.domain === 'acme.test')!;
    expect(after.records.at(-1)).toEqual(out.record);
    // Pending at the provider (its TXT not in DNS yet): a 409 the admin can act on.
    managed.createDomain = async () => { throw new ProviderError('pending', 'TXT missing'); };
    core.addDomain(org, 'spare.test');
    nodeSqlOf(core).exec("UPDATE domains SET verified_at = 1 WHERE domain = 'spare.test'");
    await expect(core.setDomainDkim(org, 'spare.test')).rejects.toMatchObject({ statusCode: 409, code: 'mail_provider_pending' });
  });

  it('says so when the provider fails, without storing a key', async () => {
    const org = newId();
    core = new DirectoryCore(nodeSql(), { webUrlBase: 'https://app.test', registrationEnabled: true, send: async () => {}, resolve: async () => [] });
    core.reserveSlug('acme', org);
    await expect(core.setDomainDkim(org, 'acme.freeflow.im')).rejects.toMatchObject({ statusCode: 503, code: 'mail_provider_unavailable' });
    expect(nodeSqlOf(core).exec('SELECT 1 FROM domain_keys').toArray()).toEqual([]);
  });

  it('lets another organization take a domain left unverified for more than a week', async () => {
    const squatter = newId(), owner = newId();
    core.reserveSlug('squat', squatter);
    core.reserveSlug('owner', owner);
    const first = core.addDomain(squatter, 'acme.test');
    expect(() => core.addDomain(owner, 'acme.test')).toThrow(expect.objectContaining({ code: 'domain_taken' }));
    nodeSqlOf(core).exec("UPDATE domains SET created_at = ? WHERE domain = 'acme.test'", Date.now() - 6 * 86_400_000);
    expect(() => core.addDomain(owner, 'acme.test')).toThrow(expect.objectContaining({ code: 'domain_taken' }));
    nodeSqlOf(core).exec("UPDATE domains SET created_at = ? WHERE domain = 'acme.test'", Date.now() - 8 * 86_400_000);
    const taken = core.addDomain(owner, 'acme.test');
    expect(taken).toMatchObject({ domain: 'acme.test', organizationId: owner, verified: false });
    expect(taken.verifyToken).not.toBe(first.verifyToken);
    expect(core.domainsOf(squatter).map((d) => d.domain)).toEqual(['squat.freeflow.im']);
    // A verified domain is never taken, however old.
    txt = [taken.verifyToken!];
    await core.verifyDomain(owner, 'acme.test');
    nodeSqlOf(core).exec("UPDATE domains SET created_at = 1 WHERE domain = 'acme.test'");
    expect(() => core.addDomain(squatter, 'acme.test')).toThrow(expect.objectContaining({ code: 'domain_taken' }));
  });
});

describe('agent accounts', () => {
  const agent = (id: string, sponsorId: string, username: string) => ({
    kind: 'agent_user', id, user_id: null, role: null,
    payload: JSON.stringify({ username, keyHash: null, passwordHash: '!agent', email: `agent-${id}@agents.flow.local`, displayName: username, sponsorId, createdAt: 1 }),
  });
  const join = (org: string, userId: string, sponsor: string | null = null) => ({ kind: 'join', id: org, user_id: userId, role: 'member', payload: sponsor });

  it('gives an agent an address per organization, and follows the sponsor there out (platform.md §3.3)', async () => {
    const ann = await signUp('a@example.com');
    const bob = await signUp('b@example.com');
    const [o1, o2] = [newId(), newId()];
    core.reserveSlug('acme', o1);
    core.reserveSlug('beta', o2);
    const bot = newId();
    await core.applyOrgChanges(o1, [join(o1, ann.user.id), join(o1, bob.user.id), agent(bot, ann.user.id, 'builder'), join(o1, bot, ann.user.id)]);
    // In o2 Bob brought it in, so Bob is its sponsor there.
    await core.applyOrgChanges(o2, [join(o2, ann.user.id), join(o2, bob.user.id), join(o2, bot, bob.user.id)]);
    expect(core.accountsOf(bot).map((a) => a.address).sort()).toEqual(['builder@acme.freeflow.im', 'builder@beta.freeflow.im']);
    await core.applyOrgChanges(o2, [{ kind: 'leave', id: o2, user_id: ann.user.id, role: null, payload: null }]);
    expect(core.organizationsOf(bot).sort()).toEqual([o1, o2].sort());
    await core.applyOrgChanges(o1, [{ kind: 'leave', id: o1, user_id: ann.user.id, role: null, payload: null }]);
    expect(core.accountFor(bot, o1)!.state).toBe('removed');
    expect(core.organizationsOf(bot)).toEqual([o2]);
    core.tombstoneUser(bob.user.id);
    expect(core.organizationsOf(bot)).toEqual([]);
    expect(core.organizationKnown(o2)).toBe(false);
  });
});

describe('the account gate', () => {
  it('lets through no account, and every state but suspended and removed', () => {
    expect(accountGate(null)).toBeNull();
    for (const state of ['requested', 'mailbox_ready', 'calendars_ready', 'active'] as const) expect(accountGate({ state })).toBeNull();
  });

  it('refuses a suspended or a removed account with a 403 account_inactive that says which', () => {
    expect(accountGate({ state: 'suspended' })).toMatchObject({ statusCode: 403, code: 'account_inactive', message: 'your account in this organization is suspended' });
    expect(accountGate({ state: 'removed' })).toMatchObject({ statusCode: 403, code: 'account_inactive', message: 'your account in this organization was removed' });
  });

  it('resolves the principal and its account in one call', async () => {
    const { user, token } = await signUp();
    const org = newId();
    core.reserveSlug('acme', org);
    await core.applyOrgChanges(org, [{ kind: 'join', id: org, user_id: user.id, role: 'member', payload: null }]);
    expect(await core.authenticateIn(token, null)).toMatchObject({ user: { id: user.id }, kind: 'session', account: null });
    expect((await core.authenticateIn(token, org)).account).toMatchObject({ principalId: user.id, organizationId: org, state: 'active' });
    expect((await core.authenticateIn(token, newId())).account).toBeNull();
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
