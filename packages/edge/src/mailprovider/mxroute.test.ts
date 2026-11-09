// The MXRoute client against a fake fetch: each request as the OpenAPI document has it, each answer from its examples.
import { describe, expect, it } from 'vitest';
import { MxRouteMailProvider, relayHost } from './mxroute';
import { ProviderError } from './provider';
import { recordsFor, type Resolve } from '../directory/dns';

interface Sent { url: string; method: string; headers: Record<string, string>; body?: Record<string, unknown> }

/** A fetch that records each request and answers from the queue, `{ success: true }` when it is empty. */
function fakeFetch(answers: { status?: number; body?: unknown; headers?: Record<string, string> }[] = []) {
  const sent: Sent[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    sent.push({ url, method: init.method!, headers: init.headers as Record<string, string>, ...(init.body ? { body: JSON.parse(init.body as string) } : {}) });
    const a = answers.shift() ?? { body: { success: true } };
    const body = a.status === 204 ? null : typeof a.body === 'string' ? a.body : JSON.stringify(a.body ?? { success: true });
    return new Response(body, { status: a.status ?? 200, headers: { 'content-type': 'application/json', ...(a.headers ?? {}) } });
  }) as unknown as typeof fetch;
  return { sent, fn };
}

const CFG = { server: 'sunfire.mxrouting.net', username: 'exampleuser', apiKey: 'MxEXAMPLEKEY0000000000000000test' };
let n = 0;
/** Each provider under its own username, so the module cache of keys and DNS info is per test. */
const make = (fn: typeof fetch, extra: Partial<ConstructorParameters<typeof MxRouteMailProvider>[0]> = {}) =>
  new MxRouteMailProvider({ ...CFG, username: `${CFG.username}${n++}`, fetch: fn, ...extra });

const KEY = '_da-verify-a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4';
const KEY_ANSWER = { success: true, data: { key: KEY, record: { type: 'TXT', name: KEY, value: 'domain-verified' } } };
const NOT_FOUND = { status: 404, body: { success: false, error: { code: 'NOT_FOUND', message: 'Resource not found' } } };
const CONFLICT = { status: 409, body: { success: false, error: { code: 'CONFLICT', message: 'Domain already exists' } } };
const DNS_INFO = {
  success: true,
  data: {
    mx_records: [{ priority: 10, hostname: 'sunfire.mxrouting.net', description: 'Primary' }, { priority: 20, hostname: 'sunfire-relay.mxrouting.net', description: 'Backup' }],
    spf: { type: 'TXT', name: '@', value: 'v=spf1 include:mxroute.com -all' },
    dkim: { type: 'TXT', name: 'x._domainkey', value: 'v=DKIM1; k=rsa; p=MIIB' },
    verification: { type: 'TXT', name: KEY, value: 'domain-verified' },
  },
};
const paths = (sent: Sent[]) => sent.map((s) => `${s.method} ${new URL(s.url).pathname}`);

describe('MXRoute requests', () => {
  it('sends the three headers to api.mxroute.com and JSON only with a body', async () => {
    const { sent, fn } = fakeFetch([{ status: 204 }]);
    const p = make(fn);
    await p.deleteMailbox('ann@acme.test');
    expect(sent).toEqual([{
      url: 'https://api.mxroute.com/domains/acme.test/email-accounts/ann',
      method: 'DELETE',
      headers: { 'x-server': CFG.server, 'x-username': p['cfg'].username, 'x-api-key': CFG.apiKey, accept: 'application/json' },
    }]);
    const other = fakeFetch([{ status: 204 }]);
    await make(other.fn, { apiUrl: 'https://mx.example.test/v1/' }).deleteDomain('acme.test');
    expect(other.sent[0]!.url).toBe('https://mx.example.test/v1/domains/acme.test');
  });

  it('makes a mailbox with the local part, the password and the quota in MB; an existing one is done', async () => {
    const { sent, fn } = fakeFetch([{ status: 201, body: { success: true, data: {} } }, CONFLICT]);
    const p = make(fn);
    await p.createMailbox({ address: 'Ann@acme.test', displayName: 'Ann', password: 'Passw0rd-with-32-characters-ok!', quotaBytes: 5 * 1024 ** 3 });
    await p.createMailbox({ address: 'Ann@acme.test', displayName: 'Ann', password: 'Passw0rd-with-32-characters-ok!', quotaBytes: 5 * 1024 ** 3 });
    expect(paths(sent)).toEqual(['POST /domains/acme.test/email-accounts', 'POST /domains/acme.test/email-accounts']);
    expect(sent[0]!.headers['content-type']).toBe('application/json');
    expect(sent[0]!.body).toEqual({ username: 'Ann', password: 'Passw0rd-with-32-characters-ok!', quota: 5120 });
  });

  it('refuses a password MXRoute would, before any request', async () => {
    const { sent, fn } = fakeFetch();
    const p = make(fn);
    await expect(p.createMailbox({ address: 'a@x.test', displayName: 'A', password: 'short7!', quotaBytes: 1 })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(p.setPassword('a@x.test', 'x'.repeat(73))).rejects.toMatchObject({ code: 'bad_request' });
    await expect(p.setPassword('not-an-address', 'longenough')).rejects.toMatchObject({ code: 'bad_request' });
    expect(sent).toHaveLength(0);
  });

  it('changes a password with PATCH, which does not create, so a missing mailbox is not found', async () => {
    const { sent, fn } = fakeFetch([{ body: { success: true } }, NOT_FOUND]);
    const p = make(fn);
    await p.setPassword('ann@acme.test', 'new-password-1');
    expect(paths(sent)).toEqual(['PATCH /domains/acme.test/email-accounts/ann']);
    expect(sent[0]!.body).toEqual({ password: 'new-password-1' });
    await expect(p.setPassword('gone@acme.test', 'new-password-1')).rejects.toMatchObject({ code: 'not_found' });
  });

  it('suspends by setting a password nobody has, and resumes only a mailbox that exists', async () => {
    const { sent, fn } = fakeFetch([{ body: { success: true } }, { body: { success: true, data: { username: 'ann', suspended: false } } }, NOT_FOUND]);
    const p = make(fn);
    expect(p.suspendsByPassword).toBe(true);
    await p.setMailboxState('ann@acme.test', 'suspended');
    expect(paths(sent)).toEqual(['PATCH /domains/acme.test/email-accounts/ann']);
    expect(sent[0]!.body!.password).toMatch(/^[A-Za-z0-9]{32}$/);
    await p.setMailboxState('ann@acme.test', 'enabled');
    expect(paths(sent)[1]).toBe('GET /domains/acme.test/email-accounts/ann');
    await expect(p.setMailboxState('gone@acme.test', 'enabled')).rejects.toMatchObject({ code: 'not_found' });
    expect(sent).toHaveLength(3);
  });

  it('reads a mailbox, its quota in MB and its suspended flag; 0 is unlimited; a missing one does not exist', async () => {
    const { fn } = fakeFetch([
      { body: { success: true, data: { username: 'ann', email: 'ann@acme.test', quota: 1024, usage: 256.5, suspended: false } } },
      { body: { success: true, data: { username: 'bob', quota: 0, suspended: true } } },
      NOT_FOUND,
    ]);
    const p = make(fn);
    expect(await p.getMailbox('ann@acme.test')).toEqual({ exists: true, state: 'enabled', quotaBytes: 1024 * 1024 ** 2 });
    expect(await p.getMailbox('bob@acme.test')).toEqual({ exists: true, state: 'suspended' });
    expect(await p.getMailbox('nobody@acme.test')).toEqual({ exists: false });
  });

  it('deletes mailboxes and domains, taking 404 as done', async () => {
    const { sent, fn } = fakeFetch([NOT_FOUND, { status: 204 }]);
    const p = make(fn);
    await p.deleteMailbox('gone@acme.test');
    await p.deleteDomain('acme.test');
    expect(paths(sent)).toEqual(['DELETE /domains/acme.test/email-accounts/gone', 'DELETE /domains/acme.test']);
  });

  it('cannot be given a DKIM key: MXRoute makes its own', async () => {
    const p = make(fakeFetch().fn);
    expect(p.managesDkim).toBe(true);
    await expect(p.setDkim('acme.test', 's', 'pem')).rejects.toMatchObject({ code: 'bad_request' });
  });
});

describe('MXRoute domains', () => {
  const zone = (records: Record<string, string[]>): Resolve => async (name, type) => records[`${type} ${name}`] ?? [];

  it('adds a domain once its ownership TXT is in DNS, and leaves one MXRoute has alone', async () => {
    const { sent, fn } = fakeFetch([NOT_FOUND, { body: KEY_ANSWER }, { status: 201, body: { success: true, data: { domain: 'acme.test' } } }, { body: DNS_INFO }]);
    const p = make(fn, { resolve: zone({ [`TXT ${KEY}.acme.test`]: ['domain-verified'] }) });
    await p.createDomain('acme.test', { quotaBytes: 1, maxUsers: 1 });
    expect(paths(sent)).toEqual(['GET /domains/acme.test/dns', 'GET /verification-key', 'POST /domains']);
    expect(sent[2]!.body).toEqual({ domain: 'acme.test' });
    await p.createDomain('acme.test', { quotaBytes: 1, maxUsers: 1 });
    expect(paths(sent).slice(3)).toEqual(['GET /domains/acme.test/dns']);
  });

  it('is pending while the TXT is missing, from our lookup first and from the refusal otherwise; a 409 is done', async () => {
    const { sent, fn } = fakeFetch([NOT_FOUND, { body: KEY_ANSWER }]);
    const p = make(fn, { resolve: zone({}) });
    await expect(p.createDomain('acme.test', { quotaBytes: 1, maxUsers: 1 })).rejects.toMatchObject({ code: 'pending', message: `the record TXT ${KEY}.acme.test = domain-verified is not in DNS yet` });
    expect(paths(sent)).toEqual(['GET /domains/acme.test/dns', 'GET /verification-key']);
    const refused = fakeFetch([NOT_FOUND, { body: KEY_ANSWER }, { status: 400, body: { success: false, error: { code: 'VALIDATION_ERROR', message: 'Domain ownership verification required' } } }, NOT_FOUND, CONFLICT]);
    const q = make(refused.fn);
    await expect(q.createDomain('acme.test', { quotaBytes: 1, maxUsers: 1 })).rejects.toMatchObject({ code: 'pending' });
    await q.createDomain('acme.test', { quotaBytes: 1, maxUsers: 1 });
    expect(paths(refused.sent)).toEqual(['GET /domains/acme.test/dns', 'GET /verification-key', 'POST /domains', 'GET /domains/acme.test/dns', 'POST /domains']);
  });

  it('lists the ownership TXT, the server and its relay as MX, and the include before the domain is at MXRoute', async () => {
    const { sent, fn } = fakeFetch([{ body: KEY_ANSWER }, NOT_FOUND]);
    const p = make(fn);
    const r = await p.records('acme.test', { selector: 'ff202611', value: 'v=DKIM1; k=rsa; p=OURS' });
    expect(r).toEqual({
      mx: [{ host: 'sunfire.mxrouting.net', priority: 10 }, { host: 'sunfire-relay.mxrouting.net', priority: 20 }],
      spfInclude: 'mxroute.com',
      dmarcPolicy: 'v=DMARC1; p=none',
      verification: { name: `${KEY}.acme.test`, value: 'domain-verified' },
    });
    expect(recordsFor('acme.test', r, 'freeflow-verify=abc').map((x) => [x.purpose, x.name])).toEqual([
      ['verification', '_freeflow.acme.test'], ['provider', `${KEY}.acme.test`], ['mx', 'acme.test'], ['mx', 'acme.test'], ['spf', 'acme.test'], ['dmarc', '_dmarc.acme.test'],
    ]);
    // The key and the DNS info are reused.
    await p.records('acme.test');
    expect(paths(sent)).toEqual(['GET /verification-key', 'GET /domains/acme.test/dns']);
    expect(relayHost('eagle.mxlogin.com')).toBe('eagle-relay.mxlogin.com');
  });

  it('takes the MX, SPF and DKIM from the DNS info once the domain is there', async () => {
    const { fn } = fakeFetch([{ body: KEY_ANSWER }, { body: DNS_INFO }]);
    const r = await make(fn).records('acme.test');
    expect(r.mx).toEqual([{ host: 'sunfire.mxrouting.net', priority: 10 }, { host: 'sunfire-relay.mxrouting.net', priority: 20 }]);
    expect(r.dkim).toEqual({ selector: 'x', value: 'v=DKIM1; k=rsa; p=MIIB' });
    expect(recordsFor('acme.test', r).at(-1)).toEqual({ type: 'TXT', name: 'x._domainkey.acme.test', value: 'v=DKIM1; k=rsa; p=MIIB', purpose: 'dkim' });
    const full = fakeFetch([{ body: KEY_ANSWER }, { body: { success: true, data: { ...DNS_INFO.data, dkim: { name: 'x._domainkey.acme.test.', value: 'v=DKIM1; p=A' } } } }]);
    expect((await make(full.fn).records('acme.test')).dkim).toEqual({ selector: 'x', value: 'v=DKIM1; p=A' });
  });

  it('connects mailboxes to the server over TLS, or the host given', () => {
    const p = make(fakeFetch().fn);
    expect(p.mailSettings('ann@acme.test')).toEqual({
      imap: { host: 'sunfire.mxrouting.net', port: 993, security: 'tls', username: 'ann@acme.test' },
      smtp: { host: 'sunfire.mxrouting.net', port: 465, security: 'tls', username: 'ann@acme.test' },
    });
    expect(make(fakeFetch().fn, { mailHost: 'mail.acme.test' }).mailSettings('x@y.z').smtp.host).toBe('mail.acme.test');
  });
});

describe('MXRoute errors', () => {
  const failing = async (answer: { status?: number; body?: unknown; headers?: Record<string, string> }) => {
    const { fn } = fakeFetch([answer]);
    return make(fn).setPassword('ann@acme.test', 'long-enough-pw').then(() => null, (e: unknown) => e as ProviderError);
  };

  it('maps the error codes and HTTP statuses to the provider codes', async () => {
    expect(await failing({ status: 401, body: { success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid API credentials' } } })).toMatchObject({ code: 'auth', message: 'mxroute PATCH /domains/acme.test/email-accounts/ann: Invalid API credentials' });
    expect(await failing({ status: 403, body: { success: false, error: { code: 'FORBIDDEN', message: 'no' } } })).toMatchObject({ code: 'auth' });
    expect(await failing({ status: 400, body: { success: false, error: { code: 'VALIDATION_ERROR', message: 'weak', field: 'password' } } })).toMatchObject({ code: 'bad_request' });
    expect(await failing({ status: 400, body: { success: false, error: { code: 'BUSINESS_ERROR', message: 'limit reached' } } })).toMatchObject({ code: 'bad_request' });
    expect(await failing({ status: 429, body: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests' } }, headers: { 'retry-after': '17' } })).toMatchObject({ code: 'rate_limited', providerCode: 17 });
    expect(await failing({ status: 500, body: { success: false, error: { code: 'SERVER_ERROR', message: 'boom' } } })).toMatchObject({ code: 'unavailable' });
    expect(await failing({ status: 502, body: '<html>bad gateway</html>' })).toMatchObject({ code: 'unavailable' });
    expect(await failing({ status: 200, body: 'not json' })).toMatchObject({ code: 'unavailable' });
    expect(await failing({ status: 422, body: { success: false, error: { message: 'no package' } } })).toMatchObject({ code: 'bad_request' });
  });

  it('never carries the key, even when the provider echoes it', async () => {
    const e = await failing({ status: 401, body: { success: false, error: { code: 'UNAUTHORIZED', message: `bad key ${CFG.apiKey}` } } });
    expect(e!.message).not.toContain(CFG.apiKey);
    expect(e!.message).toContain('[redacted]');
    const down = await make((async () => { throw new Error(`connect with ${CFG.apiKey} failed`); }) as unknown as typeof fetch).deleteDomain('x.test').catch((x: ProviderError) => x);
    expect(down).toMatchObject({ code: 'unavailable' });
    expect((down as Error).message).not.toContain(CFG.apiKey);
  });
});
