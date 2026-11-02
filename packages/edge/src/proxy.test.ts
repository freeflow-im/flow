import { describe, expect, it, vi } from 'vitest';
import { originRequest, proxy, RETRY_WAITS, type ProxyDeps } from './proxy';

const env = { ORIGIN_URL: 'https://origin.example', EDGE_ORIGIN_SECRET: 's3cret' };

function deps(...answers: Array<Response | Error>): ProxyDeps & { fetch: ReturnType<typeof vi.fn>; sleep: ReturnType<typeof vi.fn> } {
  const fetch = vi.fn(async () => {
    const next = answers.shift();
    if (!next) throw new Error('no more answers');
    if (next instanceof Error) throw next;
    return next;
  });
  return { fetch, sleep: vi.fn(async () => {}) } as never;
}

describe('originRequest', () => {
  it('points at the origin and keeps the path and query', () => {
    const out = originRequest(new Request('https://app.example/v1/me?x=1'), env);
    expect(out.url).toBe('https://origin.example/v1/me?x=1');
  });

  it('names the visitor and overwrites what the visitor claimed under those names', () => {
    const out = originRequest(new Request('https://app.example/', {
      headers: { 'X-Edge-Secret': 'guess', 'X-Edge-Host': 'evil.example', 'X-Edge-Client-IP': '6.6.6.6', 'CF-Connecting-IP': '1.2.3.4' },
    }), env);
    expect(out.headers.get('X-Edge-Secret')).toBe('s3cret');
    expect(out.headers.get('X-Edge-Host')).toBe('app.example');
    expect(out.headers.get('X-Edge-Client-IP')).toBe('1.2.3.4');
  });

  it('does not follow redirects, so the visitor sees them', () => {
    expect(originRequest(new Request('https://app.example/'), env).redirect).toBe('manual');
  });

  it('never lets Cloudflare\'s cache store an answer from the origin', () => {
    expect(originRequest(new Request('https://app.example/v1/files/secret.pdf'), env).cache).toBe('no-store');
    expect(originRequest(new Request('https://app.example/v1/files/secret.pdf'), env).clone().cache).toBe('no-store');
  });

  it('passes the session cookie and the bearer through', () => {
    const out = originRequest(new Request('https://app.example/v1/me', { headers: { Cookie: 'sid=abc', Authorization: 'Bearer t' } }), env);
    expect(out.headers.get('Cookie')).toBe('sid=abc');
    expect(out.headers.get('Authorization')).toBe('Bearer t');
  });
});

describe('proxy', () => {
  it('returns the first good answer', async () => {
    const d = deps(new Response('ok'));
    expect(await (await proxy(new Request('https://app.example/'), env, d)).text()).toBe('ok');
    expect(d.fetch).toHaveBeenCalledTimes(1);
  });

  it('tries a GET again through a deploy', async () => {
    const d = deps(new Response('', { status: 502 }), new Error('refused'), new Response('', { status: 503 }), new Response('back'));
    const res = await proxy(new Request('https://app.example/v1/me'), env, d);
    expect(await res.text()).toBe('back');
    expect(d.sleep.mock.calls.map((c) => c[0])).toEqual(RETRY_WAITS.slice(0, 3));
  });

  it('gives up with the origin\'s own answer when it keeps failing', async () => {
    const d = deps(...Array.from({ length: RETRY_WAITS.length + 1 }, () => new Response('down', { status: 504 })));
    const res = await proxy(new Request('https://app.example/'), env, d);
    expect(res.status).toBe(504);
    expect(d.fetch).toHaveBeenCalledTimes(RETRY_WAITS.length + 1);
  });

  it('says so when the origin cannot be reached at all', async () => {
    const d = deps(...Array.from({ length: RETRY_WAITS.length + 1 }, () => new Error('refused')));
    const res = await proxy(new Request('https://app.example/v1/me'), env, d);
    expect(res.status).toBe(502);
    expect((await res.json() as { error: { code: string } }).error.code).toBe('origin_unavailable');
  });

  it('does not retry a 500: the origin answered', async () => {
    const d = deps(new Response('boom', { status: 500 }));
    expect((await proxy(new Request('https://app.example/'), env, d)).status).toBe(500);
    expect(d.fetch).toHaveBeenCalledTimes(1);
  });

  it('never repeats a POST', async () => {
    const d = deps(new Response('', { status: 502 }));
    const res = await proxy(new Request('https://app.example/v1/messages', { method: 'POST', body: '{}' }), env, d);
    expect(res.status).toBe(502);
    expect(d.fetch).toHaveBeenCalledTimes(1);
    expect(d.sleep).not.toHaveBeenCalled();
  });

  it('reports a POST the origin never got', async () => {
    const d = deps(new Error('refused'));
    const res = await proxy(new Request('https://app.example/v1/messages', { method: 'POST', body: '{}' }), env, d);
    expect(res.status).toBe(502);
  });
});
