import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import {
  GRANTS_DDL, ORG_PRINCIPAL, ROLE_RANK, accountPrincipal, atLeast, channelPrincipal, effectiveRole, grantFromRow,
  grantSql, grantsForChainSql, linkPrincipal, maxRole, objectsSharedWithSql, parsePrincipal, principalsOf, revokeAllSql,
  revokeSql, type ChainLink, type GrantReader, type GrantRow,
} from './grants.js';
import { ROLES, type Grant, type GrantPrincipal, type Role } from './platform.js';

const T0 = Date.parse('2026-11-06T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const grant = (objectKind: string, objectId: string, principal: GrantPrincipal, role: Role, expiresAt?: number): Grant => ({
  objectKind, objectId, principal, role, grantedBy: 'acc_ann', grantedAt: iso(T0 - 1000),
  ...(expiresAt !== undefined ? { expiresAt: iso(expiresAt) } : {}),
});
const ann: GrantReader = { accountId: 'acc_ann', channelIds: [] };
const bob: GrantReader = { accountId: 'acc_bob', channelIds: ['ch_sales', 'ch_eng'] };

describe('principals', () => {
  it('formats and parses each kind', () => {
    expect(accountPrincipal('a1')).toBe('account:a1');
    expect(channelPrincipal('c1')).toBe('channel:c1');
    expect(linkPrincipal('tok')).toBe('link:tok');
    expect(parsePrincipal('account:a1')).toEqual({ kind: 'account', id: 'a1' });
    expect(parsePrincipal('channel:c:1')).toEqual({ kind: 'channel', id: 'c:1' });
    expect(parsePrincipal(ORG_PRINCIPAL)).toEqual({ kind: 'org' });
    expect(parsePrincipal('link:tok')).toEqual({ kind: 'link', id: 'tok' });
    expect(() => parsePrincipal('group:x')).toThrow();
    expect(() => parsePrincipal('account:')).toThrow();
  });

  it('principalsOf: account, org, channels sorted, links sorted, each once', () => {
    expect(principalsOf({ accountId: 'a', channelIds: ['z', 'b', 'z'], linkTokens: ['t2', 't1'] }))
      .toEqual(['account:a', 'org', 'channel:b', 'channel:z', 'link:t1', 'link:t2']);
    expect(principalsOf(ann)).toEqual(['account:acc_ann', 'org']);
  });
});

describe('roles', () => {
  it('ranks and the full atLeast matrix', () => {
    expect(ROLE_RANK).toEqual({ viewer: 1, editor: 2, manager: 3, owner: 4 });
    for (const role of ROLES) for (const needed of ROLES) {
      expect(atLeast(role, needed)).toBe(ROLES.indexOf(role) >= ROLES.indexOf(needed));
    }
    expect(atLeast(null, 'viewer')).toBe(false);
  });

  it('maxRole', () => {
    for (const a of ROLES) for (const b of ROLES) {
      expect(maxRole(a, b)).toBe(ROLES.indexOf(a) >= ROLES.indexOf(b) ? a : b);
    }
    expect(maxRole(null, 'viewer')).toBe('viewer');
    expect(maxRole('editor', null)).toBe('editor');
    expect(maxRole(null, null)).toBeNull();
  });
});

describe('effectiveRole', () => {
  const chain = (...links: [string, string, Grant[]][]): ChainLink[] => links.map(([objectKind, objectId, grants]) => ({ objectKind, objectId, grants }));

  it('each principal kind grants its role, and nothing else matches', () => {
    for (const role of ROLES.filter(r => r !== 'owner')) {
      const on = (p: GrantPrincipal) => effectiveRole({ reader: { ...bob, linkTokens: ['tok'] }, ownerAccountId: 'acc_ann', chain: chain(['file', 'f1', [grant('file', 'f1', p, role)]]), now: T0 });
      expect(on('account:acc_bob')).toBe(role);
      expect(on('channel:ch_eng')).toBe(role);
      expect(on('org')).toBe(role);
      expect(on('link:tok')).toBe(role);
      expect(on('account:acc_carol')).toBeNull();
      expect(on('channel:ch_other')).toBeNull();
      expect(on('link:other')).toBeNull();
    }
  });

  it('inherits down the chain and takes the highest role from any link', () => {
    const c = chain(
      ['file', 'f1', [grant('file', 'f1', 'account:acc_bob', 'viewer')]],
      ['folder', 'sub', []],
      ['folder', 'root', [grant('folder', 'root', 'channel:ch_sales', 'manager')]],
    );
    expect(effectiveRole({ reader: bob, ownerAccountId: 'acc_ann', chain: c, now: T0 })).toBe('manager');
    // A grant on the object never lowers what a container gives.
    expect(effectiveRole({ reader: bob, ownerAccountId: 'acc_ann', chain: c.slice(0, 1), now: T0 })).toBe('viewer');
    expect(effectiveRole({ reader: { accountId: 'acc_carol', channelIds: [] }, ownerAccountId: 'acc_ann', chain: c, now: T0 })).toBeNull();
  });

  it('ignores an expired grant, from its expiry instant on', () => {
    const c = chain(['file', 'f1', [grant('file', 'f1', 'link:tok', 'editor', T0 + 60_000), grant('file', 'f1', 'org', 'viewer')]]);
    const at = (now: number) => effectiveRole({ reader: { ...ann, accountId: 'acc_x', linkTokens: ['tok'] }, ownerAccountId: 'acc_ann', chain: c, now });
    expect(at(T0)).toBe('editor');
    expect(at(T0 + 60_000)).toBe('viewer');
    expect(at(T0 + 120_000)).toBe('viewer');
  });

  it('the owner column beats everything, grants or none', () => {
    expect(effectiveRole({ reader: ann, ownerAccountId: 'acc_ann', chain: [], now: T0 })).toBe('owner');
    expect(effectiveRole({ reader: ann, ownerAccountId: 'acc_ann', chain: chain(['file', 'f1', [grant('file', 'f1', 'account:acc_ann', 'viewer')]]), now: T0 })).toBe('owner');
    expect(effectiveRole({ reader: ann, ownerAccountId: null, chain: [], now: T0 })).toBeNull();
  });
});

// Today's two-scope Docs model, and Chat's channel artifacts, expressed as grants (platform.md §4.3).
describe("today's model", () => {
  it('a private Docs file: the owner only, no grants', () => {
    const c: ChainLink[] = [{ objectKind: 'file', objectId: 'f1', grants: [] }, { objectKind: 'folder', objectId: 'me:acc_ann', grants: [] }];
    expect(effectiveRole({ reader: ann, ownerAccountId: 'acc_ann', chain: c, now: T0 })).toBe('owner');
    expect(effectiveRole({ reader: bob, ownerAccountId: 'acc_ann', chain: c, now: T0 })).toBeNull();
  });

  it('Organization files: one grant, org as editor on the root folder', () => {
    const c: ChainLink[] = [
      { objectKind: 'file', objectId: 'f2', grants: [] },
      { objectKind: 'folder', objectId: 'org-root', grants: [grant('folder', 'org-root', ORG_PRINCIPAL, 'editor')] },
    ];
    expect(effectiveRole({ reader: bob, ownerAccountId: 'acc_ann', chain: c, now: T0 })).toBe('editor');
    expect(effectiveRole({ reader: { accountId: 'acc_new', channelIds: [] }, ownerAccountId: 'acc_ann', chain: c, now: T0 })).toBe('editor');
    expect(effectiveRole({ reader: ann, ownerAccountId: 'acc_ann', chain: c, now: T0 })).toBe('owner');
  });

  it("a channel's artifacts: the channel as editor on the channel container", () => {
    const c: ChainLink[] = [
      { objectKind: 'artifact', objectId: 'art1', grants: [] },
      { objectKind: 'channel', objectId: 'ch_sales', grants: [grant('channel', 'ch_sales', channelPrincipal('ch_sales'), 'editor')] },
    ];
    expect(effectiveRole({ reader: bob, ownerAccountId: 'acc_ann', chain: c, now: T0 })).toBe('editor');
    expect(effectiveRole({ reader: { accountId: 'acc_out', channelIds: ['ch_eng'] }, ownerAccountId: 'acc_ann', chain: c, now: T0 })).toBeNull();
  });
});

describe('SQL helpers', () => {
  it('grantsForChainSql: one query, kind/id pairs in chain order', () => {
    const q = grantsForChainSql([{ objectKind: 'file', objectId: 'f1' }, { objectKind: 'folder', objectId: 'root' }]);
    expect(q.sql).toContain('(object_kind = ? AND object_id = ?) OR (object_kind = ? AND object_id = ?)');
    expect(q.params).toEqual(['file', 'f1', 'folder', 'root']);
    expect(grantsForChainSql([]).params).toEqual([]);
  });

  it("objectsSharedWithSql: the reader's principals but org, then kind, then now", () => {
    const q = objectsSharedWithSql({ ...bob, linkTokens: ['tok'] }, 'file', T0);
    expect(q.params).toEqual(['account:acc_bob', 'channel:ch_eng', 'channel:ch_sales', 'link:tok', 'file', T0]);
    expect(q.sql).toContain('principal IN (?, ?, ?, ?)');
    expect(objectsSharedWithSql(ann, undefined, T0).params).toEqual(['account:acc_ann', T0]);
  });

  it('mutations', () => {
    const g = grant('file', 'f1', 'account:acc_bob', 'editor', T0 + 5000);
    expect(grantSql(g).params).toEqual(['file', 'f1', 'account:acc_bob', 'editor', 'acc_ann', T0 - 1000, T0 + 5000]);
    expect(grantSql({ ...g, expiresAt: undefined } as unknown as Grant).params.at(-1)).toBeNull();
    expect(revokeSql('file', 'f1', 'org').params).toEqual(['file', 'f1', 'org']);
    expect(revokeAllSql('file', 'f1').params).toEqual(['file', 'f1']);
  });

  it('runs end to end on node:sqlite', () => {
    const db = new DatabaseSync(':memory:');
    const run = (s: { sql: string; params: (string | number | null)[] }) => db.prepare(s.sql).run(...s.params);
    const all = (s: { sql: string; params: (string | number | null)[] }) => db.prepare(s.sql).all(...s.params) as unknown as GrantRow[];
    for (const ddl of GRANTS_DDL) db.exec(ddl);
    for (const ddl of GRANTS_DDL) db.exec(ddl); // idempotent

    run(grantSql(grant('file', 'f1', 'account:acc_bob', 'viewer')));
    run(grantSql(grant('file', 'f1', 'account:acc_bob', 'editor'))); // upsert, not a second row
    run(grantSql(grant('folder', 'root', 'channel:ch_sales', 'manager')));
    run(grantSql(grant('file', 'f2', 'link:tok', 'viewer', T0 - 1)));
    run(grantSql(grant('file', 'f3', ORG_PRINCIPAL, 'editor')));

    const chainRefs = [{ objectKind: 'file', objectId: 'f1' }, { objectKind: 'folder', objectId: 'root' }];
    const rows = all(grantsForChainSql(chainRefs)).map(grantFromRow);
    expect(rows).toHaveLength(2);
    expect(rows.find(r => r.objectId === 'f1')).toMatchObject({ role: 'editor', grantedAt: iso(T0 - 1000) });
    const linkChain: ChainLink[] = chainRefs.map(c => ({ ...c, grants: rows.filter(r => r.objectKind === c.objectKind && r.objectId === c.objectId) }));
    expect(effectiveRole({ reader: bob, ownerAccountId: 'acc_ann', chain: linkChain, now: T0 })).toBe('manager');

    const shared = all(objectsSharedWithSql({ ...bob, linkTokens: ['tok'] }, undefined, T0)).map(r => `${r.object_kind}/${r.object_id}`).sort();
    expect(shared).toEqual(['file/f1', 'folder/root']); // f2's link expired; f3 is org-wide
    expect(all(objectsSharedWithSql(bob, 'folder', T0)).map(r => r.object_id)).toEqual(['root']);

    run(revokeSql('file', 'f1', 'account:acc_bob'));
    expect(all(grantsForChainSql(chainRefs))).toHaveLength(1);
    run(revokeAllSql('folder', 'root'));
    expect(all(grantsForChainSql(chainRefs))).toHaveLength(0);
    db.close();
  });
});
