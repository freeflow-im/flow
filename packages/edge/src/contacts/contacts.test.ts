// FreeFlow Contacts (phase 6.5): the object (own contacts, the share grant and the share index, `contacts.changed`, the
// merge of members, shared lists and Mail's correspondents, `describe`), the routes through the Worker, the tools through the
// registry with the kernel's app contexts (apps.ts), and a reference resolved by the manifest alone. Over node:sqlite with
// stand-in Org, Events, Directory and Mail objects; Ann and Bob are members of org-1, Cy of org-2.
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import app, { type Env } from '../index';
import { appToolContexts, describeInApp } from '../apps';
import type { PublishInput } from '../events/core';
import type { CallerContext } from '../org/routes/compat';
import { resolveReferences } from '../references';
import { runnerOf, toolsFor } from '../registry';
import { Contacts, mergeContacts, type ContactDTO } from './object';

const toBinding = (v: unknown): SQLInputValue => (v instanceof ArrayBuffer ? new Uint8Array(v) : (v as SQLInputValue));

function sqlStorage() {
  const db = new DatabaseSync(':memory:');
  const exec = (query: string, ...bindings: unknown[]) => {
    const statement = db.prepare(query);
    const values = bindings.map(toBinding);
    const rows = statement.columns().length ? (statement.all(...values) as Record<string, unknown>[]) : (statement.run(...values), []);
    return { toArray: () => rows, one: () => rows[0] };
  };
  return { exec, databaseSize: 0 };
}

const account = (id: string, org = 'org-1') => ({ id: `acct-${id}`, principalId: `u-${id}`, organizationId: org, address: `${id}@acme.freeflow.im`, displayName: id[0]!.toUpperCase() + id.slice(1), role: 'member', kind: 'native', state: 'active', createdAt: '' });
const callerOf = (id: string, org = 'org-1') => ({ user: { id: `u-${id}`, email: `${id}@x.test` }, token: `tok-${id}`, authKind: 'session', ip: '', organizationId: org, account: account(id, org) }) as unknown as CallerContext;
const ANN = callerOf('ann'), BOB = callerOf('bob'), CY = callerOf('cy', 'org-2');

/** A world: every account's Contacts object, the stand-ins they call, and what they published and indexed. */
function world() {
  const published: PublishInput[] = [];
  const shares = new Map<string, { principal: string; title?: string }>();
  const objects = new Map<string, Contacts>();
  const env: Record<string, unknown> = {
    EVENTS: { idFromName: (n: string) => n, get: () => ({ publish: async (e: PublishInput) => { published.push(e); return { seq: published.length, id: 'e' }; } }) },
    ORG: {
      idFromName: (n: string) => n,
      get: () => ({
        recordShare: async (i: { ref: string; principal: string; title?: string }) => void shares.set(i.ref, i),
        revokeShare: async (i: { ref: string }) => void shares.delete(i.ref),
        sharedWith: async () => [...shares.entries()].map(([ref, s]) => ({ ref, kind: 'list', title: s.title ?? '', role: 'viewer', principal: s.principal, grantedBy: '', at: 0, url: '' })),
      }),
    },
    DIRECTORY: {
      idFromName: (n: string) => n,
      get: () => ({
        call: async (method: string, args: unknown[]) => {
          const users: Record<string, string> = { 'tok-ann': 'ann', 'tok-bob': 'bob', 'tok-cy': 'cy' };
          if (method === 'accountsOfOrganization') return { ok: true, value: args[0] === 'org-1' ? [account('ann'), account('bob'), { ...account('gone'), state: 'removed' }] : [account('cy', 'org-2')] };
          if (method === 'authenticateIn' || method === 'authenticate') {
            const id = users[args[0] as string];
            if (!id) return { ok: false, status: 401, code: 'unauthorized', message: 'no' };
            const org = id === 'cy' ? 'org-2' : 'org-1';
            return { ok: true, value: { user: { id: `u-${id}`, email: `${id}@x.test` }, kind: 'session', account: account(id, org) } };
          }
          if (method === 'accountsOf') return { ok: true, value: [] };
          return { ok: true, value: null };
        },
      }),
    },
    // Ann wrote to dee@outside.test and to bob (a member already); she only heard from spam@outside.test.
    MAIL: {
      idFromName: (n: string) => n,
      get: (id: string) => ({
        handle: async (req: Request) => {
          const path = new URL(req.url).pathname;
          if (id !== 'acct-ann') return Response.json({ accounts: [] });
          if (path === '/v1/mail/accounts') return Response.json({ accounts: [{ id: 'm1' }] });
          return Response.json({ contacts: [{ name: 'Dee', address: 'Dee@Outside.test', sent: 2, received: 0 }, { name: 'Bob', address: 'bob@acme.freeflow.im', sent: 1, received: 1 }, { name: '', address: 'spam@outside.test', sent: 0, received: 5 }] });
        },
      }),
    },
  };
  const of = (id: string) => {
    let o = objects.get(id);
    if (!o) {
      o = new Contacts({ storage: { sql: sqlStorage() }, id: { name: id } } as never, env as never);
      objects.set(id, o);
    }
    return o;
  };
  env.CONTACTS = { idFromName: (n: string) => n, get: (id: string) => of(id) };
  const call = async (who: CallerContext, method: string, path: string, body?: unknown) => {
    const res = await of(who.account!.id).handle(new Request(`https://edge.test${path}`, { method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } } : {}) }), who);
    return { s: res.status, j: (await res.json()) as Record<string, any> };
  };
  return { env, of, call, published, shares };
}

const bySource = (list: ContactDTO[]) => list.map((c) => `${c.source}:${c.name}`);

describe('the Contacts object', () => {
  it('adds, changes and deletes the account’s own contacts, each publishing contacts.changed to the account alone', async () => {
    const { call, published } = world();
    let r = await call(ANN, 'POST', '/v1/contacts', { name: 'Zed Quill', emails: ['Zed@Quill.test', 'zed@quill.test'], orgName: 'Quill & Co' });
    expect(r.s).toBe(201);
    const zed = r.j.contact;
    expect(zed).toMatchObject({ source: 'own', name: 'Zed Quill', emails: ['zed@quill.test'], orgName: 'Quill & Co' });
    expect(zed.id).toMatch(/^acct-ann:[0-9a-f]{12}$/);
    expect(published[0]).toMatchObject({ type: 'contacts.changed', organizationId: 'org-1', actor: 'acct-ann', audience: 'account:acct-ann', ref: { app: 'contacts', kind: 'contact', id: zed.id }, data: { change: 'added', name: 'Zed Quill' } });
    r = await call(ANN, 'PATCH', `/v1/contacts/${encodeURIComponent(zed.id)}`, { phone: '+1 555 0100', orgName: '' });
    expect(r.j.contact).toMatchObject({ phone: '+1 555 0100', name: 'Zed Quill' });
    expect(r.j.contact.orgName).toBeUndefined();
    expect((await call(ANN, 'POST', '/v1/contacts', { name: '' })).s).toBe(400);
    expect((await call(ANN, 'POST', '/v1/contacts', { name: 'X', emails: ['not an address'] })).s).toBe(400);
    expect((await call(ANN, 'PATCH', '/v1/contacts/acct-ann:000000000000', { name: 'Y' })).s).toBe(404);
    expect((await call(ANN, 'DELETE', `/v1/contacts/${encodeURIComponent(zed.id)}`)).j).toEqual({ ok: true });
    expect(published.map((e) => (e.data as { change: string }).change)).toEqual(['added', 'updated', 'deleted']);
    expect((await call(ANN, 'GET', '/v1/contacts')).j.contacts.filter((c: ContactDTO) => c.source === 'own')).toEqual([]);
  });

  it('refuses another account’s caller (the owner guard)', async () => {
    const { of, call } = world();
    await call(ANN, 'GET', '/v1/contacts/share');
    const res = await of('acct-ann').handle(new Request('https://edge.test/v1/contacts'), BOB);
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('wrong_account');
  });

  it('merges own contacts, the members, and the people written to, marked by source; searches all of them', async () => {
    const { call } = world();
    await call(ANN, 'POST', '/v1/contacts', { name: 'Zed Quill', emails: ['zed@quill.test'] });
    const r = await call(ANN, 'GET', '/v1/contacts');
    // Not Ann herself, nor a removed account; Bob once (a member), not again from Mail; nobody she only heard from.
    expect(bySource(r.j.contacts)).toEqual(['own:Zed Quill', 'member:Bob', 'mail:Dee']);
    const bob = r.j.contacts[1];
    expect(bob).toMatchObject({ id: 'member:acct-bob', emails: ['bob@acme.freeflow.im'], accountId: 'acct-bob', userId: 'u-bob' });
    expect(r.j.contacts[2]).toMatchObject({ id: 'mail:dee@outside.test', emails: ['dee@outside.test'] });
    expect(bySource((await call(ANN, 'GET', '/v1/contacts/search?q=QUILL')).j.contacts)).toEqual(['own:Zed Quill']);
    expect(bySource((await call(ANN, 'GET', '/v1/contacts/search?q=acme.freeflow')).j.contacts)).toEqual(['member:Bob']);
    expect((await call(ANN, 'GET', '/v1/contacts/search?q=')).s).toBe(400);
  });

  it('shares the list with the organization as viewer: a grant, the share index, and members see it as shared', async () => {
    const { call, of, shares } = world();
    const zed = (await call(ANN, 'POST', '/v1/contacts', { name: 'Zed Quill', emails: ['zed@quill.test'] })).j.contact;
    expect(bySource((await call(BOB, 'GET', '/v1/contacts')).j.contacts)).toEqual(['member:Ann']);
    expect(of('acct-ann').describe(BOB, [], 'contact', zed.id)).toBeNull();
    expect((await call(ANN, 'GET', '/v1/contacts/share')).j).toEqual({ org: false });
    expect((await call(ANN, 'PUT', '/v1/contacts/share', { org: true })).j).toEqual({ org: true });
    expect(shares.get('org-1/contacts/list/acct-ann')).toMatchObject({ principal: 'org', role: 'viewer', kind: 'list', title: 'Ann’s contacts' });
    const seen = (await call(BOB, 'GET', '/v1/contacts')).j.contacts;
    expect(bySource(seen)).toEqual(['member:Ann', 'shared:Zed Quill']);
    expect(seen[1]).toMatchObject({ id: zed.id, owner: { accountId: 'acct-ann', name: 'Ann' } });
    expect(of('acct-ann').describe(BOB, [], 'contact', zed.id)).toEqual({ title: 'Zed Quill', summary: 'zed@quill.test', role: 'viewer' });
    expect(of('acct-ann').describe(ANN, [], 'list', 'acct-ann')).toEqual({ title: 'Ann’s contacts', role: 'owner' });
    // Another organization's member sees nothing of it.
    expect(await of('acct-ann').sharedWith(CY)).toBeNull();
    expect(of('acct-ann').describe(CY, [], 'contact', zed.id)).toBeNull();
    expect((await call(ANN, 'PUT', '/v1/contacts/share', { org: false })).j).toEqual({ org: false });
    expect(shares.has('org-1/contacts/list/acct-ann')).toBe(false);
    expect(bySource((await call(BOB, 'GET', '/v1/contacts')).j.contacts)).toEqual(['member:Ann']);
    expect((await call(ANN, 'PUT', '/v1/contacts/share', { org: 'yes' })).s).toBe(400);
  });

  it('merges with the weakest source left out on an address another has', () => {
    const c = (source: ContactDTO['source'], name: string, email: string): ContactDTO => ({ id: `${source}:${name}`, source, name, emails: [email] });
    expect(bySource(mergeContacts({ own: [c('own', 'b', 'x@t'), c('own', 'A', 'y@t')], members: [c('member', 'M', 'x@t')], shared: [c('shared', 'S', 's@t')], mail: [c('mail', 'dup', 'y@t'), c('mail', 'new', 'n@t')] })))
      .toEqual(['own:A', 'own:b', 'member:M', 'shared:S', 'mail:new']);
  });
});

describe('Contacts through the kernel', () => {
  const workerEnv = (w: ReturnType<typeof world>) => ({ ORIGIN_URL: 'https://origin.example', EDGE_ORIGIN_SECRET: 's', ASSET_HOSTS: '', PORTED_HOSTS: 'app.example', WEB_URL_BASE: 'https://app.example', ...w.env }) as unknown as Env;
  const request = async (w: ReturnType<typeof world>, tok: string | null, method: string, path: string, body?: unknown) => {
    const res = await app.request(`https://app.example${path}`, { method, headers: { ...(tok ? { authorization: `Bearer ${tok}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }, workerEnv(w), { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext);
    return { s: res.status, j: (await res.json()) as Record<string, any>, h: res.headers };
  };

  it('serves /v1/contacts on the caller’s own object, signed in only', async () => {
    const w = world();
    expect((await request(w, null, 'GET', '/v1/contacts?workspace=org-1')).s).toBe(401);
    const r = await request(w, 'tok-ann', 'POST', '/v1/contacts?workspace=org-1', { name: 'Zed Quill', emails: ['zed@quill.test'] });
    expect(r.s).toBe(201);
    expect(r.h.get('cache-control')).toBe('no-store');
    const list = await request(w, 'tok-ann', 'GET', '/v1/contacts/search?workspace=org-1&q=zed');
    expect(bySource(list.j.contacts)).toEqual(['own:Zed Quill']);
    expect(bySource((await request(w, 'tok-bob', 'GET', '/v1/contacts/search?workspace=org-1&q=zed')).j.contacts)).toEqual([]);
    expect((await request(w, 'tok-ann', 'PUT', '/v1/contacts/share?workspace=org-1', { org: true })).j).toEqual({ org: true });
    expect(bySource((await request(w, 'tok-bob', 'GET', '/v1/contacts/search?workspace=org-1&q=zed')).j.contacts)).toEqual(['shared:Zed Quill']);
  });

  it('runs its tools at /mcp and in the assistant with the app context the kernel makes from the manifest', async () => {
    const w = world();
    const apps = appToolContexts(w.env, async () => ANN, 'https://app.example');
    expect(Object.keys(apps)).toEqual(['contacts']);
    expect(toolsFor('mcp', { scopes: ['contacts:read'], reach: apps }).map((t) => t.definition.name)).toEqual(['list_contacts', 'find_contact']);
    expect(toolsFor('mcp', { scopes: ['contacts:read', 'contacts:write'] }).map((t) => t.definition.name)).toEqual([]);
    const added = (await runnerOf('mcp', 'add_contact')!.run({ apps } as never, { name: 'Zed Quill', emails: ['zed@quill.test'], organization: 'Quill' })) as { added: { id: string; organization: string }; url: string };
    expect(added.added).toMatchObject({ source: 'own', organization: 'Quill' });
    expect(added.url).toBe(`https://app.example/contacts/?contact=${encodeURIComponent(added.added.id)}`);
    const found = (await runnerOf('assistant', 'find_contact')!.run({ apps } as never, { q: 'dee' })) as { contacts: { source: string; emails: string[] }[] };
    expect(found.contacts).toEqual([{ id: 'mail:dee@outside.test', source: 'mail', name: 'Dee', emails: ['dee@outside.test'] }]);
    const none = appToolContexts(w.env, async () => null, 'https://app.example');
    await expect(runnerOf('mcp', 'list_contacts')!.run({ apps: none } as never, {})).rejects.toThrow(/join an organization to use Contacts/);
    await expect(runnerOf('mcp', 'list_contacts')!.run({} as never, {})).rejects.toThrow(/not available/);
  });

  it('resolves a contact’s reference by the manifest: the owner, a member once it is shared, never before', async () => {
    const w = world();
    const zed = (await w.call(ANN, 'POST', '/v1/contacts', { name: 'Zed Quill', emails: ['zed@quill.test'] })).j.contact;
    const ref = `org-1/contacts/contact/${zed.id}`;
    const asked = (who: CallerContext) => resolveReferences([ref], { org: async (refs) => refs.map((r) => ({ ref: r, ask: true as const })), docs: async () => null, calendar: async () => null, app: (r) => describeInApp(w.env, r, who, []) });
    expect(await asked(ANN)).toEqual([{ ref, app: 'contacts', kind: 'contact', title: 'Zed Quill', summary: 'zed@quill.test', role: 'owner', icon: '👤', url: `/contacts/?contact=${encodeURIComponent(zed.id)}` }]);
    expect(await asked(BOB)).toEqual([{ ref, denied: true }]);
    await w.call(ANN, 'PUT', '/v1/contacts/share', { org: true });
    expect((await asked(BOB))[0]).toMatchObject({ title: 'Zed Quill', role: 'viewer' });
  });
});
