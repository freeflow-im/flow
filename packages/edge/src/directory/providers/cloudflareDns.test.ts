import { describe, expect, it, vi } from 'vitest';
import { cloudflareDns, platformDns, platformDomainRecords, publishPlatformDomain } from './cloudflareDns';
import { noneProvider } from './none';

const provider = { mx: [{ host: 'mx1.mail.example', priority: 10 }], spfInclude: '_spf.mail.example' };

interface Rec { id: string; type: string; name: string; content: string; priority?: number }

/** A fake zone behind the Cloudflare API, recording each call. */
function fakeApi(initial: Rec[] = []) {
  const zone = [...initial];
  let next = 100;
  const calls: string[] = [];
  const fetchFn = vi.fn(async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    const method = init?.method ?? 'GET';
    expect(u.pathname.startsWith('/client/v4/zones/zone-1/dns_records')).toBe(true);
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer tok');
    const id = u.pathname.split('/dns_records/')[1];
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    calls.push(`${method}${id ? ` ${id}` : ''}${body ? ` ${body.type} ${body.name} ${body.content}` : ''}`);
    if (method === 'GET') return Response.json({ success: true, result: zone.filter((r) => r.type === u.searchParams.get('type') && r.name === u.searchParams.get('name')) });
    if (method === 'POST') { zone.push({ id: `r${next++}`, ...body }); return Response.json({ success: true, result: {} }); }
    const i = zone.findIndex((r) => r.id === id);
    if (method === 'PATCH') zone[i] = { id: id!, ...body };
    if (method === 'DELETE') zone.splice(i, 1);
    return Response.json({ success: true, result: {} });
  });
  return { zone, calls, fetchFn: fetchFn as unknown as typeof fetch };
}

describe('the platform subdomain on Cloudflare', () => {
  it('creates the MX, SPF and DMARC records, and a second run changes nothing', async () => {
    const api = fakeApi();
    const dns = cloudflareDns('tok', 'zone-1', api.fetchFn);
    await dns.publish(platformDomainRecords('acme', provider));
    expect(api.zone.map((r) => `${r.type} ${r.name} ${r.content}`)).toEqual([
      'MX acme.freeflow.im mx1.mail.example',
      'TXT acme.freeflow.im v=spf1 include:_spf.mail.example ~all',
      'TXT _dmarc.acme.freeflow.im v=DMARC1; p=none',
    ]);
    expect(api.zone[0]!.priority).toBe(10);
    api.calls.length = 0;
    await dns.publish(platformDomainRecords('acme', provider));
    expect(api.calls.every((c) => c.startsWith('GET'))).toBe(true);
  });

  it('updates a changed record in place, removes a stale MX, and leaves other TXT alone', async () => {
    const api = fakeApi([
      { id: 'a', type: 'MX', name: 'acme.freeflow.im', content: 'old-mx.example', priority: 10 },
      { id: 'b', type: 'MX', name: 'acme.freeflow.im', content: 'old-mx2.example', priority: 20 },
      { id: 'c', type: 'TXT', name: 'acme.freeflow.im', content: '"v=spf1 include:old.example ~all"' },
      { id: 'd', type: 'TXT', name: 'acme.freeflow.im', content: 'google-site-verification=keep' },
    ]);
    await cloudflareDns('tok', 'zone-1', api.fetchFn).publish(platformDomainRecords('acme', provider));
    expect(api.calls.filter((c) => !c.startsWith('GET'))).toEqual([
      'PATCH a MX acme.freeflow.im mx1.mail.example',
      'DELETE b',
      'PATCH c TXT acme.freeflow.im v=spf1 include:_spf.mail.example ~all',
      'POST TXT _dmarc.acme.freeflow.im v=DMARC1; p=none',
    ]);
    expect(api.zone.find((r) => r.id === 'd')).toBeDefined();
  });

  it('throws on an API error', async () => {
    const fetchFn = (async () => Response.json({ success: false, errors: [{ message: 'bad token' }] }, { status: 403 })) as unknown as typeof fetch;
    await expect(cloudflareDns('tok', 'zone-1', fetchFn).publish(platformDomainRecords('acme', provider))).rejects.toThrow('bad token');
  });

  it('logs instead without the secrets, or with the placeholder provider', async () => {
    const api = fakeApi();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await publishPlatformDomain({}, 'acme', provider, api.fetchFn);
    await publishPlatformDomain({ CLOUDFLARE_DNS_TOKEN: 'tok', CLOUDFLARE_DNS_ZONE_ID: 'zone-1' }, 'acme', noneProvider, api.fetchFn);
    expect(api.fetchFn).not.toHaveBeenCalled();
    expect(log.mock.calls.map((c) => c[0])).toContain('platform dns (dev): MX acme.freeflow.im 10 mx1.mail.example');
    log.mockRestore();
    expect(platformDns({ CLOUDFLARE_DNS_TOKEN: 'tok', CLOUDFLARE_DNS_ZONE_ID: 'zone-1' }, provider, api.fetchFn)).not.toBeNull();
  });
});
