// The apps' manifests (@flow/shared's APP_MANIFESTS) against the Worker they describe: each object exported and bound
// with its migration, each app's routes on file, the assembler's client list, the pages and the consent groups. The
// route mounting in index.ts stays by hand for now (phase 6.1), so this is what keeps the two from drifting.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { APP_MANIFESTS } from '@flow/shared/manifests';
import { clientsFrom } from '../scripts/lib/clients.mjs';
import { MCP_SCOPES, offeredGroups, SCOPE_GROUPS } from './directory/mcpOAuth';
import { pageRoutes } from './routes/pages';

const src = path.dirname(fileURLToPath(import.meta.url));
const edge = path.resolve(src, '..');
const root = path.resolve(edge, '../..');
const index = readFileSync(path.join(src, 'index.ts'), 'utf8');
const wrangler = readFileSync(path.join(edge, 'wrangler.toml'), 'utf8');

/** wrangler.toml's `[[migrations]]`: each tag and the classes it adds. */
const migrations = [...wrangler.matchAll(/\[\[migrations\]\]\s*\ntag = "([^"]+)"\s*\nnew_sqlite_classes = \[([^\]]*)\]/g)].map((m) => ({
  tag: m[1]!,
  classes: [...m[2]!.matchAll(/"([^"]+)"/g)].map((c) => c[1]!),
}));

describe('the manifests and the Worker', () => {
  it('exports each app object from index.ts, binds it, and adds it in the migration the manifest names', () => {
    const objects = APP_MANIFESTS.flatMap((m) => (m.object ? [m.object] : []));
    expect(objects.map((o) => o.className)).toEqual(['Org', 'Docs', 'Mail', 'Calendar', 'Events']);
    for (const { className, migrationTag } of objects) {
      expect(index).toMatch(new RegExp(`^export \\{ ${className} \\} from '\\./[^']+';$`, 'm'));
      expect(wrangler).toMatch(new RegExp(`^class_name = "${className}"$`, 'm'));
      expect(migrations.find((m) => m.tag === migrationTag)?.classes).toContain(className);
    }
  });

  it('has a route file for every app, and mounts it in index.ts', () => {
    for (const m of APP_MANIFESTS) {
      if (m.path) expect(m.routes).toBeTruthy();
      if (!m.routes) continue;
      expect(existsSync(path.join(src, 'routes', `${m.routes}.ts`))).toBe(true);
      expect(index).toContain(`from './routes/${m.routes}';`);
    }
  });

  it('gives the assembler one client per manifest client, required ones first', () => {
    const out = path.join(edge, 'public');
    expect(clientsFrom(APP_MANIFESTS, root, out)).toEqual([
      { name: 'chat', from: path.join(root, 'packages/web/dist'), to: path.join(out, '/'), page: 'index.html', optional: false },
      { name: 'docs', from: path.join(root, 'packages/docs/dist/client'), to: path.join(out, 'workspace/'), page: 'workspace.html', optional: false },
      { name: 'mail', from: path.join(root, 'packages/mail/dist'), to: path.join(out, 'mail/'), page: 'mail.html', optional: true },
      { name: 'calendar', from: path.join(root, 'packages/calendar/dist'), to: path.join(out, 'calendar/'), page: 'calendar.html', optional: true },
    ]);
    // Every client has a package.json beside its build folder's package.
    for (const m of APP_MANIFESTS) if (m.client) expect(existsSync(path.join(root, m.client.dist.split('/').slice(0, 2).join('/'), 'package.json'))).toBe(true);
  });

  it('keeps the consent groups and scopes as they were', () => {
    expect(SCOPE_GROUPS.map((g) => [g.id, g.scopes, g.checkedByDefault])).toEqual([
      ['docs', ['files:read', 'files:write'], true],
      ['mail', ['mail:read', 'mail:write'], true],
      ['send', ['mail:send'], false],
      ['calendar', ['calendar:read', 'calendar:write'], true],
      ['events', ['events:read'], true],
    ]);
    expect(MCP_SCOPES).toEqual(['files:read', 'files:write', 'mail:read', 'mail:write', 'mail:send', 'calendar:read', 'calendar:write', 'events:read']);
    expect(offeredGroups('mail:read mail:send').map((g) => g.id)).toEqual(['mail', 'send']);
  });
});

describe('the pages, from the manifests', () => {
  const env = {
    DIRECTORY: {} as never,
    ASSETS: {
      fetch: async (req: Request | URL) => {
        const name = new URL(req instanceof URL ? req : req.url).pathname;
        return name.startsWith('/_pages/') || name === '/privacy.html' ? new Response(`page ${name}`) : new Response('nope', { status: 404 });
      },
    } as unknown as Fetcher,
  };
  const get = (p: string) => pageRoutes.request(`https://app.example${p}`, {}, env as never);

  it('serves each app its page, a file under it falls through, and Chat has the rest', async () => {
    expect(await (await get('/workspace/f/abc')).text()).toBe('page /_pages/workspace.html');
    expect((await get('/workspace/assets/x.js')).status).toBe(404);
    expect(await (await get('/general/thread')).text()).toBe('page /_pages/index.html');
    expect((await get('/v1/channels')).status).toBe(404);
    expect((await get('/assets/x.js')).status).toBe(404);
    expect(await (await get('/privacy')).text()).toBe('page /privacy.html');
  });

  it('sends a stranger to sign in on Docs, Mail and Calendar', async () => {
    for (const p of ['/workspace', '/mail', '/mail/inbox', '/calendar', '/calendar/week']) {
      const res = await get(`${p}?x=1`);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(`/?next=${encodeURIComponent(`${p}?x=1`)}`);
    }
    expect((await get('/mail/assets/x.js')).status).toBe(404);
  });

  it('keeps a public link and a preview out of search engines', async () => {
    const pub = await get('/workspace/p/tok');
    expect(await pub.text()).toBe('page /_pages/workspace.html');
    expect(pub.headers.get('referrer-policy')).toBe('no-referrer');
    expect(pub.headers.get('x-robots-tag')).toBe('noindex');
    const preview = await get('/workspace/preview/id');
    expect(preview.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(preview.headers.get('content-security-policy')).toBe("frame-ancestors 'self'");
    const old = await get('/p/tok?a=b');
    expect(old.status).toBe(301);
    expect(old.headers.get('location')).toBe('/workspace/p/tok?a=b');
  });
});
