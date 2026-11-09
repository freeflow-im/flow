import { describe, expect, it } from 'vitest';
import { FakeMailProvider } from './fake';
import { mailProviderFor, noneMailProvider } from './index';
import { MxRouteMailProvider } from './mxroute';
import { OpenSrsMailProvider } from './opensrs';

describe('the fake mail provider', () => {
  it('keeps domains and mailboxes in memory and records every call without secrets', async () => {
    const p = new FakeMailProvider();
    await expect(p.createMailbox({ address: 'a@acme.test', displayName: 'Ann', password: 'pw', quotaBytes: 1 })).rejects.toMatchObject({ code: 'not_found' });
    await p.createDomain('acme.test', { quotaBytes: 10, maxUsers: 5 });
    await p.createDomain('acme.test', { quotaBytes: 99, maxUsers: 99 });
    expect(p.domains.get('acme.test')).toEqual({ quotaBytes: 10, maxUsers: 5 });
    await p.createMailbox({ address: 'Ann@acme.test', displayName: 'Ann', password: 'pw-1', quotaBytes: 10 });
    await p.createMailbox({ address: 'ann@acme.test', displayName: 'Ann', password: 'other', quotaBytes: 10 });
    expect(p.mailboxes.get('ann@acme.test')!.password).toBe('pw-1');
    await p.setPassword('ann@acme.test', 'pw-2');
    await p.setMailboxState('ann@acme.test', 'suspended');
    expect(await p.getMailbox('ANN@acme.test')).toEqual({ exists: true, state: 'suspended', quotaBytes: 10 });
    await p.setDkim('acme.test', 'ff202611', 'PEM');
    expect(p.domains.get('acme.test')!.dkim).toEqual({ selector: 'ff202611', privateKeyPem: 'PEM' });
    await expect(p.deleteDomain('acme.test')).rejects.toMatchObject({ code: 'conflict' });
    await p.deleteMailbox('ann@acme.test');
    expect(await p.getMailbox('ann@acme.test')).toEqual({ exists: false });
    await p.deleteDomain('acme.test');
    await expect(p.setPassword('ann@acme.test', 'x')).rejects.toMatchObject({ code: 'not_found' });
    expect(JSON.stringify(p.calls)).not.toMatch(/pw-1|pw-2|PEM/);
    expect(p.calls.map((c) => c.method)).toContain('setDkim');
  });

  it('points mailboxes at GreenMail and makes the GreenMail user when its API is given', async () => {
    const sent: { url: string; method: string; body?: unknown }[] = [];
    const fetchFn = (async (url: string, init: RequestInit) => {
      sent.push({ url, method: init.method!, ...(init.body ? { body: JSON.parse(init.body as string) } : {}) });
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const p = new FakeMailProvider({ greenmailApiUrl: 'http://127.0.0.1:8080/', fetch: fetchFn });
    expect(p.mailSettings('ann@acme.test')).toEqual({
      imap: { host: '127.0.0.1', port: 3143, security: 'none', username: 'ann@acme.test' },
      smtp: { host: '127.0.0.1', port: 3025, security: 'none', username: 'ann@acme.test' },
    });
    await p.createDomain('acme.test', { quotaBytes: 1, maxUsers: 1 });
    await p.createMailbox({ address: 'ann@acme.test', displayName: 'Ann', password: 'pw', quotaBytes: 1 });
    await p.deleteMailbox('ann@acme.test');
    expect(sent).toEqual([
      { url: 'http://127.0.0.1:8080/api/user', method: 'POST', body: { email: 'ann@acme.test', login: 'ann@acme.test', password: 'pw' } },
      { url: 'http://127.0.0.1:8080/api/user/ann%40acme.test', method: 'DELETE' },
    ]);
  });

  it('takes GreenMail\'s "already exists" as made, and names a second GreenMail\'s ports', async () => {
    const fetchFn = (async () => new Response('{"message":"Can not create user : ... already exists"}', { status: 400 })) as unknown as typeof fetch;
    const p = new FakeMailProvider({ greenmailApiUrl: 'http://127.0.0.1:8081', imapPort: 3144, smtpPort: 3026, fetch: fetchFn });
    await p.createDomain('acme.test', { quotaBytes: 1, maxUsers: 1 });
    await p.createMailbox({ address: 'ann@acme.test', displayName: 'Ann', password: 'pw', quotaBytes: 1 });
    expect(p.mailboxes.has('ann@acme.test')).toBe(true);
    expect(p.mailSettings('ann@acme.test')).toMatchObject({ imap: { port: 3144 }, smtp: { port: 3026 } });
    expect(mailProviderFor({ MAIL_PROVIDER: 'fake', GREENMAIL_IMAP_PORT: '3144' })).toBe(mailProviderFor({ MAIL_PROVIDER: 'fake', GREENMAIL_IMAP_PORT: '3144' }));
  });

  it('gives its records, marked as not for a real zone', async () => {
    const r = await new FakeMailProvider().records('acme.test', { selector: 's', value: 'v=DKIM1; k=rsa; p=A' });
    expect(r).toMatchObject({ mx: [{ host: 'mx.fake-mail.test', priority: 10 }], spfInclude: '_spf.fake-mail.test', placeholder: true, dkim: { selector: 's' } });
  });
});

describe('mailProviderFor', () => {
  it('picks the provider the environment names', async () => {
    expect(mailProviderFor({})).toBe(noneMailProvider);
    expect(mailProviderFor({ MAIL_PROVIDER: 'fake' })).toBeInstanceOf(FakeMailProvider);
    expect(mailProviderFor({ MAIL_PROVIDER: 'opensrs', OPENSRS_API_URL: 'https://admin.a.hostedemail.com/api', OPENSRS_USER: 'u', OPENSRS_PASSWORD: 'p' })).toBeInstanceOf(OpenSrsMailProvider);
    expect(mailProviderFor({ MAIL_PROVIDER: 'opensrs' })).toBe(noneMailProvider);
    expect(mailProviderFor({ MAIL_PROVIDER: 'mxroute', MXROUTE_SERVER: 'sunfire.mxrouting.net', MXROUTE_USERNAME: 'u', MXROUTE_API_KEY: 'k' })).toBeInstanceOf(MxRouteMailProvider);
    expect(mailProviderFor({ MAIL_PROVIDER: 'mxroute', MXROUTE_SERVER: 'sunfire.mxrouting.net' })).toBe(noneMailProvider);
  });

  it('none has the placeholder records and refuses every change', async () => {
    expect(await noneMailProvider.records('acme.test')).toMatchObject({ placeholder: true, mx: [{ host: 'mx.example.invalid' }] });
    await expect(noneMailProvider.createDomain('acme.test', { quotaBytes: 1, maxUsers: 1 })).rejects.toMatchObject({ code: 'unavailable' });
  });
});
