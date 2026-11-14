// Admin › Members › Create member: an account at `username@domain` with no password, a week-long setup link to a backup
// email, the Pending list's resend, and "Forgot password" reaching the backup email.
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DirectoryCore, newId, type Mail, type Sql } from './core';

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

const DAY = 86_400_000;
let sent: Mail[];
let sql: Sql;
let core: DirectoryCore;
let org: string;
const linkIn = (mail: Mail, param: string) => new RegExp(`[?]${param}=([A-Za-z0-9_-]+)`).exec(mail.text)![1]!;
const input = (over: Partial<{ displayName: string; username: string; domain: string; backupEmail: string }> = {}) => ({
  displayName: 'Bea Lin', username: 'bea', domain: 'acme.test', backupEmail: 'bea@gmail.example', ...over,
});

/** createMember, then the setup link, as the route does once the Org object has written the member row. */
async function create(over: Parameters<typeof input>[0] = {}) {
  const made = core.createMember(org, input(over));
  const pending = await core.sendSetupLink(org, made.account.id, { workspaceName: 'Acme', byName: 'Ann' });
  return { ...made, pending, link: linkIn(sent.at(-1)!, 'setup') };
}

beforeEach(() => {
  sent = [];
  sql = nodeSql();
  core = new DirectoryCore(sql, { webUrlBase: 'https://app.test', registrationEnabled: true, send: async (m) => void sent.push(m) });
  org = newId();
  core.reserveSlug('acme', org);
  core.addDomain(org, 'acme.test');
  sql.exec('UPDATE domains SET verified_at = 1 WHERE domain = ?', 'acme.test');
  core.addDomain(org, 'unverified.test');
});
afterEach(() => vi.useRealTimers());

describe('creating a member', () => {
  it('makes a native account at username@domain with no password, and mails a week-long link to the backup email', async () => {
    const { user, account, pending, link } = await create({ username: 'Bea.Lin' });
    expect(user).toMatchObject({ email: 'bea.lin@acme.test', displayName: 'Bea Lin' });
    expect(account).toMatchObject({ address: 'bea.lin@acme.test', kind: 'native', role: 'member', organizationId: org, state: 'active' });
    expect(core.accountByAddress('bea.lin@acme.test')!.id).toBe(account.id);
    const mail = sent.at(-1)!;
    expect(mail.to).toBe('bea@gmail.example');
    expect(mail.subject).toBe('Set up your Flow account in Acme');
    expect(mail.text).toContain('bea.lin@acme.test');
    expect(mail.text).toContain('Ann created');
    expect(link).toBeTruthy();
    expect(pending).toMatchObject({ accountId: account.id, address: 'bea.lin@acme.test', backupEmail: 'bea@gmail.example' });
    expect(Date.parse(pending.linkExpiresAt!) - Date.now()).toBeGreaterThan(7 * DAY - 60_000);
    // No password opens it yet.
    await expect(core.login('bea.lin@acme.test', '')).rejects.toThrow('invalid email or password');
  });

  it('defaults to the platform domain too, and sends a native account to be provisioned when hosted mail is on', () => {
    const hosted = new DirectoryCore(nodeSql(), { webUrlBase: 'https://app.test', registrationEnabled: true, send: async () => {}, provisioning: true });
    const o = newId();
    hosted.reserveSlug('beta', o);
    const { account } = hosted.createMember(o, input({ domain: hosted.primaryDomainOf(o) }));
    expect(account).toMatchObject({ address: 'bea@beta.freeflow.im', state: 'requested' });
    expect(hosted.takeProvisioning()).toEqual([{ kind: 'provision', organizationId: o, accountId: account.id }]);
  });

  it('keeps the account and its address through the Org object\'s join', async () => {
    const { user, account } = await create();
    expect(core.ensureAccount(user.id, org, 'member', 'Bea Lin', 'native')).toMatchObject({ id: account.id, address: 'bea@acme.test' });
    await core.applyOrgChanges(org, [{ kind: 'join', id: org, user_id: user.id, role: 'member', payload: null }]);
    expect(core.accountsOf(user.id)).toHaveLength(1);
  });

  it('discards a member whose row could not be written, freeing the address', () => {
    const { user } = core.createMember(org, input());
    core.discardCreatedMember(org, user.id);
    expect(core.accountByAddress('bea@acme.test')).toBeNull();
    expect(core.createMember(org, input()).account.address).toBe('bea@acme.test');
  });
});

describe('validation', () => {
  const refused = (over: Parameters<typeof input>[0], code: string, status = 400) =>
    expect(() => core.createMember(org, input(over))).toThrow(expect.objectContaining({ statusCode: status, code }));

  it('refuses a bad or reserved username', () => {
    refused({ username: 'bad name' }, 'invalid_username');
    refused({ username: '.bea' }, 'invalid_username');
    refused({ username: 'be..a' }, 'invalid_username');
    refused({ username: 'bea@acme.test' }, 'invalid_username');
    refused({ username: 'x'.repeat(65) }, 'invalid_username');
    refused({ username: 'postmaster' }, 'username_reserved');
  });

  it('refuses a username taken in the domain, by a member, an address or a login', async () => {
    await create();
    refused({ username: 'BEA', backupEmail: 'other@example.com' }, 'username_taken', 409);
    sql.exec("INSERT INTO users (id, email, password_hash, display_name, created_at) VALUES ('u9', 'carl@acme.test', 'x', 'Carl', 1)");
    refused({ username: 'carl' }, 'username_taken', 409);
    // The same name on another of the organization's domains is free.
    expect(core.createMember(org, input({ domain: core.primaryDomainOf(org) })).account.address).toBe('bea@acme.freeflow.im');
  });

  it('refuses a domain that is not the organization\'s, or not verified', () => {
    refused({ domain: 'elsewhere.test' }, 'invalid_domain');
    refused({ domain: 'unverified.test' }, 'domain_unverified');
    const other = newId();
    core.reserveSlug('other', other);
    refused({ domain: 'other.freeflow.im' }, 'invalid_domain');
  });

  it('refuses an invalid backup email, or one on the organization\'s own domains', () => {
    refused({ backupEmail: 'not-an-email' }, 'invalid_backup_email');
    refused({ backupEmail: 'bea@acme.test' }, 'backup_email_on_domain');
    refused({ backupEmail: 'bea@mail.acme.test' }, 'backup_email_on_domain');
    refused({ backupEmail: 'bea@acme.freeflow.im' }, 'backup_email_on_domain');
    refused({ displayName: '  ' }, 'invalid_display_name');
  });
});

describe('the setup link', () => {
  it('shows the address, then sets the password, verifies the account and signs in, once', async () => {
    const { link, user } = await create();
    expect(await core.setupInfo(link)).toEqual({ email: 'bea@acme.test', displayName: 'Bea Lin' });
    const res = await core.completeSetup(link, 'a-good-password');
    expect(res.user.id).toBe(user.id);
    expect((await core.authenticate(res.token)).user.id).toBe(user.id);
    expect((await core.login('bea@acme.test', 'a-good-password')).user.id).toBe(user.id);
    await expect(core.completeSetup(link, 'another-password')).rejects.toThrow('invalid or has expired');
    await expect(core.setupInfo(link)).rejects.toThrow('invalid or has expired');
    expect(core.pendingSetups(org)).toEqual([]);
  });

  it('is not a reset link, nor a reset link a setup link', async () => {
    const { link } = await create();
    await expect(core.resetPassword(link, 'a-good-password')).rejects.toThrow('invalid or expired reset link');
    await core.forgotPassword('bea@acme.test');
    await expect(core.completeSetup(linkIn(sent.at(-1)!, 'reset'), 'a-good-password')).rejects.toThrow('invalid or has expired');
  });

  it('lasts seven days', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { link } = await create();
    vi.setSystemTime(Date.now() + 7 * DAY - 60_000);
    expect((await core.setupInfo(link)).email).toBe('bea@acme.test');
    vi.setSystemTime(Date.now() + 2 * 60_000);
    await expect(core.setupInfo(link)).rejects.toThrow('invalid or has expired');
    await expect(core.completeSetup(link, 'a-good-password')).rejects.toThrow('invalid or has expired');
    // Still pending, with no live link: the Admin list offers Resend.
    expect(core.pendingSetups(org)).toEqual([expect.objectContaining({ address: 'bea@acme.test', linkExpiresAt: null })]);
  });

  it('resends a fresh week-long link that replaces the last', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const { link, account } = await create();
    vi.setSystemTime(Date.now() + 6 * DAY);
    const again = await core.sendSetupLink(org, account.id);
    const fresh = linkIn(sent.at(-1)!, 'setup');
    expect(sent.at(-1)!.to).toBe('bea@gmail.example');
    expect(fresh).not.toBe(link);
    expect(Date.parse(again.linkExpiresAt!) - Date.now()).toBeGreaterThan(7 * DAY - 60_000);
    await expect(core.setupInfo(link)).rejects.toThrow('invalid or has expired');
    vi.setSystemTime(Date.now() + 3 * DAY);
    expect((await core.completeSetup(fresh, 'a-good-password')).user.email).toBe('bea@acme.test');
  });

  it('is not resent once the password is set, nor for another organization\'s account', async () => {
    const { link, account } = await create();
    await expect(core.sendSetupLink(newId(), account.id)).rejects.toThrow(expect.objectContaining({ code: 'not_pending' }));
    await core.completeSetup(link, 'a-good-password');
    await expect(core.sendSetupLink(org, account.id)).rejects.toThrow(expect.objectContaining({ statusCode: 409, code: 'not_pending' }));
  });
});

describe('forgot password', () => {
  it('reaches the backup email as well as the address, with one link', async () => {
    const { link } = await create();
    await core.completeSetup(link, 'a-good-password');
    sent = [];
    await core.forgotPassword('bea@acme.test');
    expect(sent.map((m) => m.to)).toEqual(['bea@acme.test', 'bea@gmail.example']);
    expect(sent[1]!.text).toContain('your Flow account bea@acme.test');
    const token = linkIn(sent[1]!, 'reset');
    expect(linkIn(sent[0]!, 'reset')).toBe(token);
    await core.resetPassword(token, 'a-new-password');
    expect((await core.login('bea@acme.test', 'a-new-password')).user.email).toBe('bea@acme.test');
  });

  it('lets a member who never used the setup link in, and ends their pending setup', async () => {
    const { link } = await create();
    await core.forgotPassword('bea@acme.test');
    await core.resetPassword(linkIn(sent.at(-1)!, 'reset'), 'a-good-password');
    expect(core.pendingSetups(org)).toEqual([]);
    await expect(core.setupInfo(link)).rejects.toThrow('invalid or has expired');
  });

  it('mails only the address for an account with no backup email', async () => {
    await core.register('ann@example.com');
    await core.completeSignup(linkIn(sent.at(-1)!, 'signup'), 'Ann', 'pw-pw-pw-pw');
    sent = [];
    await core.forgotPassword('ann@example.com');
    expect(sent.map((m) => m.to)).toEqual(['ann@example.com']);
  });
});
