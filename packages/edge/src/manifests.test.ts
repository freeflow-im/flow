// The apps' manifests (@flow/shared's APP_MANIFESTS) against the Worker they describe: each object exported and bound
// with its migration, each app's routes on file, the assembler's client list, the pages and the consent groups. The
// route mounting in index.ts stays by hand for now (phase 6.1), so this is what keeps the two from drifting.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { APP_MANIFESTS } from '@flow/shared/manifests';
import { blocks, deployClients, fill } from '../scripts/clients.mjs';
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
    expect(objects.slice(0, 6).map((o) => o.className)).toEqual(['Org', 'Docs', 'Mail', 'Calendar', 'Events', 'Assistant']);
    for (const { className, migrationTag } of objects) {
      expect(index).toMatch(new RegExp(`^export \\{ ${className} \\} from '\\./[^']+';$`, 'm'));
      // Bound under its class name in capitals, which is how the kernel finds it (apps.ts' bindingOf).
      expect(wrangler).toMatch(new RegExp(`^name = "${className.toUpperCase()}"\\nclass_name = "${className}"$`, 'm'));
      expect(migrations.find((m) => m.tag === migrationTag)?.classes).toContain(className);
    }
  });

  it('has a route file for every app that has routes, and mounts it in index.ts', () => {
    for (const m of APP_MANIFESTS) {
      // An app with a page has routes, unless it works through the others' (Admin, docs/specs/workspace-admin.md §2.1; Home,
      // docs/specs/home.md).
      if (m.path && m.name !== 'admin' && m.name !== 'home') expect(m.routes).toBeTruthy();
      if (!m.routes) continue;
      expect(existsSync(path.join(src, 'routes', `${m.routes}.ts`))).toBe(true);
      expect(index).toContain(`from './routes/${m.routes}';`);
    }
  });

  it('gives the assembler one client per manifest client, required ones first', () => {
    const out = path.join(edge, 'public');
    const clients = clientsFrom(APP_MANIFESTS, root, out);
    expect(clients.slice(0, 4)).toEqual([
      { name: 'chat', from: path.join(root, 'packages/web/dist'), to: path.join(out, '/'), page: 'index.html', extra: [], optional: false },
      { name: 'docs', from: path.join(root, 'packages/docs/dist/client'), to: path.join(out, 'docs/'), page: 'docs.html', extra: [], optional: false },
      { name: 'mail', from: path.join(root, 'packages/mail/dist'), to: path.join(out, 'mail/'), page: 'mail.html', extra: [], optional: true },
      { name: 'calendar', from: path.join(root, 'packages/calendar/dist'), to: path.join(out, 'calendar/'), page: 'calendar.html', extra: [{ file: 'book.html', page: 'calendar-book.html' }], optional: true },
    ]);
    // Any later app's client is optional: a deploy built before it has none.
    expect(clients.slice(4).every((c) => c.optional && c.page === `${c.name}.html`)).toBe(true);
    // Every client has a package.json beside its build folder's package.
    for (const m of APP_MANIFESTS) if (m.client) expect(existsSync(path.join(root, m.client.dist.split('/').slice(0, 2).join('/'), 'package.json'))).toBe(true);
  });

  it('names every client in the deploy files, as clients.mjs writes them', async () => {
    // The Dockerfile's COPY lines and flow-aws-deploy.yml's paths filter cannot run the script; a new app's manifest
    // fails here until `node packages/edge/scripts/clients.mjs write` is run.
    const clients = await deployClients();
    expect(clients.map((c) => c.pkg)).toEqual(expect.arrayContaining(['@flow/web', '@flow/docs', '@flow/contacts']));
    for (const [file, fileBlocks] of Object.entries(blocks(clients))) {
      const text = readFileSync(path.join(root, file), 'utf8');
      expect(fill(text, file, fileBlocks), file).toBe(text);
    }
  });

  it('keeps the consent groups and scopes as they were', () => {
    expect(SCOPE_GROUPS.slice(0, 5).map((g) => [g.id, g.scopes, g.checkedByDefault])).toEqual([
      ['docs', ['files:read', 'files:write'], true],
      ['mail', ['mail:read', 'mail:write'], true],
      ['send', ['mail:send'], false],
      ['calendar', ['calendar:read', 'calendar:write'], true],
      ['events', ['events:read'], true],
    ]);
    expect(MCP_SCOPES.slice(0, 8)).toEqual(['files:read', 'files:write', 'mail:read', 'mail:write', 'mail:send', 'calendar:read', 'calendar:write', 'events:read']);
    expect(MCP_SCOPES).toEqual(APP_MANIFESTS.flatMap((m) => m.scopes ?? []).flatMap((g) => g.scopes));
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
    expect(await (await get('/docs/f/abc')).text()).toBe('page /_pages/docs.html');
    expect((await get('/docs/assets/x.js')).status).toBe(404);
    expect(await (await get('/chat')).text()).toBe('page /_pages/index.html');
    expect(await (await get('/chat/settings')).text()).toBe('page /_pages/index.html');
    expect((await get('/chat/assets/x.js')).status).toBe(404);
    expect(await (await get('/general/thread')).text()).toBe('page /_pages/index.html');
    expect((await get('/v1/channels')).status).toBe(404);
    expect((await get('/assets/x.js')).status).toBe(404);
    expect(await (await get('/privacy')).text()).toBe('page /privacy.html');
  });

  it('sends a stranger to sign in on Docs, Mail, Calendar and every app whose pages ask for it', async () => {
    const declared = APP_MANIFESTS.flatMap((m) => (m.pages ?? []).filter((p) => p.signIn).map((p) => p.path.replace('/*', '/x')));
    for (const p of new Set(['/docs', '/mail', '/mail/inbox', '/calendar', '/calendar/week', ...declared])) {
      const res = await get(`${p}?x=1`);
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe(`/?next=${encodeURIComponent(`${p}?x=1`)}`);
    }
    expect((await get('/mail/assets/x.js')).status).toBe(404);
  });

  it('keeps a public link and a preview out of search engines', async () => {
    const pub = await get('/docs/p/tok');
    expect(await pub.text()).toBe('page /_pages/docs.html');
    expect(pub.headers.get('referrer-policy')).toBe('no-referrer');
    expect(pub.headers.get('x-robots-tag')).toBe('noindex');
    const preview = await get('/docs/preview/id');
    expect(preview.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(preview.headers.get('content-security-policy')).toBe("frame-ancestors 'self'");
    // The guest scheduler's page: no sign-in, its own build, out of search engines; the rest of /calendar still asks.
    const book = await get('/calendar/book/k7mq-x3vd-p9tr?month=2026-11');
    expect(await book.text()).toBe('page /_pages/calendar-book.html');
    expect(book.headers.get('referrer-policy')).toBe('no-referrer');
    expect(book.headers.get('x-robots-tag')).toBe('noindex');
    expect((await get('/calendar/book/m/abc')).status).toBe(200);
    expect((await get('/calendar/week')).status).toBe(302);
    const old = await get('/p/tok?a=b');
    expect(old.status).toBe(301);
    expect(old.headers.get('location')).toBe('/docs/p/tok?a=b');
  });

  it('sends the root to Chat at /chat, with its query (a sign-in link, ?next=, a handoff)', async () => {
    for (const [from, to] of [['/', '/chat'], ['/?next=%2Fdocs', '/chat?next=%2Fdocs'], ['/?signin=tok&x=1', '/chat?signin=tok&x=1']]) {
      const res = await get(from!);
      expect(res.status, from).toBe(302);
      expect(res.headers.get('location'), from).toBe(to);
    }
  });

  it('sends Docs’ addresses under /workspace, its base until 2026-11-10, to the same page under /docs', async () => {
    for (const [from, to] of [['/workspace', '/docs'], ['/workspace/', '/docs/'], ['/workspace/s/abc?x=1', '/docs/s/abc?x=1'], ['/workspace/?withme=1&in=f', '/docs/?withme=1&in=f']]) {
      const res = await get(from!);
      expect(res.status, from).toBe(301);
      expect(res.headers.get('location'), from).toBe(to);
    }
  });
});
