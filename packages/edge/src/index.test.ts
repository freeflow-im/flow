import { afterEach, describe, expect, it, vi } from 'vitest';
import app, { type Env } from './index';

function env(files: Record<string, string> = {}): Env {
  return {
    ORIGIN_URL: 'https://origin.example',
    EDGE_ORIGIN_SECRET: 's',
    ASSET_HOSTS: 'app.example',
    PORTED_HOSTS: '',
    WEB_URL_BASE: 'https://app.example',
    DIRECTORY: {} as never,
    ASSETS: {
      fetch: async (req: Request) => {
        const body = files[new URL(req.url).pathname];
        return body === undefined ? new Response('nope', { status: 404 }) : new Response(body, { headers: { 'Cache-Control': 'public, max-age=0' } });
      },
    } as unknown as Fetcher,
  };
}

function origin(body = 'from origin') {
  const f = vi.fn(async (_req: Request) => new Response(body));
  vi.stubGlobal('fetch', f);
  return f;
}

afterEach(() => vi.unstubAllGlobals());

describe('the front door', () => {
  it('serves a built file from the edge, for a year when its name is hashed', async () => {
    const f = origin();
    const res = await app.request('https://app.example/assets/app-abc.js', {}, env({ '/assets/app-abc.js': 'code' }));
    expect(await res.text()).toBe('code');
    expect(res.headers.get('Cache-Control')).toContain('immutable');
    expect(f).not.toHaveBeenCalled();
  });

  it('does the same for the Workspace client', async () => {
    const res = await app.request('https://app.example/workspace/assets/w-1.css', {}, env({ '/workspace/assets/w-1.css': 'css' }));
    expect(res.headers.get('Cache-Control')).toContain('immutable');
  });

  it('leaves the cache headers of a file whose name is not hashed', async () => {
    const res = await app.request('https://app.example/logo.svg', {}, env({ '/logo.svg': '<svg/>' }));
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=0');
  });

  it('sends pages to the origin: they are not in the assets', async () => {
    const f = origin('shell');
    for (const path of ['/', '/workspace', '/workspace/s/abc', '/c/general']) {
      expect(await (await app.request(`https://app.example${path}`, {}, env())).text()).toBe('shell');
    }
    expect(f).toHaveBeenCalledTimes(4);
  });

  it('sends the API to the origin without looking for a file of that name', async () => {
    origin('api');
    const res = await app.request('https://app.example/v1/me', {}, env({ '/v1/me': 'a file' }));
    expect(await res.text()).toBe('api');
  });

  it('leaves every path of the other hosts to the origin', async () => {
    origin('legacy');
    const res = await app.request('https://docs.example/assets/app-abc.js', {}, env({ '/assets/app-abc.js': 'code' }));
    expect(await res.text()).toBe('legacy');
  });

  it('sends a POST to the origin even where a file has that name', async () => {
    origin('posted');
    const res = await app.request('https://app.example/logo.svg', { method: 'POST', body: 'x' }, env({ '/logo.svg': '<svg/>' }));
    expect(await res.text()).toBe('posted');
  });
});
