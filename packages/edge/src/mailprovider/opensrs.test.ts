// The OpenSRS client against a fake fetch: each request as the guide's examples have it, each answer from them.
import { describe, expect, it } from 'vitest';
import { OpenSrsMailProvider, clusterOf } from './opensrs';
import { ProviderError } from './provider';
import { generateDkimKey } from './dkim';
import { recordsFor } from '../directory/dns';

interface Sent { url: string; method: string; headers: Record<string, string>; body: Record<string, unknown> }

/** A fetch that records each request and answers from the queue (JSON bodies with a status), `{ success: true }` when empty. */
function fakeFetch(answers: { status?: number; body: unknown }[] = []) {
  const sent: Sent[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    sent.push({ url, method: init.method!, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) });
    const a = answers.shift() ?? { body: { success: true } };
    return new Response(typeof a.body === 'string' ? a.body : JSON.stringify(a.body), { status: a.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { sent, fn };
}

const CREDS = { user: 'company_admin@freeflow.adm', password: 's3cret-admin-pw' };
const make = (fn: typeof fetch, extra: Partial<ConstructorParameters<typeof OpenSrsMailProvider>[0]> = {}) =>
  new OpenSrsMailProvider({ apiUrl: 'https://admin.test.hostedemail.com/api/', ...CREDS, fetch: fn, ...extra });

// From /docs/change_user Example 4 and /docs/get_user Example 3.
const EXISTS = { success: false, error_number: 23, error: 'Object already exists', audit: 'jewel30_50c235f127' };
const MISSING = { success: false, error_number: 2, error: 'The requested object does not exist' };

describe('OpenSRS requests', () => {
  it('posts JSON with the credentials to <base>/<method>', async () => {
    const { sent, fn } = fakeFetch();
    await make(fn).deleteMailbox('bhayden@example.com');
    expect(sent).toEqual([{
      url: 'https://admin.test.hostedemail.com/api/delete_user',
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: { credentials: CREDS, user: 'bhayden@example.com' },
    }]);
  });

  it('creates a domain with create_only and the platform\'s attributes, and takes "already exists" as done', async () => {
    const { sent, fn } = fakeFetch([{ body: { success: true } }, { body: EXISTS }]);
    const p = make(fn);
    await p.createDomain('acme.test', { quotaBytes: 5 * 1024 ** 3, maxUsers: 25 });
    await p.createDomain('acme.test', { quotaBytes: 5 * 1024 ** 3, maxUsers: 25 });
    expect(sent[0]!.url).toMatch(/\/api\/change_domain$/);
    expect(sent[0]!.body).toEqual({
      credentials: CREDS,
      domain: 'acme.test',
      create_only: true,
      attributes: {
        quota: 5368709120, limit_users: 25, default_password_encoding: 'BCRYPT',
        service_imap4: 'enabled', service_smtpin: 'enabled', service_smtprelay: 'enabled',
        service_webmail: 'disabled', service_pop3: 'disabled', service_smtprelay_webmail: 'disabled',
      },
    });
    expect(sent).toHaveLength(2);
  });

  it('sends the quota in megabytes when configured so', async () => {
    const { sent, fn } = fakeFetch();
    await make(fn, { quotaUnit: 'mb' }).createMailbox({ address: 'a@acme.test', displayName: 'Ann', password: 'pw-123', quotaBytes: 5 * 1024 ** 3 });
    expect((sent[0]!.body.attributes as { quota: number }).quota).toBe(5120);
  });

  it('creates a mailbox with change_user, create_only and type mailbox; existing is done', async () => {
    const { sent, fn } = fakeFetch([{ body: EXISTS }]);
    await make(fn).createMailbox({ address: 'bhayden@example.com', displayName: 'Bob Hayden', password: 'changeit', quotaBytes: 1024 });
    expect(sent[0]!.url).toMatch(/\/change_user$/);
    expect(sent[0]!.body).toEqual({
      credentials: CREDS, user: 'bhayden@example.com', create_only: true,
      attributes: { type: 'mailbox', name: 'Bob Hayden', password: 'changeit', quota: 1024 },
    });
  });

  it('refuses a password OpenSRS would, before any request', async () => {
    const { sent, fn } = fakeFetch();
    const p = make(fn);
    await expect(p.createMailbox({ address: 'a@x.test', displayName: 'A', password: 'has space', quotaBytes: 1 })).rejects.toMatchObject({ code: 'bad_request' });
    await expect(p.setPassword('a@x.test', 'x'.repeat(55))).rejects.toMatchObject({ code: 'bad_request' });
    await expect(p.setPassword('a@x.test', 'q"uote')).rejects.toMatchObject({ code: 'bad_request' });
    expect(sent).toHaveLength(0);
  });

  it('changes a password and a state only on a mailbox that exists, since change_user would make one', async () => {
    const { sent, fn } = fakeFetch([{ body: { success: true, type: 'mailbox', attributes: {} } }, { body: { success: true } }, { body: MISSING }]);
    const p = make(fn);
    await p.setPassword('a@acme.test', 'new-pw');
    expect(sent.map((s) => s.url.split('/').pop())).toEqual(['get_user', 'change_user']);
    expect(sent[1]!.body).toEqual({ credentials: CREDS, user: 'a@acme.test', attributes: { password: 'new-pw' } });
    await expect(p.setMailboxState('gone@acme.test', 'suspended')).rejects.toMatchObject({ code: 'not_found', providerCode: 2 });
    expect(sent).toHaveLength(3);
  });

  it('maps a mailbox state onto IMAP, SMTP relay and SMTP in', async () => {
    const { sent, fn } = fakeFetch();
    await make(fn).setMailboxState('a@acme.test', 'suspended');
    expect(sent[1]!.body.attributes).toEqual({ service_imap4: 'suspended', service_smtprelay: 'suspended', service_smtpin: 'suspended' });
  });

  it('reads a mailbox from get_user, and a missing one as not existing', async () => {
    // Trimmed from /docs/get_user Example 1.
    const found = { success: true, type: 'mailbox', attributes: { quota: 5120, service_imap4: 'enabled', name: 'Joe User' }, metadata: { quota: { bytes_max: '5368709120', bytes_used: '1' } } };
    const { sent, fn } = fakeFetch([{ body: found }, { body: MISSING }, { body: { success: true, attributes: { quota: 2048, service_imap4: 'suspended' } } }]);
    const p = make(fn);
    expect(await p.getMailbox('joe_user@example.com')).toEqual({ exists: true, state: 'enabled', quotaBytes: 5368709120 });
    expect(sent[0]!.body).toEqual({ credentials: CREDS, user: 'joe_user@example.com' });
    expect(await p.getMailbox('nobody@example.com')).toEqual({ exists: false });
    expect(await p.getMailbox('x@example.com')).toEqual({ exists: true, state: 'suspended', quotaBytes: 2048 });
  });

  it('deletes users and domains, taking "does not exist" as done', async () => {
    const { sent, fn } = fakeFetch([{ body: MISSING }, { body: { success: true } }]);
    const p = make(fn);
    await p.deleteMailbox('robson@example.com');
    await p.deleteDomain('example2.com');
    expect(sent[1]!.url).toMatch(/\/delete_domain$/);
    expect(sent[1]!.body).toEqual({ credentials: CREDS, domain: 'example2.com' });
  });

  it('sets DKIM by change_domain with the selector and a PKCS#1 key, line breaks as \\n', async () => {
    const key = await generateDkimKey(1024);
    const { sent, fn } = fakeFetch();
    await make(fn).setDkim('dkimtesting.com', 'key1', key.privateKeyPem);
    expect(sent.map((s) => s.url.split('/').pop())).toEqual(['get_domain', 'change_domain']);
    const attrs = sent[1]!.body.attributes as { dkim_selector: string; dkim_key: string };
    expect(attrs.dkim_selector).toBe('key1');
    expect(attrs.dkim_key).toMatch(/^-----BEGIN RSA PRIVATE KEY-----\n[^\r]+\n-----END RSA PRIVATE KEY-----$/);
    expect(sent[1]!.body).not.toHaveProperty('create_only');
    const { fn: fn8, sent: sent8 } = fakeFetch();
    await make(fn8, { dkimKeyFormat: 'pkcs8' }).setDkim('dkimtesting.com', 'key1', key.privateKeyPem);
    expect((sent8[1]!.body.attributes as { dkim_key: string }).dkim_key).toBe(key.privateKeyPem.trimEnd());
  });

  it('does not set DKIM on a domain OpenSRS does not have', async () => {
    const { sent, fn } = fakeFetch([{ body: MISSING }]);
    await expect(make(fn).setDkim('nope.test', 'key1', 'pem')).rejects.toMatchObject({ code: 'not_found' });
    expect(sent).toHaveLength(1);
  });
});

describe('OpenSRS errors', () => {
  const failing = async (answer: { status?: number; body: unknown }) => {
    const { fn } = fakeFetch([answer]);
    return make(fn).deleteDomain('acme.test').then(() => null, (e: unknown) => e as ProviderError);
  };

  it('maps error numbers and HTTP statuses to the provider codes', async () => {
    expect(await failing({ body: { success: false, error_number: 6, error: 'One or more attributes badly formatted', hints: { name: 'not a string' } } })).toMatchObject({ code: 'bad_request', providerCode: 6, message: 'opensrs delete_domain: One or more attributes badly formatted' });
    expect(await failing({ body: { ...EXISTS } })).toMatchObject({ code: 'conflict' });
    expect(await failing({ status: 401, body: { success: false, error: 'Authentication failed' } })).toMatchObject({ code: 'auth' });
    expect(await failing({ body: { success: false, error_number: 99, error: 'Invalid credentials' } })).toMatchObject({ code: 'auth' });
    expect(await failing({ status: 429, body: '' })).toMatchObject({ code: 'rate_limited' });
    expect(await failing({ status: 503, body: '<html>down</html>' })).toMatchObject({ code: 'unavailable' });
    expect(await failing({ status: 400, body: { success: false, error: 'Domain still has users' } })).toMatchObject({ code: 'bad_request' });
    const e = await failing({ body: 'not json' });
    expect(e).toBeInstanceOf(ProviderError);
    expect(e).toMatchObject({ code: 'unavailable' });
  });

  it('never carries the credential, even when the provider echoes it', async () => {
    const e = await failing({ body: { success: false, error_number: 99, error: `bad password ${CREDS.password}` } });
    expect(e!.message).not.toContain(CREDS.password);
    expect(e!.message).toContain('[redacted]');
    const down = await make((async () => { throw new Error(`connect to ${CREDS.password} failed`); }) as unknown as typeof fetch).deleteDomain('x.test').catch((x: ProviderError) => x);
    expect(down).toMatchObject({ code: 'unavailable' });
    expect((down as Error).message).not.toContain(CREDS.password);
  });
});

describe('OpenSRS records and servers', () => {
  it('reads the cluster from the API URL', () => {
    expect(clusterOf('https://admin.a.hostedemail.com/api')).toBe('a');
    expect(clusterOf('https://admin.b.hostedemail.com/api')).toBe('b');
    expect(clusterOf('https://admin.test.hostedemail.com/api')).toBe('test');
  });

  it('gives the documented MX, SPF include, DMARC default, and the DKIM TXT once set', async () => {
    const a = new OpenSrsMailProvider({ apiUrl: 'https://admin.a.hostedemail.com/api', ...CREDS });
    expect(await a.records('example.org')).toEqual({ mx: [{ host: 'mx.example.org.cust.hostedemail.com', priority: 0 }], spfInclude: '_spf.hostedemail.com', dmarcPolicy: 'v=DMARC1; p=none' });
    const b = new OpenSrsMailProvider({ apiUrl: 'https://admin.b.hostedemail.com/api', ...CREDS });
    expect((await b.records('example.org')).mx[0]!.host).toBe('mx.example.org.cust.b.hostedemail.com');
    expect((await make(fakeFetch().fn).records('example.org')).mx[0]!.host).toBe('mx.example.org.cust.test.hostedemail.com');
    const records = recordsFor('example.org', await a.records('example.org', { selector: 'ff202611', value: 'v=DKIM1; k=rsa; p=AAAA' }));
    expect(records).toEqual([
      { type: 'MX', name: 'example.org', value: 'mx.example.org.cust.hostedemail.com', priority: 0, purpose: 'mx' },
      { type: 'TXT', name: 'example.org', value: 'v=spf1 include:_spf.hostedemail.com ~all', purpose: 'spf' },
      { type: 'TXT', name: '_dmarc.example.org', value: 'v=DMARC1; p=none', purpose: 'dmarc' },
      { type: 'TXT', name: 'ff202611._domainkey.example.org', value: 'v=DKIM1; k=rsa; p=AAAA', purpose: 'dkim' },
    ]);
  });

  it('connects mailboxes to the cluster\'s mail host over TLS', () => {
    const a = new OpenSrsMailProvider({ apiUrl: 'https://admin.a.hostedemail.com/api', ...CREDS });
    expect(a.mailSettings('ann@acme.test')).toEqual({
      imap: { host: 'mail.hostedemail.com', port: 993, security: 'tls', username: 'ann@acme.test' },
      smtp: { host: 'mail.hostedemail.com', port: 465, security: 'tls', username: 'ann@acme.test' },
    });
    expect(new OpenSrsMailProvider({ apiUrl: 'https://admin.b.hostedemail.com/api', ...CREDS }).mailSettings('x@y.z').imap.host).toBe('mail.b.hostedemail.com');
    expect(new OpenSrsMailProvider({ apiUrl: 'https://admin.a.hostedemail.com/api', ...CREDS, mailHost: 'mail.emailhome.com' }).mailSettings('x@y.z').smtp.host).toBe('mail.emailhome.com');
  });
});
