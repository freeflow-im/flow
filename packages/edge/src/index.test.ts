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
    ORG: {} as never,
    ASSISTANT: {} as never,
    DOCS: {} as never,
    MAIL: {} as never,
    CALENDAR: {} as never,
    EVENTS: {} as never,
    BLOBS: {} as never,
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
    const res = await app.request('https://app.example/docs/assets/w-1.css', {}, env({ '/docs/assets/w-1.css': 'css' }));
    expect(res.headers.get('Cache-Control')).toContain('immutable');
  });

  it('and for the Mail client', async () => {
    const res = await app.request('https://app.example/mail/assets/m-1.js', {}, env({ '/mail/assets/m-1.js': 'js' }));
    expect(res.headers.get('Cache-Control')).toContain('immutable');
  });

  it('answers a build file this deploy does not have with a 404, not the origin\'s page', async () => {
    const f = origin('<html>shell</html>');
    for (const path of ['/mail/assets/InlineCompose-old.js', '/assets/app-old.js', '/docs/assets/w-old.css']) {
      const res = await app.request(`https://app.example${path}`, {}, env());
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).toContain('text/plain');
      expect(res.headers.get('cache-control')).toBe('no-store');
    }
    expect(f).not.toHaveBeenCalled();
  });

  it('leaves the cache headers of a file whose name is not hashed', async () => {
    const res = await app.request('https://app.example/logo.svg', {}, env({ '/logo.svg': '<svg/>' }));
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=0');
  });

  it('sends pages to the origin: they are not in the assets', async () => {
    const f = origin('shell');
    for (const path of ['/', '/docs', '/docs/s/abc', '/c/general']) {
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

describe('the MCP endpoint and its OAuth', () => {
  const ported = (e: Env): Env => ({ ...e, PORTED_HOSTS: 'app.example' });
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;

  it('answers discovery on the ported host, with its own origin as issuer and resource', async () => {
    const f = origin('aws');
    const res = await app.request('https://app.example/.well-known/oauth-protected-resource/mcp', {}, ported(env()), ctx);
    expect(await res.json()).toMatchObject({ resource: 'https://app.example/mcp', authorization_servers: ['https://app.example'] });
    const as = await app.request('https://app.example/.well-known/oauth-authorization-server', {}, ported(env()), ctx);
    expect(await as.json()).toMatchObject({ issuer: 'https://app.example', authorization_endpoint: 'https://app.example/oauth/authorize' });
    const v2 = await app.request('https://app.example/mcp/v2/.well-known/oauth-protected-resource', {}, ported(env()), ctx);
    expect(await v2.json()).toMatchObject({ resource: 'https://app.example/mcp/v2' });
    expect(f).not.toHaveBeenCalled();
  });

  it('keeps /mcp, /oauth and the well-known documents of the plugin’s hosts on AWS', async () => {
    const f = origin('aws');
    for (const path of ['/mcp', '/oauth/authorize?client_id=x', '/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource/mcp']) {
      expect(await (await app.request(`https://docs.example${path}`, {}, ported(env()), ctx)).text()).toBe('aws');
    }
    expect(f).toHaveBeenCalledTimes(4);
  });

  it('answers an unknown /oauth or /mcp path on the ported host itself, never the plugin on AWS', async () => {
    const f = origin('aws');
    expect((await app.request('https://app.example/oauth/nothing', {}, ported(env()), ctx)).status).toBe(404);
    expect((await app.request('https://app.example/mcp/nothing/here', {}, ported(env()), ctx)).status).toBe(404);
    expect(f).not.toHaveBeenCalled();
  });
});
