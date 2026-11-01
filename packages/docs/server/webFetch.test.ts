import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchPublicFile, isPublicAddress, resolver, WebFetchError } from './webFetch.ts';

const realLookup = resolver.lookup;
afterEach(() => {
  resolver.lookup = realLookup;
});

/** A stand-in network: what each host resolves to, and what each address answers. */
function net(hosts: Record<string, string[]>, pages: Record<string, () => Response>) {
  resolver.lookup = async (host) => {
    if (!hosts[host]) throw new Error('ENOTFOUND');
    return hosts[host];
  };
  const asked: string[] = [];
  const fetchFn = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    asked.push(url);
    return (pages[url] ?? (() => new Response('nope', { status: 404 })))();
  }) as unknown as typeof fetch;
  return { fetchFn, asked };
}

describe('public addresses', () => {
  it('tells the public internet from a private network', () => {
    for (const a of ['93.184.216.34', '8.8.8.8', '2606:2800:220:1:248:1893:25c8:1946']) expect(isPublicAddress(a), a).toBe(true);
    for (const a of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '::1', '::', 'fe80::1', 'fd00::1', '::ffff:10.0.0.1', '::ffff:127.0.0.1', 'not an address'])
      expect(isPublicAddress(a), a).toBe(false);
    expect(isPublicAddress('::ffff:8.8.8.8')).toBe(true);
  });
});

describe('fetching a file from the web', () => {
  it('fetches a public file, with the name its address or its headers give', async () => {
    const { fetchFn } = net(
      { 'img.example.com': ['93.184.216.34'] },
      {
        'https://img.example.com/dogs/golden%20retriever.jpg': () => new Response('JPEGDATA', { headers: { 'content-type': 'image/jpeg; charset=binary' } }),
        'https://img.example.com/get?id=7': () => new Response('PDFDATA', { headers: { 'content-disposition': 'attachment; filename="Annual report.pdf"' } }),
      },
    );
    expect(await fetchPublicFile('https://img.example.com/dogs/golden%20retriever.jpg', { limit: 100, fetchFn })).toEqual({ bytes: Buffer.from('JPEGDATA'), name: 'golden retriever.jpg', type: 'image/jpeg' });
    expect((await fetchPublicFile('https://img.example.com/get?id=7', { limit: 100, fetchFn })).name).toBe('Annual report.pdf');
  });

  it('refuses addresses that are not on the public internet, without asking them', async () => {
    const { fetchFn, asked } = net({ 'intranet.example.com': ['10.0.0.5'], 'mixed.example.com': ['93.184.216.34', '127.0.0.1'] }, {});
    for (const url of ['http://127.0.0.1/a.png', 'http://[::1]/a.png', 'http://169.254.169.254/latest/meta-data', 'https://intranet.example.com/a.png', 'https://mixed.example.com/a.png', 'http://localhost/a.png', 'ftp://img.example.com/a.png', 'file:///etc/passwd', 'https://user:pw@img.example.com/a.png', 'not a url'])
      await expect(fetchPublicFile(url, { limit: 100, fetchFn }), url).rejects.toBeInstanceOf(WebFetchError);
    expect(asked).toEqual([]);
  });

  it('follows redirects one checked hop at a time', async () => {
    const redirect = (to: string) => () => new Response(null, { status: 302, headers: { location: to } });
    const { fetchFn, asked } = net(
      { 'a.example.com': ['93.184.216.34'], 'cdn.example.com': ['93.184.216.35'], 'evil.example.com': ['93.184.216.36'], 'loop.example.com': ['93.184.216.37'] },
      {
        'https://a.example.com/pic': redirect('https://cdn.example.com/real.png'),
        'https://cdn.example.com/real.png': () => new Response('PNG'),
        'https://evil.example.com/pic': redirect('http://169.254.169.254/latest/meta-data'),
        'https://loop.example.com/': redirect('/'),
      },
    );
    expect((await fetchPublicFile('https://a.example.com/pic', { limit: 100, fetchFn })).name).toBe('real.png');
    await expect(fetchPublicFile('https://evil.example.com/pic', { limit: 100, fetchFn })).rejects.toThrow(/public internet/);
    expect(asked).not.toContain('http://169.254.169.254/latest/meta-data');
    await expect(fetchPublicFile('https://loop.example.com/', { limit: 100, fetchFn })).rejects.toThrow(/too many times/);
  });

  it('stops at the size limit, whatever the server said the size was', async () => {
    const { fetchFn } = net(
      { 'big.example.com': ['93.184.216.34'] },
      {
        'https://big.example.com/declared.pdf': () => new Response('x', { headers: { 'content-length': '5000' } }),
        'https://big.example.com/undeclared.bin': () => new Response('x'.repeat(500)),
        'https://big.example.com/movie.mp4': () => new Response('x'.repeat(500)),
        'https://big.example.com/empty': () => new Response(''),
        'https://big.example.com/gone': () => new Response('no', { status: 410 }),
      },
    );
    await expect(fetchPublicFile('https://big.example.com/declared.pdf', { limit: 100, fetchFn })).rejects.toThrow(/too large/);
    await expect(fetchPublicFile('https://big.example.com/undeclared.bin', { limit: 100, fetchFn })).rejects.toThrow(/too large/);
    // The limit can depend on what the file is.
    expect((await fetchPublicFile('https://big.example.com/movie.mp4', { limit: (name) => (name.endsWith('.mp4') ? 1000 : 100), fetchFn })).bytes.length).toBe(500);
    await expect(fetchPublicFile('https://big.example.com/empty', { limit: 100, fetchFn })).rejects.toThrow(/empty/);
    await expect(fetchPublicFile('https://big.example.com/gone', { limit: 100, fetchFn })).rejects.toThrow(/\(410\)/);
    await expect(fetchPublicFile('https://nowhere.example.com/a', { limit: 100, fetchFn })).rejects.toThrow(/Could not find nowhere.example.com/);
  });
});
