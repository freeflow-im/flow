import { describe, expect, it } from 'vitest';
import { planDocsMove, pruneSelection, withParents, parseKey, type MoveSource } from './move';

const U = 'u1', A = 'orgA', B = 'orgB';
const empty = (): MoveSource => ({ users: [], folders: [], sheets: [], stored_files: [], images: [], public_links: [], favorites: [], recent_opens: [], grants: [] });
const opts = { userId: U, from: A, to: B, fromAccountId: 'accA', toAccountId: 'accB', now: '2026-11-08T00:00:00.000Z' };

function source(): MoveSource {
  const s = empty();
  s.users = [{ id: U, email: 'u@example.com', password_hash: '', created_at: 'x' }];
  s.folders = [
    { owner_id: U, workspace_id: A, private: 1, scope: `me:${U}:${A}`, path: 'Mine', created_at: 'x' },
    { owner_id: U, workspace_id: A, private: 0, scope: `org:${A}`, path: 'Team', created_at: 'x' },
    { owner_id: U, workspace_id: A, private: 0, scope: `org:${A}`, path: 'Mine', created_at: 'x' },
  ];
  s.sheets = [
    { id: 's1', owner_id: U, title: 'Budget', kind: 'sheet', file: 's1.json', workspace_id: A, private: 0, folder: '' },
    { id: 's2', owner_id: U, title: 'Plan', kind: 'doc', file: 's2.json', workspace_id: A, private: 1, folder: 'Mine' },
    { id: 's3', owner_id: U, title: 'Deep', kind: 'deck', file: 's3.json', workspace_id: null, private: 0, folder: 'Others/Q4' },
  ];
  s.stored_files = [{ id: 'f1', owner_id: U, filename: 'a.txt', type: 'text/plain', size: 1, workspace_id: A, private: 0, folder: 'Team' }];
  s.images = [{ id: 'i1', owner_id: U, type: 'image/png', size: 3, workspace_id: A }];
  s.grants = [
    { object_kind: 'sheet', object_id: 's1', principal: 'org', role: 'editor', granted_by: 'accA', granted_at: 1, expires_at: null },
    { object_kind: 'sheet', object_id: 's1', principal: 'account:acc9', role: 'viewer', granted_by: 'accA', granted_at: 1, expires_at: null },
    { object_kind: 'sheet', object_id: 's1', principal: 'link:tok1', role: 'viewer', granted_by: 'accA', granted_at: 1, expires_at: null },
    { object_kind: 'folder', object_id: `org:${A}/Team`, principal: 'channel:c1', role: 'viewer', granted_by: 'accA', granted_at: 1, expires_at: null },
    { object_kind: 'folder', object_id: `org:${A}/Team`, principal: 'link:tok2', role: 'viewer', granted_by: 'someone', granted_at: 1, expires_at: null },
    { object_kind: 'sheet', object_id: 'other', principal: 'link:tok3', role: 'viewer', granted_by: 'accA', granted_at: 1, expires_at: null },
  ];
  s.public_links = [
    { token: 'p1', owner_id: U, kind: 'deck', file_id: 's3', workspace_id: A, created_at: 'x' },
    { token: 'p2', owner_id: U, kind: 'file', file_id: 'nope', workspace_id: A, created_at: 'x' },
  ];
  s.favorites = [
    { user_id: U, ref: 'sheet:s1', added_at: 'x' },
    { user_id: U, ref: 'file:f1', added_at: 'x' },
    { user_id: U, ref: `folder:@${A}/Team`, added_at: 'x' },
    { user_id: U, ref: 'folder:Mine', added_at: 'x' },
    { user_id: U, ref: 'doc:someone-elses', added_at: 'x' },
  ];
  s.recent_opens = [{ user_id: U, ref: 'doc:s2', opened_at: 'x' }];
  return s;
}

describe('planDocsMove', () => {
  const plan = planDocsMove(source(), opts);

  it('puts every row in the target organization, private', () => {
    expect(plan.rows.sheets.map((r) => [r.id, r.workspace_id, r.private])).toEqual([['s1', B, 1], ['s2', B, 1], ['s3', B, 1]]);
    expect(plan.rows.stored_files.map((r) => [r.id, r.workspace_id, r.private])).toEqual([['f1', B, 1]]);
    expect(plan.rows.images.map((r) => r.workspace_id)).toEqual([B]);
    expect(plan.rows.public_links.map((r) => [r.token, r.workspace_id])).toEqual([['p1', B]]);
    // s1, s3, f1 and the folders Team and Mine of the organization root were shared.
    expect(plan.madePrivate).toBe(5);
  });

  it('moves every folder to the person\'s root in the target, merging same paths, and makes missing ones', () => {
    const folders = plan.rows.folders.map((f) => [f.path, f.scope, f.workspace_id, f.private]);
    expect(folders).toEqual([
      ['Mine', `me:${U}:${B}`, B, 1],
      ['Team', `me:${U}:${B}`, B, 1],
      ['Others', `me:${U}:${B}`, B, 1],
      ['Others/Q4', `me:${U}:${B}`, B, 1],
    ]);
    expect(plan.foldersMade).toBe(2);
    expect(plan.objects.filter((o) => o.key.startsWith('folder:')).map((o) => o.target)).toEqual([`folder:me:${U}:${B}/Mine`, `folder:me:${U}:${B}/Team`, `folder:me:${U}:${B}/Mine`]);
  });

  it('keeps link grants on the target ids and drops the organization\'s', () => {
    expect(plan.rows.grants.map((g) => [g.object_kind, g.object_id, g.principal, g.granted_by])).toEqual([
      ['sheet', 's1', 'link:tok1', 'accB'],
      ['folder', `me:${U}:${B}/Team`, 'link:tok2', 'someone'],
    ]);
    expect(plan.dropped.map((d) => d.principal)).toEqual(['org', 'account:acc9', 'channel:c1']);
    expect(plan.links).toEqual([
      { kind: 'sheet', id: 's1', principal: 'link:tok1', role: 'viewer', title: 'Budget', fileKind: 'sheet' },
      { kind: 'folder', id: `me:${U}:${B}/Team`, principal: 'link:tok2', role: 'viewer', title: 'Team', fileKind: 'folder' },
    ]);
  });

  it('moves favorites and recents of moved things, organization folders as My files folders', () => {
    expect(plan.rows.favorites.map((f) => f.ref)).toEqual(['sheet:s1', 'file:f1', 'folder:Team', 'folder:Mine']);
    expect(plan.rows.recent_opens.map((f) => f.ref)).toEqual(['doc:s2']);
  });

  it('lists each body, with the optional ones', () => {
    expect(plan.bodies.filter((b) => !b.optional).map((b) => b.path)).toEqual(['data/sheets/s1.json', 'data/sheets/s2.json', 'data/sheets/s3.json', 'data/files/f1', 'data/images/i1']);
    expect(plan.bodies.filter((b) => b.optional).map((b) => b.path)).toEqual(['data/sheets/s1.base.json', 'data/sheets/s2.base.json', 'data/sheets/s3.base.json', 'data/files/f1.prev']);
  });

  it('takes only what the person owns', () => {
    const s = source();
    s.sheets.push({ id: 'x', owner_id: 'someone', title: 'Theirs', kind: 'sheet', file: 'x.json', workspace_id: A, private: 0, folder: '' });
    s.users.push({ id: 'someone' });
    const p = planDocsMove(s, opts);
    expect(p.rows.sheets.map((r) => r.id)).not.toContain('x');
    expect(p.rows.users.map((r) => r.id)).toEqual([U]);
  });
});

describe('pruneSelection', () => {
  const plan = planDocsMove(source(), opts);

  it('takes only what the target has, and what hangs off it', () => {
    const sel = pruneSelection(plan, ['sheet:s1', 'file:f1', `folder:me:${U}:${B}/Team`]);
    expect(sel.sheets).toEqual(['s1']);
    expect(sel.stored_files).toEqual(['f1']);
    expect(sel.images).toEqual([]);
    expect(sel.folders).toEqual([{ scope: `org:${A}`, path: 'Team' }]);
    expect(sel.bodies).toEqual(['data/sheets/s1.json', 'data/sheets/s1.base.json', 'data/files/f1', 'data/files/f1.prev']);
    expect(sel.favorites).toEqual(['sheet:s1', 'file:f1', `folder:@${A}/Team`]);
    expect(sel.recent_opens).toEqual([]);
    expect(sel.grants.map((g) => g.principal)).toEqual(['org', 'account:acc9', 'link:tok1', 'channel:c1', 'link:tok2']);
    expect(sel.indexIds.sort()).toEqual(['f1', 's1', 'tok1', 'tok2']);
  });

  it('a folder merged in the target prunes both source folders', () => {
    const sel = pruneSelection(plan, [`folder:me:${U}:${B}/Mine`]);
    expect(sel.folders).toEqual([{ scope: `me:${U}:${A}`, path: 'Mine' }, { scope: `org:${A}`, path: 'Mine' }]);
    expect(sel.favorites).toEqual(['folder:Mine']);
  });

  it('nothing in the target, nothing pruned', () => {
    const sel = pruneSelection(plan, []);
    expect(Object.values(sel).every((v) => Array.isArray(v) && v.length === 0)).toBe(true);
  });
});

describe('helpers', () => {
  it('withParents', () => {
    expect(withParents('a/b/c')).toEqual(['a/b/c', 'a/b', 'a']);
    expect(withParents('')).toEqual([]);
  });
  it('parseKey', () => {
    expect(parseKey('folder:me:u:o/a/b')).toEqual({ table: 'folders', scope: 'me:u:o', path: 'a/b' });
    expect(parseKey('folder:org:o/')).toEqual({ table: 'folders', scope: 'org:o', path: '' });
    expect(parseKey('image:i')).toEqual({ table: 'images', id: 'i' });
    expect(parseKey('what:x')).toBeNull();
  });
});
