// The unfurl fetch and guard on the Workers `fetch` (fetcher.ts, ssrf.ts), and the queue's per-organization context.
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { AsyncLocalStorage } from 'node:async_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FetchError, guardedFetch } from './fetcher.js';
import { assertPublicUrl, SsrfError } from './ssrf.js';
import { UnfurlQueue } from './queue.js';
import { isOwnAddress } from './index.js';

describe('own addresses (platform phase 6.4)', () => {
  it('are references, not pages to fetch: a FreeFlow address on the suite’s origin is skipped, anything else is not', () => {
    const own = (u: string) => isOwnAddress(u, 'org1', 'https://app.freeflow.im');
    expect(['https://app.freeflow.im/workspace/s/abc', 'https://app.freeflow.im/?open=artifact%3Aa1', 'https://app.freeflow.im/calendar/?event=e1'].map(own)).toEqual([true, true, true]);
    expect(['https://example.com/workspace/s/abc', 'https://app.freeflow.im/pricing', 'https://app.freeflow.im/?open=admin'].map(own)).toEqual([false, false, false]);
  });
});

describe('assertPublicUrl', () => {
  const refused = (u: string) => expect(() => assertPublicUrl(new URL(u))).toThrow(SsrfError);
  it('refuses private and loopback addresses, however they are written', () => {
    for (const u of ['http://127.0.0.1/', 'http://2130706433/', 'http://0x7f.1/', 'http://10.1.2.3/', 'http://169.254.169.254/latest', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'http://[fd00::1]/', 'http://192.168.1.1:8080/']) refused(u);
  });
  it('refuses internal names', () => {
    for (const u of ['http://localhost:3000/', 'http://app.localhost/', 'http://printer.local/', 'http://metadata.google.internal/', 'http://intranet/']) refused(u);
  });
  it('lets public names and addresses through', () => {
    for (const u of ['https://example.com/', 'https://8.8.8.8/', 'http://[2606:4700::1111]/']) expect(() => assertPublicUrl(new URL(u))).not.toThrow();
  });
});

describe('guardedFetch', () => {
  let server: http.Server;
  let base = '';
  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const u = new URL(req.url!, 'http://x');
      if (u.pathname === '/page') { res.setHeader('content-type', 'text/html'); res.end(`<html><head><title>Hi</title></head><body>${'x'.repeat(100_000)}</body></html>`); return; }
      if (u.pathname === '/big') { res.setHeader('content-type', 'text/plain'); res.end('y'.repeat(200_000)); return; }
      if (u.pathname === '/hop') { res.statusCode = 302; res.setHeader('location', '/page'); res.end(); return; }
      if (u.pathname === '/loop') { res.statusCode = 301; res.setHeader('location', '/loop'); res.end(); return; }
      if (u.pathname === '/to-private') { res.statusCode = 302; res.setHeader('location', 'http://10.0.0.1/'); res.end(); return; }
      if (u.pathname === '/slow') { setTimeout(() => res.end('late'), 3_000); return; }
      res.statusCode = 404; res.end();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
    process.env.FLOW_UNFURL_ALLOW_HOSTS = 'localhost';
  });
  afterAll(() => { delete process.env.FLOW_UNFURL_ALLOW_HOSTS; server.close(); });

  it('refuses localhost unless a test run allows it', async () => {
    delete process.env.FLOW_UNFURL_ALLOW_HOSTS;
    await expect(guardedFetch(`${base}/page`)).rejects.toThrow(SsrfError);
    process.env.FLOW_UNFURL_ALLOW_HOSTS = 'localhost';
  });
  it('stops reading at </head>, and at the byte cap', async () => {
    const page = await guardedFetch(`${base}/page`, { stopAt: '</head>' });
    expect(page.status).toBe(200);
    expect(page.contentType).toBe('text/html');
    expect(page.body).toContain('<title>Hi</title>');
    expect(page.bytes.length).toBeLessThan(100_000);
    const big = await guardedFetch(`${base}/big`, { maxBytes: 1000 });
    expect(big.bytes.length).toBe(1000);
  });
  it('follows redirects itself, checking every hop', async () => {
    const res = await guardedFetch(`${base}/hop`, { stopAt: '</head>' });
    expect(res.finalUrl).toBe(`${base}/page`);
    await expect(guardedFetch(`${base}/to-private`)).rejects.toThrow(SsrfError);
    await expect(guardedFetch(`${base}/loop`)).rejects.toMatchObject({ reason: 'too_many_redirects' });
  });
  it('gives up at the deadline', async () => {
    const err = await guardedFetch(`${base}/slow`, { deadline: Date.now() + 300 }).catch((e) => e);
    expect(err).toBeInstanceOf(FetchError);
    expect(err.reason).toBe('timeout');
  });
});

describe('UnfurlQueue', () => {
  it('runs each job in the context it was queued from, whichever job starts it', async () => {
    const org = new AsyncLocalStorage<string>();
    const queue = new UnfurlQueue((ms) => new Promise((r) => setTimeout(r, ms)));
    const seen: Record<string, string | undefined> = {};
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    // Four jobs fill one host; the fifth waits and is started by another organization's job finishing.
    for (let i = 0; i < 4; i++) org.run('a', () => queue.enqueue({ key: `a${i}`, host: 'h', retryable: () => false, run: async () => { await gate; seen[`a${i}`] = org.getStore(); } }));
    const done = new Promise<void>((r) => org.run('b', () => queue.enqueue({ key: 'b', host: 'h', retryable: () => false, run: async () => { seen.b = org.getStore(); r(); } })));
    release();
    await done;
    expect(seen).toMatchObject({ a0: 'a', b: 'b' });
    queue.stop();
  });
});
