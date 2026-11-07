// The grants routes of the hosted app (server/app.ts, server/access.ts; platform phase 3.2): a stand-in host says who
// is signed in, who is in which organization, each caller's account and channels, and the organizations' link policy.
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type FileChange, type GrantChange } from './app.ts';

const members: Record<string, string[]> = { ann: ['harbor', 'juniper'], bob: ['harbor', 'juniper'], cat: ['harbor'], dave: [] };
const channels: Record<string, string[]> = { ann: ['general'], bob: [], cat: ['general'], dave: ['general'] };
const linkSharing: Record<string, boolean> = { harbor: true, juniper: false };
let dir: string;
let host: ReturnType<typeof Fastify>;
/** What the host's hooks were told: the share index's feed and the saves (platform phase 3.3). */
const changes: GrantChange[] = [];
const saves: FileChange[] = [];

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'docs-grants-'));
  host = Fastify();
  await buildApp({
    dataDir: dir,
    blob: null,
    pdf: null,
    agent: { jobs: false },
    host: {
      app: host,
      basePath: '/workspace',
      authenticate: async (req) => {
        const id = req.headers['x-user'];
        return typeof id === 'string' && id in members ? { id, email: `${id}@x.test` } : null;
      },
      signOut: async () => {},
      userForCookie: async () => null,
      isMember: async (userId, workspaceId) => members[userId]?.includes(workspaceId) ?? false,
      organizationsOf: async (userId) => (members[userId] ?? []).map((id) => ({ id, name: id })),
      readerOf: (req) => {
        const id = req.headers['x-user'] as string;
        return { accountId: `acct-${id}`, channelIds: channels[id] ?? [] };
      },
      linkSharing: async (workspaceId) => linkSharing[workspaceId] ?? true,
      onGrantChange: (c) => void changes.push(c),
      onFileChanged: (c) => void saves.push(c),
    },
  });
  await host.ready();
});

afterAll(async () => {
  await host.close();
  rmSync(dir, { recursive: true, force: true });
});

const call = async (who: string | null, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) => {
  const res = await host.inject({ method, url, headers: who ? { 'x-user': who } : {}, ...(payload ? { payload } : {}) });
  return { status: res.statusCode, body: res.json() as Record<string, any> };
};
const titles = (list: { title: string }[] = []) => list.map((d) => d.title).sort();
const DOC = { version: 1, content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Changed' }] }] } };

describe('sharing on grants', () => {
  it('shares a file with a person: viewer reads, editor writes, only a manager shares', async () => {
    const id = (await call('ann', 'POST', '/api/docs', { title: 'Plan', workspace: 'harbor' })).body.doc.id;
    expect((await call('bob', 'GET', `/api/docs/${id}`)).status).toBe(404);
    expect((await call('bob', 'GET', `/api/grants/sheet/${id}`)).status).toBe(404);
    expect((await call('ann', 'GET', `/api/grants/sheet/${id}?workspace=harbor`)).body).toEqual({ grants: [], role: 'owner', link: null });

    const shared = await call('ann', 'PUT', `/api/grants/sheet/${id}`, { principal: 'account:acct-bob', role: 'viewer' });
    expect(shared.body.grants).toMatchObject([{ principal: 'account:acct-bob', role: 'viewer', grantedBy: 'ann' }]);
    const opened = await call('bob', 'GET', `/api/docs/${id}`);
    expect(opened.status).toBe(200);
    expect(opened.body.meta.role).toBe('viewer');
    expect(titles((await call('bob', 'GET', '/api/library?workspace=harbor&scope=shared')).body.docs)).toEqual(['Plan']);
    expect(titles((await call('ann', 'GET', '/api/library?workspace=harbor&scope=shared')).body.docs)).toEqual([]);
    expect((await call('bob', 'PUT', `/api/docs/${id}`, { doc: DOC })).status).toBe(403);
    expect((await call('bob', 'PUT', `/api/grants/sheet/${id}`, { principal: 'account:acct-cat', role: 'viewer' })).status).toBe(403);

    await call('ann', 'PUT', `/api/grants/sheet/${id}`, { principal: 'account:acct-bob', role: 'editor' });
    expect((await call('bob', 'PUT', `/api/docs/${id}`, { doc: DOC })).status).toBe(200);
    expect((await call('bob', 'DELETE', `/api/docs/${id}`)).status).toBe(403);
    expect((await call('bob', 'GET', `/api/grants/sheet/${id}`)).body.role).toBe('editor');

    expect((await call('ann', 'DELETE', `/api/grants/sheet/${id}/account:acct-bob`)).body.grants).toEqual([]);
    expect((await call('bob', 'GET', `/api/docs/${id}`)).status).toBe(404);
    expect((await call('ann', 'PUT', `/api/grants/sheet/${id}`, { principal: 'nobody', role: 'viewer' })).status).toBe(400);
    expect((await call('ann', 'PUT', `/api/grants/sheet/${id}`, { principal: 'account:acct-bob', role: 'owner' })).status).toBe(400);
  });

  it('shares a folder with a channel, and what is in it by inheritance', async () => {
    await call('ann', 'POST', '/api/folders', { workspace: 'harbor', name: 'Q4' });
    const listed = (await call('ann', 'GET', '/api/library?workspace=harbor')).body.folders.find((f: { name: string }) => f.name === 'Q4');
    expect(listed.id).toBe('me:ann:harbor/Q4');
    const id = (await call('ann', 'POST', '/api/docs', { title: 'Inside', workspace: 'harbor', folder: 'Q4' })).body.doc.id;
    expect((await call('cat', 'GET', `/api/docs/${id}`)).status).toBe(404);
    await call('ann', 'PUT', `/api/grants/folder/${encodeURIComponent(listed.id)}?workspace=harbor`, { principal: 'channel:general', role: 'viewer' });
    expect((await call('cat', 'GET', `/api/docs/${id}`)).body.meta.role).toBe('viewer');
    expect((await call('bob', 'GET', `/api/docs/${id}`)).status).toBe(404);
    // Dave is in a channel of that name but not in the organization.
    expect((await call('dave', 'GET', `/api/docs/${id}`)).status).toBe(404);
    const top = (await call('cat', 'GET', '/api/library?workspace=harbor&scope=shared')).body;
    expect(top.folders).toEqual([{ name: 'Q4', path: listed.id, id: listed.id }]);
    expect(titles((await call('cat', 'GET', `/api/library?workspace=harbor&scope=shared&in=${encodeURIComponent(listed.id)}`)).body.docs)).toEqual(['Inside']);
    expect((await call('bob', 'GET', `/api/library?workspace=harbor&scope=shared&in=${encodeURIComponent(listed.id)}`)).status).toBe(404);
  });

  it('makes a link anyone can open, as the older routes did, and stops it', async () => {
    const id = (await call('ann', 'POST', '/api/decks', { title: 'Talk', workspace: 'harbor' })).body.deck.id;
    const { url } = (await call('ann', 'POST', `/api/grants/sheet/${id}/link?workspace=harbor`)).body;
    const token = url.split('/p/')[1];
    expect((await call(null, 'GET', `/api/public/${token}`)).body).toMatchObject({ kind: 'deck', title: 'Talk' });
    expect((await call('ann', 'GET', `/api/sharing/deck/${id}`)).body.url).toBe(url);
    expect((await call('ann', 'PUT', `/api/sharing/deck/${id}`)).body.url).toBe(url);
    expect((await call('ann', 'GET', `/api/grants/sheet/${id}`)).body).toMatchObject({ link: url, grants: [{ principal: `link:${token}`, role: 'viewer' }] });
    await call('ann', 'DELETE', `/api/grants/sheet/${id}/link:${token}`);
    expect((await call(null, 'GET', `/api/public/${token}`)).status).toBe(404);
    // A document cannot have a link: the public page shows presentations and videos.
    const doc = (await call('ann', 'POST', '/api/docs', { title: 'Words', workspace: 'harbor' })).body.doc.id;
    expect((await call('ann', 'POST', `/api/grants/sheet/${doc}/link`)).status).toBe(400);
  });

  it('refuses a link where the organization’s policy forbids them', async () => {
    const id = (await call('ann', 'POST', '/api/decks', { title: 'Closed talk', workspace: 'juniper' })).body.deck.id;
    const res = await call('ann', 'POST', `/api/grants/sheet/${id}/link?workspace=juniper`);
    expect(res).toMatchObject({ status: 403, body: { code: 'policy_forbids' } });
    expect((await call('ann', 'PUT', `/api/sharing/deck/${id}`)).status).toBe(403);
    expect((await call('ann', 'PUT', `/api/grants/sheet/${id}`, { principal: `link:${'x'.repeat(32)}`, role: 'viewer' })).status).toBe(403);
  });

  it('the organization toggle moves a file between My files and Organization files', async () => {
    const id = (await call('ann', 'POST', '/api/docs', { title: 'Toggle', workspace: 'harbor' })).body.doc.id;
    const org = await call('ann', 'PUT', `/api/grants/sheet/${id}`, { principal: 'org', role: 'editor' });
    expect(org.body.grants).toMatchObject([{ principal: 'org', role: 'editor' }]);
    expect(titles((await call('bob', 'GET', '/api/library?workspace=harbor&shared=1')).body.docs)).toContain('Toggle');
    expect(titles((await call('ann', 'GET', '/api/library?workspace=harbor')).body.docs)).not.toContain('Toggle');
    expect((await call('bob', 'GET', `/api/docs/${id}`)).body.meta).toMatchObject({ shared: true, role: 'editor' });
    // An editor of an organization file may not make it private; its owner may.
    expect((await call('bob', 'DELETE', `/api/grants/sheet/${id}/org`)).status).toBe(403);
    expect((await call('bob', 'POST', `/api/files/${id}/scope`, { workspace: 'harbor', shared: false })).status).toBe(403);
    expect((await call('ann', 'DELETE', `/api/grants/sheet/${id}/org`)).body.grants).toEqual([]);
    expect(titles((await call('ann', 'GET', '/api/library?workspace=harbor')).body.docs)).toContain('Toggle');
    expect((await call('bob', 'GET', `/api/docs/${id}`)).status).toBe(404);
    // Share with organization, as the menus ask for it, is the same grant.
    await call('ann', 'POST', `/api/files/${id}/scope`, { workspace: 'harbor', shared: true });
    expect((await call('ann', 'GET', `/api/grants/sheet/${id}`)).body.grants).toMatchObject([{ principal: 'org', role: 'editor' }]);
  });

  it('tells the host of every grant change, for the share index', async () => {
    changes.length = 0;
    const id = (await call('ann', 'POST', '/api/docs', { title: 'Hooked', workspace: 'harbor' })).body.doc.id;
    const seen = () => changes.splice(0).map((c) => [c.kind, c.id, c.principal, c.role, c.actor, c.title, c.fileKind, c.workspaceId]);
    await call('ann', 'PUT', `/api/grants/sheet/${id}`, { principal: 'account:acct-bob', role: 'viewer' });
    await call('ann', 'PUT', `/api/grants/sheet/${id}`, { principal: 'account:acct-bob', role: 'editor' });
    await call('ann', 'DELETE', `/api/grants/sheet/${id}/account:acct-bob`);
    // A grant that was not there is not reported as taken away.
    await call('ann', 'DELETE', `/api/grants/sheet/${id}/account:acct-cat`);
    expect(seen()).toEqual([
      ['sheet', id, 'account:acct-bob', 'viewer', 'acct-ann', 'Hooked', 'doc', 'harbor'],
      ['sheet', id, 'account:acct-bob', 'editor', 'acct-ann', 'Hooked', 'doc', 'harbor'],
      ['sheet', id, 'account:acct-bob', null, 'acct-ann', 'Hooked', 'doc', 'harbor'],
    ]);
    // The organization, by the toggle and by Share with organization / Make private.
    await call('ann', 'PUT', `/api/grants/sheet/${id}`, { principal: 'org', role: 'editor' });
    await call('ann', 'DELETE', `/api/grants/sheet/${id}/org`);
    await call('ann', 'POST', `/api/files/${id}/scope`, { workspace: 'harbor', shared: true });
    await call('ann', 'POST', `/api/files/${id}/scope`, { workspace: 'harbor', shared: false });
    expect(seen().map(([, , p, r]) => [p, r])).toEqual([['org', 'editor'], ['org', null], ['org', 'editor'], ['org', null]]);
    // A link, made once (asking again is the same link) and stopped, by the new routes and the older ones.
    const deck = (await call('ann', 'POST', '/api/decks', { title: 'Hooked talk', workspace: 'harbor' })).body.deck.id;
    const token = (await call('ann', 'POST', `/api/grants/sheet/${deck}/link?workspace=harbor`)).body.url.split('/p/')[1];
    await call('ann', 'POST', `/api/grants/sheet/${deck}/link?workspace=harbor`);
    await call('ann', 'DELETE', `/api/sharing/deck/${deck}`);
    expect(seen().map(([, , p, r, , t, k]) => [p, r, t, k])).toEqual([[`link:${token}`, 'viewer', 'Hooked talk', 'deck'], [`link:${token}`, null, 'Hooked talk', 'deck']]);
    // A folder, named by its object id and its name.
    await call('ann', 'POST', '/api/folders', { workspace: 'harbor', name: 'Hooks' });
    await call('ann', 'PUT', `/api/grants/folder/${encodeURIComponent('me:ann:harbor/Hooks')}?workspace=harbor`, { principal: 'channel:general', role: 'viewer' });
    expect(seen().map(([k, i, p, , , t, f]) => [k, i, p, t, f])).toEqual([['folder', 'me:ann:harbor/Hooks', 'channel:general', 'Hooks', 'folder']]);
  });

  it('a moved folder re-keys the share index: revokes under the old ids, quiet grants under the new', async () => {
    await call('ann', 'POST', '/api/folders', { workspace: 'harbor', name: 'Moving' });
    await call('ann', 'POST', '/api/folders', { workspace: 'harbor', folder: 'Moving', name: 'Inner' });
    const doc = (await call('ann', 'POST', '/api/docs', { title: 'Moved notes', workspace: 'harbor', folder: 'Moving/Inner' })).body.doc.id;
    await call('ann', 'PUT', `/api/grants/folder/${encodeURIComponent('me:ann:harbor/Moving')}?workspace=harbor`, { principal: 'account:acct-bob', role: 'viewer' });
    await call('ann', 'PUT', `/api/grants/folder/${encodeURIComponent('me:ann:harbor/Moving/Inner')}?workspace=harbor`, { principal: 'channel:general', role: 'editor' });
    await call('ann', 'PUT', `/api/grants/sheet/${doc}`, { principal: 'account:acct-cat', role: 'viewer' });
    changes.length = 0;
    const res = await call('ann', 'POST', '/api/folders/scope', { path: 'Moving', from: { workspace: 'harbor' }, workspace: 'harbor', shared: true });
    expect(res.status).toBe(200);
    const moved = (await call('ann', 'GET', '/api/library?workspace=harbor&shared=1')).body.folders.find((f: { name: string }) => f.name === 'Moving');
    const newId = moved.id as string;
    expect(newId).not.toBe('me:ann:harbor/Moving');
    const seen = changes.splice(0).map((c) => [c.kind, c.id, c.principal, c.role, !!c.silent]);
    expect(seen).toEqual(expect.arrayContaining([
      ['folder', 'me:ann:harbor/Moving', 'account:acct-bob', null, false],
      ['folder', 'me:ann:harbor/Moving/Inner', 'channel:general', null, false],
      ['folder', newId, 'account:acct-bob', 'viewer', true],
      ['folder', `${newId}/Inner`, 'channel:general', 'editor', true],
      ['folder', newId, 'org', 'editor', true],
    ]));
    // The document kept its id and its organization: its grant is not reported again.
    expect(seen.filter(([k]) => k === 'sheet').filter(([, , p]) => p !== 'org')).toEqual([]);

    // To another organization, the people and channels are dropped: revoked, under the old organization's reference.
    changes.length = 0;
    expect((await call('ann', 'POST', '/api/folders/scope', { path: 'Moving', from: { workspace: 'harbor', shared: true }, workspace: 'juniper', shared: true })).status).toBe(200);
    const away = changes.splice(0).map((c) => [c.kind, c.principal, c.role, c.workspaceId]);
    expect(away).toEqual(expect.arrayContaining([
      ['folder', 'account:acct-bob', null, 'harbor'],
      ['folder', 'channel:general', null, 'harbor'],
      ['sheet', 'account:acct-cat', null, 'harbor'],
      ['folder', 'org', 'editor', 'juniper'],
    ]));
    expect(away.some(([, p, r, w]) => w === 'juniper' && r && p !== 'org')).toBe(false);
  });

  it('tells the host of each save of a document in an organization', async () => {
    const id = (await call('ann', 'POST', '/api/docs', { title: 'Saved', workspace: 'harbor' })).body.doc.id;
    saves.length = 0;
    await call('ann', 'PUT', `/api/docs/${id}`, { doc: DOC });
    expect(saves).toMatchObject([{ kind: 'sheet', id, fileKind: 'doc', title: 'Saved', workspaceId: 'harbor', ownerId: 'ann' }]);
  });
});
