import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashPassword, verifyPassword } from './passwords';
import { DirectoryCore, accountGate, hashToken, newId, type Mail, type Sql } from './core';
import { DIRECTORY_MIGRATIONS } from './schema';
import { ensureAssistant, personalAgentFor } from './agents';
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
    expect(sql.exec("SELECT COUNT(*) AS n FROM accounts WHERE kind <> 'personal_agent'").toArray()[0]!.n).toBe(5);
    // Assistants are the Org object's to ask for (decision_log 2026-11-11): the backfill makes none.
    expect(sql.exec("SELECT COUNT(*) AS n FROM accounts WHERE kind = 'personal_agent'").toArray()[0]!.n).toBe(0);
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
    expect(core.accountByAddress(made.address!)!.id).toBe(made.id);
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
    expect(core.accountsOfOrganization(org).filter((x) => x.kind !== 'personal_agent').map((x) => x.address).sort()).toEqual(['ann2@acme.freeflow.im', 'ann@acme.freeflow.im']);
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

describe('guest accounts (platform.md §3.3)', () => {
  const join = (org: string, userId: string, role = 'member') => core.applyOrgChanges(org, [{ kind: 'join', id: org, user_id: userId, role, payload: null }]);
  const leave = (org: string, userId: string) => core.applyOrgChanges(org, [{ kind: 'leave', id: org, user_id: userId, role: null, payload: null }]);
  const policies = (org: string, p: Record<string, unknown>) => core.applyOrgChanges(org, [{ kind: 'policies', id: org, user_id: null, role: null, payload: JSON.stringify(p) }]);
  const addressRows = () => nodeSqlOf(core).exec('SELECT address FROM addresses ORDER BY address').toArray().map((r) => r.address);

  it('joins as native unless the join asks for a guest (no address, active); an owner is always native', async () => {
    const [a, b, c] = [await signUp('a@example.com'), await signUp('b@example.com'), await signUp('c@example.com')];
    const org = newId();
    core.reserveSlug('acme', org);
    await join(org, a.user.id, 'owner');
    await join(org, b.user.id);
    expect(core.accountFor(b.user.id, org)).toMatchObject({ kind: 'native', address: 'ann2@acme.freeflow.im', state: 'active' });
    // A guest invitation's join (docs/specs/workspace-admin.md §6.5).
    const guest = core.ensureAccount(c.user.id, org, 'member', undefined, 'guest');
    expect(guest).toMatchObject({ kind: 'guest', address: null, state: 'active' });
    expect(addressRows()).toEqual(['ann2@acme.freeflow.im', 'ann@acme.freeflow.im']);
    const other = newId();
    core.reserveSlug('beta', other);
    core.ensureAccount(c.user.id, other, 'owner', undefined, 'guest');
    expect(core.accountFor(c.user.id, other)).toMatchObject({ kind: 'native', address: 'ann@beta.freeflow.im' });
    // A removed guest comes back a guest, active.
    await leave(org, c.user.id);
    expect(core.ensureAccount(c.user.id, org, 'member')).toMatchObject({ id: guest.id, kind: 'guest', address: null, state: 'active' });
  });

  it('changes kind both ways: the address freed, then a new one made; an owner cannot be a guest', async () => {
    const [a, b] = [await signUp('a@example.com'), await signUp('b@example.com')];
    const org = newId();
    core.reserveSlug('acme', org);
    await join(org, a.user.id, 'owner');
    await join(org, b.user.id);
    const bob = core.accountFor(b.user.id, org)!;
    expect(core.setAccountKind(org, bob.id, 'guest')).toMatchObject({ id: bob.id, kind: 'guest', address: null, state: 'active' });
    expect(addressRows()).toEqual(['ann@acme.freeflow.im']);
    expect(core.accountByAddress('ann2@acme.freeflow.im')).toBeNull();
    expect(core.setAccountKind(org, bob.id, 'guest').kind).toBe('guest');
    expect(core.setAccountKind(org, bob.id, 'native')).toMatchObject({ kind: 'native', address: 'ann2@acme.freeflow.im' });
    expect(addressRows()).toEqual(['ann2@acme.freeflow.im', 'ann@acme.freeflow.im']);
    const owner = core.accountFor(a.user.id, org)!;
    expect(() => core.setAccountKind(org, owner.id, 'guest')).toThrow(/owner cannot be a guest/);
    expect(core.accountById(owner.id)).toMatchObject({ kind: 'native', address: 'ann@acme.freeflow.im' });
    expect(() => core.setAccountKind(newId(), bob.id, 'guest')).toThrow('account not found');
    // Made owner while a guest (outside the transfer route, which refuses): native again, with an address.
    core.setAccountKind(org, bob.id, 'guest');
    await join(org, b.user.id, 'owner');
    expect(core.accountFor(b.user.id, org)).toMatchObject({ role: 'owner', kind: 'native', address: 'ann2@acme.freeflow.im' });
  });

  it('migrates existing accounts unchanged, and lets the address be NULL', () => {
    const sql = nodeSql();
    const before = DIRECTORY_MIGRATIONS.length - 1;
    sql.exec('CREATE TABLE _migrations (n INTEGER PRIMARY KEY)');
    DIRECTORY_MIGRATIONS.slice(0, before).forEach((m, i) => { sql.exec(m); sql.exec('INSERT INTO _migrations (n) VALUES (?)', i); });
    sql.exec("INSERT INTO users (id, email, password_hash, display_name, created_at) VALUES ('u1', 'u1@example.com', 'x', 'Ann', 1)");
    sql.exec("INSERT INTO accounts (id, user_id, organization_id, address, display_name, role, state, created_at, hosted_at, sponsor_user_id) VALUES ('a1', 'u1', 'o1', 'ann@acme.freeflow.im', 'Ann', 'owner', 'active', 5, 7, NULL)");
    const c = new DirectoryCore(sql, { webUrlBase: 'https://app.test', registrationEnabled: true, send: async () => {} });
    expect(c.accountById('a1')).toMatchObject({ address: 'ann@acme.freeflow.im', kind: 'native', role: 'owner', state: 'active' });
    expect(c.provisioningTarget('a1')).toMatchObject({ hosted: true, mailboxAddress: 'ann@acme.freeflow.im' });
    sql.exec("INSERT INTO accounts (id, user_id, organization_id, address, display_name, role, kind, created_at) VALUES ('a2', 'u1', 'o2', NULL, 'Ann', 'member', 'guest', 6)");
    expect(c.accountById('a2')!.address).toBeNull();
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
    expect(own!.atProvider).toBe(false);
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
    // Step 4 of the admin's setup (workspace-admin.md §4.1): the domain is at the provider now.
    expect(own.atProvider).toBe(true);
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

  it('places a bridge agent in the organization it joins, as a shared agent, and refuses it anywhere else (agents.md §1)', async () => {
    const ann = await signUp('a@example.com');
    const bob = await signUp('b@example.com');
    const [o1, o2] = [newId(), newId()];
    core.reserveSlug('acme', o1);
    core.reserveSlug('beta', o2);
    const bot = newId();
    await core.applyOrgChanges(o1, [join(o1, ann.user.id), join(o1, bob.user.id), agent(bot, ann.user.id, 'builder'), join(o1, bot, ann.user.id)]);
    expect(core.accountsOf(bot).map((a) => a.address)).toEqual(['builder@acme.freeflow.im']);
    expect(core.accountFor(bot, o1)).toMatchObject({ kind: 'native', sponsorId: ann.user.id, agentMode: 'shared' });
    expect(core.getUser(bot, ann.user.id)).toMatchObject({ isAgent: true, agentMode: 'shared' });
    // Bob brings it into o2: an agent belongs to one organization, so the sync path refuses it before any member row, and
    // a join or principal an object reports anyway is skipped (never applied, never a refusal that holds up the outbox).
    await core.applyOrgChanges(o2, [join(o2, ann.user.id), join(o2, bob.user.id)]);
    expect(() => core.ensureAccount(bot, o2, 'member', 'Builder')).toThrow('belongs to another organization');
    await core.applyOrgChanges(o2, [join(o2, bot, bob.user.id), agent(bot, bob.user.id, 'builder')]);
    expect(core.accountFor(bot, o2)).toBeNull();
    expect(core.organizationsOf(bot)).toEqual([o1]);
    // The sponsor leaves, and the agent follows (platform.md §3.3, rule 2).
    await core.applyOrgChanges(o1, [{ kind: 'leave', id: o1, user_id: ann.user.id, role: null, payload: null }]);
    expect(core.accountFor(bot, o1)!.state).toBe('removed');
    expect(core.organizationsOf(bot)).toEqual([]);
    // A tombstoned sponsor takes their agents out of every organization.
    const bot2 = newId();
    await core.applyOrgChanges(o2, [agent(bot2, bob.user.id, 'helper'), join(o2, bot2, bob.user.id)]);
    expect(core.organizationsOf(bot2)).toEqual([o2]);
    core.tombstoneUser(bob.user.id);
    expect(core.organizationsOf(bot2)).toEqual([]);
    expect(core.accountFor(bot2, o2)!.state).toBe('removed');
  });

  it('skips a join or principal an Org object reports for an agent that belongs elsewhere, and applies the rest of the batch', async () => {
    const ann = await signUp('a@example.com');
    const carol = await signUp('c@example.com');
    const [o1, o2] = [newId(), newId()];
    core.reserveSlug('acme', o1);
    core.reserveSlug('beta', o2);
    const bot = newId();
    await core.applyOrgChanges(o1, [join(o1, ann.user.id), agent(bot, ann.user.id, 'builder'), join(o1, bot, ann.user.id)]);
    await core.applyOrgChanges(o2, [join(o2, ann.user.id)]);
    // An imported principal present in two objects: o2 reports it and a join; both are skipped, Carol's join and the index land.
    await core.applyOrgChanges(o2, [agent(bot, ann.user.id, 'builder'), join(o2, bot, ann.user.id), join(o2, carol.user.id), { kind: 'index', id: 'idx-1', user_id: null, role: null, payload: null }]);
    expect(core.accountFor(bot, o2)).toBeNull();
    expect(core.accountFor(carol.user.id, o2)).toMatchObject({ state: 'active' });
    expect(core.organizationOfId('idx-1')).toBe(o2);
    expect(core.organizationsOf(bot)).toEqual([o1]);
  });

  it('hands back an agent’s claim of who asked only when it names another member of the organization (agents.md §3)', async () => {
    const ann = await signUp('a@example.com');
    const bob = await signUp('b@example.com');
    const org = newId();
    core.reserveSlug('acme', org);
    const bot = newId();
    await core.applyOrgChanges(org, [join(org, ann.user.id), join(org, bob.user.id), agent(bot, ann.user.id, 'builder'), join(org, bot, ann.user.id)]);
    const token = 'flow-agent-token-test';
    await core.applyOrgChanges(org, [{ kind: 'agent_token', id: newId(), user_id: bot, role: null, payload: await hashToken(token) }]);
    const botAccount = core.accountFor(bot, org)!.id;
    const bobAccount = core.accountFor(bob.user.id, org)!.id;
    expect((await core.authenticateIn(token, org, bobAccount)).invokedBy).toBe(bobAccount);
    expect((await core.authenticateIn(token, org, botAccount)).invokedBy).toBeNull();
    expect((await core.authenticateIn(token, org, newId())).invokedBy).toBeNull();
    expect((await core.authenticateIn(token, null, bobAccount)).invokedBy).toBeNull();
    // A person's claim is dropped.
    expect((await core.authenticateIn(ann.token, org, bobAccount)).invokedBy).toBeNull();
    // A removed member is no asker.
    await core.applyOrgChanges(org, [{ kind: 'leave', id: org, user_id: bob.user.id, role: null, payload: null }]);
    expect((await core.authenticateIn(token, org, bobAccount)).invokedBy).toBeNull();
  });

  it('refuses a token for a personal agent, and never changes a personal agent’s kind (agents.md §1, §2)', async () => {
    const ann = await signUp('a@example.com');
    const org = newId();
    core.reserveSlug('acme', org);
    await core.applyOrgChanges(org, [join(org, ann.user.id)]);
    const agentId = personalAgentFor(nodeSqlOf(core), ann.user.id, org, 'Claude Desktop');
    const account = core.accountFor(agentId, org)!;
    expect(account).toMatchObject({ kind: 'personal_agent', address: null, state: 'active', sponsorId: ann.user.id, agentMode: 'personal', displayName: 'Claude Desktop' });
    await core.applyOrgChanges(org, [{ kind: 'agent_token', id: newId(), user_id: agentId, role: null, payload: 'deadbeef' }]);
    expect(nodeSqlOf(core).exec('SELECT 1 AS x FROM agent_tokens WHERE user_id = ?', agentId).toArray()).toEqual([]);
    expect(() => core.setAccountKind(org, account.id, 'guest')).toThrow("a personal agent's account never changes kind");
    expect(() => core.setAccountKind(org, core.accountFor(ann.user.id, org)!.id, 'personal_agent')).toThrow("a personal agent's account never changes kind");
    // The same client again is the same agent, a retired one included; another client is another agent.
    expect(personalAgentFor(nodeSqlOf(core), ann.user.id, org, 'Claude Desktop')).toBe(agentId);
    core.removePersonalAgent(org, account.id);
    expect(personalAgentFor(nodeSqlOf(core), ann.user.id, org, 'Claude Desktop')).toBe(agentId);
    expect(core.accountFor(agentId, org)).toMatchObject({ id: account.id, state: 'active' });
    expect(nodeSqlOf(core).exec('SELECT deleted_at FROM users WHERE id = ?', agentId).toArray()[0]!.deleted_at).toBeNull();
    expect(personalAgentFor(nodeSqlOf(core), ann.user.id, org, 'Cursor')).not.toBe(agentId);
    expect(core.accountsOfOrganization(org).filter((a) => a.kind === 'personal_agent' && a.agentRuntime === 'external')).toHaveLength(2);
    // An agent cannot sponsor one; nor can a person in an organization they are not in.
    expect(() => personalAgentFor(nodeSqlOf(core), agentId, org, 'X')).toThrow('an agent cannot sponsor an agent');
    expect(() => personalAgentFor(nodeSqlOf(core), ann.user.id, newId(), 'X')).toThrow('where its sponsor has an active account');
  });

  it('removes a personal agent: its delegations revoked, its principal tombstoned; a removed sponsor takes its agents along', async () => {
    const ann = await signUp('a@example.com');
    const bob = await signUp('b@example.com');
    const org = newId();
    core.reserveSlug('acme', org);
    await core.applyOrgChanges(org, [join(org, ann.user.id), join(org, bob.user.id)]);
    const sql = nodeSqlOf(core);
    const mk = (sponsor: string, client: string) => {
      const id = personalAgentFor(sql, sponsor, org, client);
      sql.exec("INSERT INTO oauth_tokens (hash, kind, client_id, user_id, org_id, scope, family, expires_at, created_at) VALUES (?, 'refresh', 'c', ?, ?, 'files:read', ?, ?, 1)", `h-${id}`, sponsor, org, `fam-${id}`, Date.now() + 1e6);
      sql.exec("INSERT INTO oauth_connections (id, family, user_id, org_id, client_name, origin, resource, created_at, agent_id) VALUES (?, ?, ?, ?, ?, 'o', 'r', 1, ?)", `c-${id}`, `fam-${id}`, sponsor, org, client, id);
      return id;
    };
    const a1 = mk(ann.user.id, 'Claude Desktop');
    const b1 = mk(bob.user.id, 'Claude Desktop');
    const removed = core.removePersonalAgent(org, core.accountFor(a1, org)!.id);
    expect(removed.state).toBe('removed');
    expect(sql.exec('SELECT revoked_at FROM oauth_tokens WHERE family = ?', `fam-${a1}`).toArray()[0]!.revoked_at).not.toBeNull();
    expect(sql.exec('SELECT 1 AS x FROM oauth_connections WHERE agent_id = ?', a1).toArray()).toEqual([]);
    expect(sql.exec('SELECT deleted_at FROM users WHERE id = ?', a1).toArray()[0]!.deleted_at).not.toBeNull();
    expect(() => core.removePersonalAgent(org, core.accountFor(bob.user.id, org)!.id)).toThrow('personal agent not found');
    // Bob leaves: his agent's account follows, and its delegation is over.
    await core.applyOrgChanges(org, [{ kind: 'leave', id: org, user_id: bob.user.id, role: null, payload: null }]);
    expect(core.accountFor(b1, org)!.state).toBe('removed');
    expect(sql.exec('SELECT revoked_at FROM oauth_tokens WHERE family = ?', `fam-${b1}`).toArray()[0]!.revoked_at).not.toBeNull();
  });

  it('gives every person an assistant with their account: a hosted personal agent, listed as usable, back when they rejoin (agents.md §6)', async () => {
    const ann = await signUp('a@example.com');
    const bob = await signUp('b@example.com');
    const org = newId();
    core.reserveSlug('acme', org);
    await core.applyOrgChanges(org, [join(org, ann.user.id), join(org, bob.user.id)]);
    // The Org object asks for each member's assistant (decision_log 2026-11-11).
    core.ensureAssistantFor(ann.user.id, org, 'Ann');
    core.ensureAssistantFor(bob.user.id, org, 'Bob');
    const id = core.assistantOf(ann.user.id, org);
    expect(id).toBeTruthy();
    expect(core.accountFor(id!, org)).toMatchObject({ kind: 'personal_agent', address: null, sponsorId: ann.user.id, agentMode: 'personal', agentRuntime: 'hosted', displayName: expect.stringContaining('’s assistant') });
    expect(core.getUser(id!, ann.user.id)).toMatchObject({ isAgent: true, agentMode: 'personal' });
    // Usable from the panel: Ann's own assistant alone (no hosted shared agent yet), and Bob's for Bob.
    expect(core.usableAgents(ann.user.id, org)).toEqual([expect.objectContaining({ id, mode: 'personal', self: true })]);
    expect(core.usableAgents(bob.user.id, org).map((a) => a.self)).toEqual([true]);
    expect(core.usableAgents(bob.user.id, org)[0]!.id).not.toBe(id);
    // A hosted shared agent is usable by both.
    const bot = newId();
    await core.applyOrgChanges(org, [agent(bot, ann.user.id, 'omni'), join(org, bot, ann.user.id)]);
    core.setAgentRuntime(bot, 'hosted');
    expect(core.usableAgents(bob.user.id, org).map((a) => [a.mode, a.self])).toEqual([[ 'personal', true ], ['shared', false]]);
    expect(core.accountFor(bot, org)!.agentRuntime).toBe('hosted');
    // The Worker acts as a hosted agent through its identity: the hosted one here, never an external agent or a person.
    expect(core.agentIdentity(bot, org)).toMatchObject({ user: { id: bot, isAgent: true }, account: { principalId: bot, organizationId: org } });
    expect(core.agentIdentity(id!, org)).toMatchObject({ user: { id }, account: { kind: 'personal_agent' } });
    expect(core.agentIdentity(bot, newId())).toBeNull();
    expect(core.agentIdentity(ann.user.id, org)).toBeNull();
    core.setAgentRuntime(bot, 'external');
    expect(core.agentIdentity(bot, org)).toBeNull();
    core.setAgentRuntime(bot, 'hosted');
    // Ann leaves: her assistant goes with her; back in, the same assistant returns.
    await core.applyOrgChanges(org, [{ kind: 'leave', id: org, user_id: ann.user.id, role: null, payload: null }]);
    expect(core.accountFor(id!, org)!.state).toBe('removed');
    expect(core.assistantOf(ann.user.id, org)).toBeNull();
    await core.applyOrgChanges(org, [join(org, ann.user.id)]);
    expect(core.assistantOf(ann.user.id, org)).toBeNull();
    core.ensureAssistantFor(ann.user.id, org, 'Ann');
    expect(core.assistantOf(ann.user.id, org)).toBe(id);
    expect(core.accountFor(id!, org)!.state).toBe('active');
  });

  it('lets a person make up to five private agents, their assistant the default, each with its own runtime (agents.md §1.3)', async () => {
    const ann = await signUp('pa@example.com');
    const bob = await signUp('pb@example.com');
    const org = newId();
    core.reserveSlug('pacme', org);
    await core.applyOrgChanges(org, [join(org, ann.user.id), join(org, bob.user.id)]);
    // Not before the assistant: it is the default, the first one made.
    expect(() => core.createPersonalAgentFor(ann.user.id, org, 'Scout')).toThrow('not ready');
    core.ensureAssistantFor(ann.user.id, org, 'Ann');
    core.ensureAssistantFor(bob.user.id, org, 'Bob');
    const assistant = core.assistantOf(ann.user.id, org)!;
    const scout = core.createPersonalAgentFor(ann.user.id, org, '  Scout ');
    expect(scout).toMatchObject({ kind: 'personal_agent', address: null, sponsorId: ann.user.id, agentMode: 'personal', agentRuntime: 'hosted', displayName: 'Scout' });
    // The assistant stays the default; Scout is Ann's alone, listed after it and not `self`.
    expect(core.assistantOf(ann.user.id, org)).toBe(assistant);
    expect(core.usableAgents(ann.user.id, org).map((a) => [a.displayName, a.mode, a.self])).toEqual([[expect.stringContaining('assistant'), 'personal', true], ['Scout', 'personal', false]]);
    expect(core.usableAgents(bob.user.id, org).map((a) => a.id)).not.toContain(scout.principalId);
    // The assistant's runtime is Ann's account's object, as before; Scout's is its own, `agent:<account>`.
    const annAccount = core.accountFor(ann.user.id, org)!;
    expect(core.hostedRuntimeOf(core.accountFor(assistant, org)!.id)).toMatchObject({ runtimeKey: annAccount.id, mode: 'personal', sponsorAccountId: annAccount.id });
    expect(core.hostedRuntimeOf(scout.id)).toMatchObject({ runtimeKey: `agent:${scout.id}`, agentId: scout.principalId, mode: 'personal', sponsorAccountId: annAccount.id });
    // Five in all, the assistant among them.
    for (const n of ['Two', 'Three', 'Four']) core.createPersonalAgentFor(ann.user.id, org, n);
    expect(() => core.createPersonalAgentFor(ann.user.id, org, 'Six')).toThrow('the most one person may have');
    // Removing one makes room; an agent cannot make one, nor can someone who is not a member.
    core.removePersonalAgent(org, scout.id);
    expect(core.createPersonalAgentFor(ann.user.id, org, 'Five').displayName).toBe('Five');
    expect(() => core.createPersonalAgentFor(assistant, org, 'Sub')).toThrow('an agent cannot sponsor an agent');
    expect(() => core.createPersonalAgentFor(ann.user.id, newId(), 'Elsewhere')).toThrow('only a member');
    // When Ann leaves, they all go with her.
    await core.applyOrgChanges(org, [{ kind: 'leave', id: org, user_id: ann.user.id, role: null, payload: null }]);
    expect(core.usableAgents(ann.user.id, org)).toEqual([]);
  });

  it("reconciles an organization's accounts with its member list: a lost leave's account goes, with its assistant", async () => {
    const own = await signUp('ro@example.com');
    const ann = await signUp('ra@example.com');
    const gus = await signUp('rg@example.com');
    const org = newId();
    core.reserveSlug('recon', org);
    await core.applyOrgChanges(org, [{ kind: 'join', id: org, user_id: own.user.id, role: 'owner', payload: null }, join(org, ann.user.id)]);
    core.ensureAccount(gus.user.id, org, 'member', 'Gus', 'guest');
    const annAssistant = core.ensureAssistantFor(ann.user.id, org, 'Ann').principalId;
    core.ensureAssistantFor(own.user.id, org, 'Olive');
    // The member list says only the owner is left: Ann's and Gus's leaves were lost.
    const listed = core.reconcileOrganization(org, [own.user.id], false);
    expect(listed.map((a) => a.principalId).sort()).toEqual([ann.user.id, gus.user.id, annAssistant].sort());
    expect(core.accountFor(ann.user.id, org)!.state).toBe('active');
    const removed = core.reconcileOrganization(org, [own.user.id]);
    expect(removed).toHaveLength(3);
    for (const id of [ann.user.id, gus.user.id, annAssistant]) expect(core.accountFor(id, org)!.state).toBe('removed');
    expect(core.accountFor(own.user.id, org)!.state).toBe('active');
    expect(core.assistantOf(own.user.id, org)).toBeTruthy();
    // Run again, nothing is left to do.
    expect(core.reconcileOrganization(org, [own.user.id])).toEqual([]);
  });

  it("records an assistant only when the organization's object asks for one, and brings the same one back (agents.md §6)", async () => {
    const own = await signUp('o@example.com');
    const gus = await signUp('g@example.com');
    const org = newId();
    core.reserveSlug('acme', org);
    await core.applyOrgChanges(org, [{ kind: 'join', id: org, user_id: own.user.id, role: 'owner', payload: null }]);
    core.ensureAccount(gus.user.id, org, 'member', 'Gus', 'guest');
    // Joining makes no assistant: the Org object decides (decision_log 2026-11-11).
    expect(core.assistantOf(own.user.id, org)).toBeNull();
    const made = core.ensureAssistantFor(own.user.id, org, 'Olive');
    expect(made).toMatchObject({ kind: 'personal_agent', sponsorId: own.user.id, agentRuntime: 'hosted', displayName: 'Olive’s assistant', state: 'active' });
    expect(core.assistantOf(own.user.id, org)).toBe(made.principalId);
    // Its member row leaving (set aside) removes the account and keeps the principal; asked again, the same one is back.
    await core.applyOrgChanges(org, [{ kind: 'leave', id: org, user_id: made.principalId, role: null, payload: null }]);
    expect(core.assistantOf(own.user.id, org)).toBeNull();
    expect(core.ensureAssistantFor(own.user.id, org, 'Olive').principalId).toBe(made.principalId);
    // A guest's kind change no longer touches assistants here.
    core.setAccountKind(org, core.accountFor(gus.user.id, org)!.id, 'native');
    expect(core.assistantOf(gus.user.id, org)).toBeNull();
  });

  it('retires agents made before kinds, once: accounts removed, tokens revoked, principal deleted; a personal agent per connection (phase A)', async () => {
    const ann = await signUp('a@example.com');
    const bob = await signUp('b@example.com');
    const [o1, o2] = [newId(), newId()];
    core.reserveSlug('acme', o1);
    core.reserveSlug('beta', o2);
    await core.applyOrgChanges(o1, [join(o1, ann.user.id), join(o1, bob.user.id)]);
    await core.applyOrgChanges(o2, [join(o2, ann.user.id), join(o2, bob.user.id)]);
    const sql = nodeSqlOf(core);
    // A bridge agent as the cut-over imported it: no mode, no organization, accounts in two organizations, a live token.
    const bot = newId();
    sql.exec("INSERT INTO users (id, email, password_hash, display_name, is_agent, agent_username, sponsor_user_id, created_at) VALUES (?, ?, 'x', 'Builder', 1, 'builder', ?, 1)", bot, `agent-${bot}@agents.flow.local`, ann.user.id);
    sql.exec("INSERT INTO accounts (id, user_id, organization_id, address, display_name, role, kind, state, created_at, sponsor_user_id, hosted_at) VALUES (?, ?, ?, 'builder@beta.freeflow.im', 'Builder', 'member', 'native', 'active', 10, ?, 5)", newId(), bot, o2, bob.user.id);
    sql.exec("INSERT INTO accounts (id, user_id, organization_id, address, display_name, role, kind, state, created_at, sponsor_user_id) VALUES (?, ?, ?, 'builder@acme.freeflow.im', 'Builder', 'member', 'native', 'active', 20, ?)", newId(), bot, o1, ann.user.id);
    const token = 'flow-agent-token-legacy';
    sql.exec('INSERT INTO agent_tokens (id, token_hash, user_id, created_at) VALUES (?, ?, ?, 1)', newId(), await hashToken(token), bot);
    // Two connections of one client and one of another, and a dead one whose person left its organization.
    for (const [fam, client, org] of [['f1', 'Claude Desktop', o1], ['f2', 'Claude Desktop', o1], ['f3', 'Cursor', o2], ['f4', 'Claude Desktop', newId()]]) {
      sql.exec("INSERT INTO oauth_connections (id, family, user_id, org_id, client_name, origin, resource, created_at) VALUES (?, ?, ?, ?, ?, 'o', 'r', 1)", `c-${fam}`, fam, ann.user.id, org, client);
    }
    const again = new DirectoryCore(sql, { webUrlBase: 'https://app.test', registrationEnabled: true, send: async () => {} });
    expect(again.accountFor(bot, o1)).toMatchObject({ state: 'removed', agentMode: 'shared', statusMessage: expect.stringContaining('connect the agent again') });
    expect(again.accountFor(bot, o2)).toMatchObject({ state: 'removed' });
    expect(again.organizationsOf(bot)).toEqual([]);
    await expect(again.authenticate(token)).rejects.toThrow();
    expect(sql.exec('SELECT deleted_at, mode FROM users WHERE id = ?', bot).toArray()[0]).toMatchObject({ mode: 'shared' });
    expect(sql.exec('SELECT deleted_at FROM users WHERE id = ?', bot).toArray()[0]!.deleted_at).not.toBeNull();
    const agents = (id: string) => sql.exec('SELECT agent_id FROM oauth_connections WHERE id = ?', id).toArray()[0]!.agent_id as string | null;
    expect(agents('c-f1')).toBeTruthy();
    expect(agents('c-f1')).toBe(agents('c-f2'));
    expect(agents('c-f3')).toBeTruthy();
    expect(agents('c-f3')).not.toBe(agents('c-f1'));
    expect(agents('c-f4')).toBeNull();
    expect(again.accountFor(agents('c-f1')!, o1)).toMatchObject({ kind: 'personal_agent', address: null, sponsorId: ann.user.id, agentMode: 'personal' });
    expect(again.accountFor(agents('c-f3')!, o2)).toMatchObject({ kind: 'personal_agent', agentMode: 'personal' });
    // Run again: nothing moves.
    const before = sql.exec('SELECT COUNT(*) AS n FROM users').toArray()[0]!.n;
    again.backfillAgents();
    expect(sql.exec('SELECT COUNT(*) AS n FROM users').toArray()[0]!.n).toBe(before);
    expect(again.takeProvisioning()).toEqual([]);
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

describe('cross-host handoff (the ChatGPT plugin\'s sign-in on its own hosts)', () => {
  it('trades a key once for the person it was made for, and never a used, unknown or expired one', async () => {
    const { user } = await signUp('p@example.com');
    const key = await core.createCrossHostHandoff(user.id);
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const redeemed = await core.redeemCrossHostHandoff(key);
    expect(redeemed.id).toBe(user.id);
    expect(redeemed.email).toBe('p@example.com');
    await expect(core.redeemCrossHostHandoff(key)).rejects.toThrow('invalid or expired sign-in key');
    await expect(core.redeemCrossHostHandoff('x'.repeat(43))).rejects.toThrow('invalid or expired sign-in key');
    const late = await core.createCrossHostHandoff(user.id);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(Date.now() + 3 * 60_000);
      await expect(core.redeemCrossHostHandoff(late)).rejects.toThrow('invalid or expired sign-in key');
    } finally {
      vi.useRealTimers();
    }
  });
});
