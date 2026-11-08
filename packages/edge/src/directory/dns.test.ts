import { describe, expect, it, vi } from 'vitest';
import { checkDomain, checkRecords, dohResolver, normalizeDomain, recordsFor, unquoteTxt, type Resolve } from './dns';
import { noneProvider } from './providers/none';

const provider = { mx: [{ host: 'mx1.mail.example', priority: 10 }, { host: 'mx2.mail.example', priority: 20 }], spfInclude: '_spf.mail.example' };

/** A resolver over a fixed zone, keyed `TYPE name`. */
const zone = (records: Record<string, string[]>): Resolve => async (name, type) => records[`${type} ${name}`] ?? [];

describe('the records to publish', () => {
  it('lists the verification TXT with the token, then MX, SPF and DMARC', () => {
    expect(recordsFor('acme.test', provider, 'freeflow-verify=abc')).toEqual([
      { type: 'TXT', name: '_freeflow.acme.test', value: 'freeflow-verify=abc', purpose: 'verification' },
      { type: 'MX', name: 'acme.test', value: 'mx1.mail.example', priority: 10, purpose: 'mx' },
      { type: 'MX', name: 'acme.test', value: 'mx2.mail.example', priority: 20, purpose: 'mx' },
      { type: 'TXT', name: 'acme.test', value: 'v=spf1 include:_spf.mail.example ~all', purpose: 'spf' },
      { type: 'TXT', name: '_dmarc.acme.test', value: 'v=DMARC1; p=none', purpose: 'dmarc' },
    ]);
  });
  it('leaves out the verification TXT without a token, and the placeholder provider says so', () => {
    const records = recordsFor('acme.freeflow.im', noneProvider);
    expect(records.map((r) => r.purpose)).toEqual(['mx', 'spf', 'dmarc']);
    expect(records[0]!.value).toBe('mx.example.invalid');
    expect(noneProvider.placeholder).toBe(true);
  });
});

describe('domain names', () => {
  it('lower-cases, drops a trailing dot, and refuses what is not a hostname', () => {
    expect(normalizeDomain(' Acme.Test. ')).toBe('acme.test');
    expect(normalizeDomain('mail.acme-co.example')).toBe('mail.acme-co.example');
    for (const bad of ['acme', 'acme..test', '-acme.test', 'acme-.test', 'ac me.test', 'a@b.test', '1.2.3.4', 'x'.repeat(64) + '.test']) expect(normalizeDomain(bad)).toBeNull();
  });
});

describe('the verification check', () => {
  it('verifies when the TXT carries the token among others, and reports what it found', async () => {
    const resolve = zone({ 'TXT _freeflow.acme.test': ['google-site-verification=x', 'freeflow-verify=abc'] });
    expect(await checkDomain('acme.test', 'freeflow-verify=abc', resolve)).toEqual({ verified: true, found: ['google-site-verification=x', 'freeflow-verify=abc'] });
    expect(await checkDomain('acme.test', 'freeflow-verify=other', resolve)).toMatchObject({ verified: false });
  });
  it('is not verified when the lookup fails', async () => {
    expect(await checkDomain('acme.test', 't', async () => { throw new Error('down'); })).toEqual({ verified: false, found: [] });
  });
});

describe('the records checker', () => {
  it('marks each record present or missing, an SPF with other includes and any DMARC policy counting', async () => {
    const records = recordsFor('acme.test', provider, 'freeflow-verify=abc');
    const resolve = vi.fn(zone({
      'TXT _freeflow.acme.test': ['freeflow-verify=abc'],
      'MX acme.test': ['10 MX1.mail.example.', '30 mx2.mail.example.'],
      'TXT acme.test': ['v=spf1 include:_spf.google.com include:_spf.mail.example -all'],
      'TXT _dmarc.acme.test': ['v=DMARC1; p=reject; rua=mailto:d@acme.test'],
    }));
    expect((await checkRecords(records, resolve)).map((s) => s.record)).toEqual(['present', 'present', 'missing', 'present', 'present']);
    expect(resolve).toHaveBeenCalledTimes(4);
  });
  it('an SPF without the include is missing', async () => {
    const [spf] = recordsFor('acme.test', provider).filter((r) => r.purpose === 'spf');
    expect(await checkRecords([spf!], zone({ 'TXT acme.test': ['v=spf1 include:_spf.google.com ~all'] }))).toEqual([{ record: 'missing' }]);
  });
});

describe('DNS over HTTPS', () => {
  it('asks for JSON, unquotes and joins TXT strings, and keeps only the asked type', async () => {
    const fetchFn = vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ Status: 0, Answer: [
      { name: 'acme.test', type: 5, data: 'alias.test.' },
      { name: 'acme.test', type: 16, data: '"v=spf1 include:a" " ~all"' },
    ] }));
    const resolve = dohResolver('https://dns.test/dns-query', fetchFn as unknown as typeof fetch);
    expect(await resolve('acme.test', 'TXT')).toEqual(['v=spf1 include:a ~all']);
    expect(fetchFn.mock.calls[0]![0]).toBe('https://dns.test/dns-query?name=acme.test&type=TXT');
    expect(fetchFn.mock.calls[0]![1]).toEqual({ headers: { accept: 'application/dns-json' } });
  });
  it('gives nothing for NXDOMAIN and throws on a failed request', async () => {
    expect(await dohResolver('https://d', (async () => Response.json({ Status: 3 })) as unknown as typeof fetch)('x.test', 'MX')).toEqual([]);
    await expect(dohResolver('https://d', (async () => new Response('', { status: 502 })) as unknown as typeof fetch)('x.test', 'MX')).rejects.toThrow('502');
  });
  it('unquotes escaped quotes', () => {
    expect(unquoteTxt('"a \\"b\\""')).toBe('a "b"');
    expect(unquoteTxt('plain')).toBe('plain');
  });
});
