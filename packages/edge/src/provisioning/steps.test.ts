import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AccountDTO } from '@flow/shared';
import { DirectoryCore, newId, type ProvisioningMessage, type Sql } from '../directory/core';
import { FakeMailProvider } from '../mailprovider/fake';
import { ProviderError } from '../mailprovider/provider';
import type { HostedMailbox } from '../imap/object';
import { classify, mailboxPassword, runMessage, type ProvisioningDeps } from './steps';

function nodeSql(): Sql {
  const db = new DatabaseSync(':memory:');
  return {
    exec(query: string, ...args: unknown[]) {
      if (!args.length && query.trim().replace(/;$/, '').includes(';')) { db.exec(query); return { toArray: () => [] }; }
      const stmt = db.prepare(query);
      const rows = stmt.columns().length ? stmt.all(...(args as never[])) : (stmt.run(...(args as never[])), []);
      return { toArray: () => rows as Record<string, unknown>[] };
    },
  };
}

let core: DirectoryCore;
let provider: FakeMailProvider;
let mail: Map<string, HostedMailbox>;
let calendars: Set<string>;
let dns: string[];
let deps: ProvisioningDeps;

/** A principal straight into the directory's table, and its join to the organization. */
function user(name: string, agentUsername?: string): string {
  const id = newId();
  (core as unknown as { sql: Sql }).sql.exec('INSERT INTO users (id, email, password_hash, display_name, is_agent, agent_username, created_at) VALUES (?, ?, ?, ?, ?, ?, 1)',
    id, `${id}@example.com`, 'x', name, agentUsername ? 1 : 0, agentUsername ?? null);
  return id;
}
const join = (org: string, userId: string, role = 'member') => core.ensureAccount(userId, org, role);
const leave = (org: string, userId: string) => core.applyOrgChanges(org, [{ kind: 'leave', id: org, user_id: userId, role: null, payload: null }]);
/** Runs every message the directory has sent, as the Queue would, until none is left. */
async function drain(): Promise<ProvisioningMessage[]> {
  const ran: ProvisioningMessage[] = [];
  for (let out = core.takeProvisioning(); out.length; out = core.takeProvisioning()) {
    for (const m of out) { ran.push(m); await runMessage(m, deps); }
  }
  return ran;
}

beforeEach(() => {
  provider = new FakeMailProvider();
  core = new DirectoryCore(nodeSql(), { webUrlBase: 'https://app.test', registrationEnabled: true, send: async () => {}, mailProvider: provider, provisioning: true });
  mail = new Map();
  calendars = new Set();
  dns = [];
  deps = {
    provider,
    directory: {
      target: async (id) => core.provisioningTarget(id),
      setState: async (id, state, message = null) => core.setAccountState(id, state, message),
      setHosted: async (id, hosted) => core.setHosted(id, hosted),
      setDomainAtProvider: async (d) => core.setDomainAtProvider(d),
    },
    mail: {
      hosted: async (a: AccountDTO) => (mail.has(a.id) ? { id: `m-${a.id}`, email: mail.get(a.id)!.email } : null),
      put: async (a, m) => void mail.set(a.id, m),
      clear: async (a) => void mail.delete(a.id),
    },
    calendar: { ensureNative: async (a) => void calendars.add(a.id) },
    publishPlatformDns: async (slug) => void dns.push(slug),
  };
});

describe('provisioning (platform.md §3.4)', () => {
  it('runs a new account from requested to active: the domain, the mailbox, the sealed row, the calendar', async () => {
    const org = newId();
    core.reserveSlug('acme', org);
    const ann = join(org, user('Ann'), 'owner');
    expect(ann.state).toBe('requested');
    expect(await drain()).toEqual([{ kind: 'provision', organizationId: org, accountId: ann.id }]);
    expect(core.accountById(ann.id)).toMatchObject({ state: 'active', statusMessage: null });
    expect(provider.domains.has('acme.freeflow.im')).toBe(true);
    expect(dns).toEqual(['acme']);
    const box = provider.mailboxes.get('ann@acme.freeflow.im')!;
    expect(box.state).toBe('enabled');
    expect(mail.get(ann.id)).toMatchObject({ email: 'ann@acme.freeflow.im', password: box.password, imap: { host: '127.0.0.1', port: 3143 } });
    expect(box.password).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(calendars.has(ann.id)).toBe(true);
    expect(core.provisioningTarget(ann.id)!.hosted).toBe(true);
    // A second member: the domain is not made again, nor its DNS written.
    join(org, user('Bob'));
    await drain();
    expect(provider.calls.filter((c) => c.method === 'createDomain')).toHaveLength(1);
    expect(dns).toEqual(['acme']);
  });

  it('gives an agent the same path, at its own address', async () => {
    const org = newId();
    core.reserveSlug('acme', org);
    const bot = join(org, user('Builder', 'builder'));
    await drain();
    expect(core.accountById(bot.id)).toMatchObject({ address: 'builder@acme.freeflow.im', state: 'active' });
    expect(mail.get(bot.id)?.email).toBe('builder@acme.freeflow.im');
  });

  it('is safe to run again after a partial run: the mailbox made but not written gets a new password', async () => {
    const org = newId();
    core.reserveSlug('acme', org);
    const ann = join(org, user('Ann'));
    const [msg] = core.takeProvisioning();
    const put = deps.mail.put;
    deps.mail.put = async () => { throw new Error('the Mail object is away'); };
    await expect(runMessage(msg!, deps)).rejects.toThrow('away');
    expect(core.accountById(ann.id)!.state).toBe('requested');
    expect(provider.mailboxes.has('ann@acme.freeflow.im')).toBe(true);
    deps.mail.put = put;
    await runMessage(msg!, deps);
    expect(provider.calls.filter((c) => c.method === 'createMailbox')).toHaveLength(1);
    expect(provider.calls.some((c) => c.method === 'setPassword')).toBe(true);
    expect(mail.get(ann.id)!.password).toBe(provider.mailboxes.get('ann@acme.freeflow.im')!.password);
    expect(core.accountById(ann.id)!.state).toBe('active');
    await runMessage(msg!, deps);
    expect(provider.calls.filter((c) => c.method === 'createMailbox' || c.method === 'setPassword')).toHaveLength(2);
  });

  it('waits on an own domain that is not verified, and says why', async () => {
    const org = newId();
    core.reserveSlug('acme', org);
    const ann = join(org, user('Ann'));
    (core as unknown as { sql: Sql }).sql.exec("INSERT INTO domains (domain, organization_id, kind, created_at) VALUES ('acme.test', ?, 'own', 1)", org);
    (core as unknown as { sql: Sql }).sql.exec("UPDATE accounts SET address = 'ann@acme.test' WHERE id = ?", ann.id);
    const [msg] = core.takeProvisioning();
    const err = await runMessage(msg!, deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(classify(err)).toBe('stop');
    expect(core.accountById(ann.id)!.state).toBe('requested');
  });

  it('suspends on removal, resumes on a rejoin, and deletes after the retention period', async () => {
    const org = newId();
    core.reserveSlug('acme', org);
    const bobId = user('Bob');
    const bob = join(org, bobId);
    await drain();
    await leave(org, bobId);
    expect(core.accountById(bob.id)!.state).toBe('removed');
    expect((await drain()).map((m) => m.kind)).toEqual(['suspend']);
    expect(provider.mailboxes.get('bob@acme.freeflow.im')!.state).toBe('suspended');
    expect(core.provisioningTarget(bob.id)!.removedAt).not.toBeNull();
    join(org, bobId);
    expect((await drain()).map((m) => m.kind)).toEqual(['resume']);
    expect(core.accountById(bob.id)!.state).toBe('active');
    expect(provider.mailboxes.get('bob@acme.freeflow.im')!.state).toBe('enabled');
    await leave(org, bobId);
    await drain();
    expect(core.sweepRemoved(org, 30)).toBe(0);
    (core as unknown as { sql: Sql }).sql.exec('UPDATE accounts SET removed_at = ? WHERE id = ?', Date.now() - 31 * 86_400_000, bob.id);
    expect(core.sweepRemoved(org, 30)).toBe(1);
    expect((await drain()).map((m) => m.kind)).toEqual(['delete']);
    expect(provider.mailboxes.has('bob@acme.freeflow.im')).toBe(false);
    expect(mail.has(bob.id)).toBe(false);
    expect(core.sweepRemoved(org, 30)).toBe(0);
    // Back after the deletion: a new mailbox, from requested.
    expect(join(org, bobId).state).toBe('requested');
    await drain();
    expect(core.accountById(bob.id)!.state).toBe('active');
    expect(provider.mailboxes.get('bob@acme.freeflow.im')!.state).toBe('enabled');
  });

  it('publishes the platform zone before the domain is made, retries a pending platform domain, and stops on a pending own one', async () => {
    const order: string[] = [];
    let pending = true;
    const createDomain = provider.createDomain.bind(provider);
    provider.createDomain = async (d, o) => { order.push('createDomain'); if (pending) throw new ProviderError('pending', 'TXT missing'); return createDomain(d, o); };
    deps.publishPlatformDns = async (slug) => { order.push('dns'); dns.push(slug); };
    const org = newId();
    core.reserveSlug('acme', org);
    const ann = join(org, user('Ann'));
    const [msg] = core.takeProvisioning();
    const err = await runMessage(msg!, deps).catch((e: unknown) => e);
    expect(classify(err)).toBe('retry');
    expect(order).toEqual(['dns', 'createDomain']);
    pending = false;
    await runMessage(msg!, deps);
    expect(core.accountById(ann.id)!.state).toBe('active');
    // The organization's own domain: the admin has to publish the provider's record, so it is a stop with the message.
    pending = true;
    const bob = join(org, user('Bob'));
    (core as unknown as { sql: Sql }).sql.exec("INSERT INTO domains (domain, organization_id, kind, verified_at, created_at) VALUES ('acme.test', ?, 'own', 1, 1)", org);
    (core as unknown as { sql: Sql }).sql.exec("UPDATE accounts SET address = 'bob@acme.test' WHERE id = ?", bob.id);
    const own = await runMessage(core.takeProvisioning()[0]!, deps).catch((e: unknown) => e);
    expect(own).toMatchObject({ code: 'bad_request', message: 'TXT missing' });
    expect(classify(own)).toBe('stop');
  });

  it('gives a mailbox a fresh password on resume when the provider suspends by password', async () => {
    (provider as { suspendsByPassword?: boolean }).suspendsByPassword = true;
    const org = newId();
    core.reserveSlug('acme', org);
    const bobId = user('Bob');
    const bob = join(org, bobId);
    await drain();
    const before = mail.get(bob.id)!.password;
    await leave(org, bobId);
    await drain();
    join(org, bobId);
    expect((await drain()).map((m) => m.kind)).toEqual(['resume']);
    const after = mail.get(bob.id)!.password;
    expect(after).not.toBe(before);
    expect(after).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(provider.mailboxes.get('bob@acme.freeflow.im')!.password).toBe(after);
    expect(provider.calls.filter((c) => c.method === 'setPassword')).toHaveLength(1);
  });

  it('sends existing members without a mailbox, and counts them', async () => {
    const plain = new DirectoryCore(nodeSql(), { webUrlBase: 'https://app.test', registrationEnabled: true, send: async () => {} });
    expect(() => plain.provisionMissing(newId())).toThrow(/no mail provider/);
    const org = newId();
    core.reserveSlug('acme', org);
    const ann = join(org, user('Ann'));
    core.takeProvisioning();
    core.setAccountState(ann.id, 'active');
    expect(core.provisionMissing(org)).toBe(1);
    await drain();
    expect(core.accountById(ann.id)!.state).toBe('active');
    expect(mail.has(ann.id) && calendars.has(ann.id)).toBe(true);
    expect(core.provisionMissing(org)).toBe(0);
  });

  it('sends one account on its own, and not one that has a mailbox or is gone', async () => {
    const org = newId();
    core.reserveSlug('acme', org);
    const ann = join(org, user('Ann'));
    const bob = join(org, user('Bob'));
    core.takeProvisioning();
    core.setAccountState(ann.id, 'active');
    core.setAccountState(bob.id, 'active');
    expect(core.provisionAccount(ann.id)).toBe(true);
    expect(core.provisionAccount(newId())).toBe(false);
    expect((await drain()).map((m) => m.accountId)).toEqual([ann.id]);
    expect(mail.has(ann.id)).toBe(true);
    expect(mail.has(bob.id)).toBe(false);
    expect(core.provisionAccount(ann.id)).toBe(false);
    expect(core.provisionMissing(org)).toBe(1);
  });

  it('starts accounts active without a provider, and sends nothing', () => {
    const plain = new DirectoryCore(nodeSql(), { webUrlBase: 'https://app.test', registrationEnabled: true, send: async () => {} });
    core = plain;
    const org = newId();
    plain.reserveSlug('acme', org);
    expect(join(org, user('Ann')).state).toBe('active');
    expect(plain.takeProvisioning()).toEqual([]);
  });

  it('never provisions a guest: no address, active from the start, nothing sent, not counted by "everyone"', async () => {
    const org = newId();
    core.reserveSlug('acme', org);
    join(org, user('Ann'), 'owner');
    core.setPolicies(org, { defaultAccountKind: 'guest' });
    const gus = join(org, user('Gus'));
    expect(gus).toMatchObject({ kind: 'guest', address: null, state: 'active' });
    expect((await drain()).map((m) => m.accountId)).not.toContain(gus.id);
    expect(core.provisionMissing(org)).toBe(0);
    expect(core.provisionAccount(gus.id)).toBe(false);
    // A stray message for a guest changes nothing.
    await runMessage({ kind: 'provision', organizationId: org, accountId: gus.id }, deps);
    await runMessage({ kind: 'resume', organizationId: org, accountId: gus.id }, deps);
    expect(mail.has(gus.id) || calendars.has(gus.id)).toBe(false);
    expect(core.provisioningTarget(gus.id)).toMatchObject({ mailboxAddress: null, domain: null, hosted: false });
  });

  it('makes a guest native: a new address, a mailbox and a calendar, staying active', async () => {
    const org = newId();
    core.reserveSlug('acme', org);
    core.setPolicies(org, { defaultAccountKind: 'guest' });
    const gus = join(org, user('Gus'));
    await drain();
    const made = core.setAccountKind(org, gus.id, 'native');
    expect(made).toMatchObject({ kind: 'native', address: 'gus@acme.freeflow.im', state: 'active' });
    expect((await drain()).map((m) => m.kind)).toEqual(['provision']);
    expect(provider.mailboxes.get('gus@acme.freeflow.im')!.state).toBe('enabled');
    expect(mail.get(gus.id)?.email).toBe('gus@acme.freeflow.im');
    expect(calendars.has(gus.id)).toBe(true);
    expect(core.accountById(gus.id)!.state).toBe('active');
  });

  it('makes a native account a guest: the mailbox suspended now, its address held, deleted after the retention period', async () => {
    const org = newId();
    core.reserveSlug('acme', org);
    const bob = join(org, user('Bob'));
    await drain();
    const guest = core.setAccountKind(org, bob.id, 'guest');
    expect(guest).toMatchObject({ kind: 'guest', address: null, state: 'active' });
    expect(core.accountByAddress('bob@acme.freeflow.im')).toBeNull();
    expect((await drain()).map((m) => m.kind)).toEqual(['suspend']);
    expect(provider.mailboxes.get('bob@acme.freeflow.im')!.state).toBe('suspended');
    // The kept mailbox's address goes to nobody else while the mailbox is there.
    expect(join(org, user('Bob')).address).toBe('bob2@acme.freeflow.im');
    await drain();
    expect(core.sweepRemoved(org, 30)).toBe(0);
    (core as unknown as { sql: Sql }).sql.exec('UPDATE accounts SET kind_changed_at = ? WHERE id = ?', Date.now() - 31 * 86_400_000, bob.id);
    expect(core.sweepRemoved(org, 30)).toBe(1);
    expect((await drain()).map((m) => m.kind)).toEqual(['delete']);
    expect(provider.mailboxes.has('bob@acme.freeflow.im')).toBe(false);
    expect(mail.has(bob.id)).toBe(false);
    expect(core.provisioningTarget(bob.id)).toMatchObject({ hosted: false, mailboxAddress: null });
    expect(core.sweepRemoved(org, 30)).toBe(0);
    expect(join(org, user('Bob')).address).toBe('bob@acme.freeflow.im');
  });

  it('gives a guest back the address of its kept mailbox, resumed, when it is made native again', async () => {
    const org = newId();
    core.reserveSlug('acme', org);
    const bob = join(org, user('Bob'));
    await drain();
    core.setAccountKind(org, bob.id, 'guest');
    await drain();
    expect(core.setAccountKind(org, bob.id, 'native')).toMatchObject({ kind: 'native', address: 'bob@acme.freeflow.im' });
    expect((await drain()).map((m) => m.kind)).toEqual(['resume']);
    expect(provider.mailboxes.get('bob@acme.freeflow.im')!.state).toBe('enabled');
    expect(core.provisioningTarget(bob.id)).toMatchObject({ hosted: true, mailboxAddress: 'bob@acme.freeflow.im' });
  });

  it('retries a busy provider, stops on a refusal, and makes passwords within the rules', () => {
    expect(classify(new ProviderError('rate_limited', 'slow down'))).toBe('retry');
    expect(classify(new ProviderError('unavailable', 'down'))).toBe('retry');
    expect(classify(new ProviderError('pending', 'the TXT is not in DNS yet'))).toBe('retry');
    expect(classify(new ProviderError('auth', 'bad credential'))).toBe('stop');
    expect(classify(new ProviderError('bad_request', 'no'))).toBe('stop');
    expect(classify(new Error('boom'))).toBe('throw');
    const pws = Array.from({ length: 50 }, () => mailboxPassword());
    expect(pws.every((p) => /^[A-Za-z0-9]{32}$/.test(p) && /[a-z]/.test(p) && /[A-Z]/.test(p) && /\d/.test(p))).toBe(true);
    expect(new Set(pws).size).toBe(50);
  });
});
