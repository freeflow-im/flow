// The search index of documents (server/search.ts, docs/specs/search.md §5): kept as documents are written, renamed and
// deleted; rebuilt for documents written before it; filtered by the query's filters and by who may open each hit.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseSearch } from '@flow/shared/search';
import { grant } from './access.ts';
import { TEXT_VERSION } from './search.ts';
import { openDb, type DB } from './db.ts';
import type { Scope, Viewer } from './scope.ts';
import { SheetStore } from './sheets.ts';
import { searchTextOf } from '../shared/searchText.ts';

const harbor = 'ws-harbor';
const annMine: Scope = { ownerId: 'ann', workspaceId: harbor, private: true };
const orgRoot: Scope = { ownerId: 'ann', workspaceId: harbor, private: false };
const reader = (userId: string): Viewer => ({ userId, workspaces: new Set([harbor]), accountId: `acct-${userId}` });
const ann = reader('ann');
const bob = reader('bob');

const para = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const doc = (...texts: string[]) => ({ version: 1, content: { type: 'doc', content: texts.map(para) } }) as never;

let dir: string;
let db: DB;
let sheets: SheetStore;
const find = (who: Viewer, q: string, opts = {}) => sheets.searchContent(who, parseSearch(q), { workspaceId: harbor, ...opts });
const titles = (who: Viewer, q: string, opts = {}) => find(who, q, opts).map((h) => h.title);

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'docs-search-'));
  db = openDb(path.join(dir, 'app.db'));
  for (const id of ['ann', 'bob']) db.prepare("INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, '', '')").run(id, `${id}@x.test`);
  sheets = new SheetStore(db, path.join(dir, 'sheets'));
  await sheets.init();
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('searchTextOf', () => {
  it('reads what a person would read in each kind', () => {
    expect(searchTextOf('doc', doc('Quarterly plan', 'Pricing goes up'))).toBe('Quarterly plan\nPricing goes up');
    expect(searchTextOf('markdown', { version: 1, text: '# Notes\n- **bold** [link](https://x.test) ![pic](a.png)\n> quote' })).toBe('Notes\nbold link pic\nquote');
    const wb = { version: 1, tabs: [{ name: 'Budget', cells: { A1: { v: 'Rent' }, B1: { v: '1200' }, C1: { v: '=SUM(B1:B2)' } } }] };
    expect(searchTextOf('sheet', wb)).toBe('Budget\nRent\n1200');
    const deck = { version: 1, theme: 'x', slides: [{ id: 's', notes: 'say hi', elements: [{ type: 'text', paragraphs: [{ text: 'Roadmap' }] }, { type: 'table', rows: [[{ text: 'Q1' }, { text: 'Launch' }]] }] }] };
    expect(searchTextOf('deck', deck)).toBe('Roadmap\nQ1 Launch\nsay hi');
    expect(searchTextOf('sheet', { version: 1, csv: 'a,b\nc,d' })).toBe('a,b\nc,d');
  });
});

describe('searchContent', () => {
  it('finds a document by its words as it is saved, with a marked snippet, the title weighing more', async () => {
    const plan = await sheets.createDoc(annMine, 'Launch plan', doc('We will raise prices in the spring.'));
    await sheets.createDoc(annMine, 'Notes', doc('Nothing about the launch here, only planning for the plan.'));
    const hits = find(ann, 'launch');
    expect(hits.map((h) => h.title)).toEqual(['Launch plan', 'Notes']);
    expect(find(ann, 'prices')[0]!.snippet).toContain('\u0002prices\u0003');
    // Only the title matched: no snippet of an unrelated body.
    expect(find(ann, 'launch').find((h) => h.title === 'Launch plan')!.snippet).toBe('');
    // Stemming: "pricing" finds "prices"; and a later save replaces the words.
    expect(titles(ann, 'pricing')).toEqual(['Launch plan']);
    await sheets.saveDoc(ann, plan.id, doc('Prices stay the same.'));
    expect(titles(ann, 'spring')).toEqual([]);
    expect(titles(ann, 'stay')).toEqual(['Launch plan']);
  });

  it('a rename changes the title searched; a delete removes the document', async () => {
    const d = await sheets.createDoc(annMine, 'Zebra facts', doc('stripes'));
    sheets.rename(ann, d.id, 'Horse facts');
    expect(titles(ann, 'zebra')).toEqual([]);
    expect(titles(ann, 'horse')).toEqual(['Horse facts']);
    await sheets.delete(ann, d.id);
    expect(titles(ann, 'stripes')).toEqual([]);
  });

  it('never shows a document the viewer cannot open', async () => {
    const secret = await sheets.createDoc(annMine, 'Salary review', doc('confidential numbers'));
    await sheets.createDoc(orgRoot, 'Team handbook', doc('confidential is a word here too'));
    expect(titles(bob, 'confidential')).toEqual(['Team handbook']);
    grant(db, 'sheet', secret.id, 'account:acct-bob', 'viewer', 'ann');
    expect(titles(bob, 'confidential').sort()).toEqual(['Salary review', 'Team handbook']);
    // Another organization's member sees neither.
    const eve: Viewer = { userId: 'eve', workspaces: new Set(['ws-other']), accountId: 'acct-eve' };
    expect(sheets.searchContent(eve, parseSearch('confidential'), { workspaceId: 'ws-other' })).toEqual([]);
  });

  it('filters: type, from, in, is:shared, and dates', async () => {
    await sheets.createMarkdown(annMine, 'Walrus readme', { version: 1, text: 'walrus' }, 'Reports/2026');
    await sheets.createDeck(orgRoot, 'Walrus deck', { version: 1, theme: 'classic', slides: [{ id: 's', elements: [{ type: 'text', paragraphs: [{ text: 'walrus' }] }] }] } as never);
    expect(titles(ann, 'walrus type:markdown')).toEqual(['Walrus readme']);
    expect(titles(ann, 'walrus type:slides')).toEqual(['Walrus deck']);
    expect(titles(ann, 'walrus type:email')).toEqual([]);
    expect(titles(ann, 'walrus in:Reports')).toEqual(['Walrus readme']);
    expect(titles(ann, 'walrus is:shared')).toEqual(['Walrus deck']);
    expect(titles(ann, 'walrus from:bob')).toEqual([]);
    expect(titles(ann, 'walrus from:me').sort()).toEqual(['Walrus deck', 'Walrus readme']);
    expect(titles(ann, 'walrus after:2999-01-01')).toEqual([]);
    expect(titles(ann, 'walrus before:2999-01-01')).toHaveLength(2);
    // Filters alone list by them, most recent first.
    expect(titles(ann, 'type:deck')).toEqual(['Walrus deck']);
  });

  it('search as you type, OR and NOT, and FTS5 syntax typed by a person is only words', async () => {
    await sheets.createDoc(annMine, 'Budget 2027', doc('quarterly budgeting'));
    expect(titles(ann, 'budg', { prefixLast: true })).toEqual(['Budget 2027']);
    expect(titles(ann, 'walrus OR budgeting').length).toBe(3);
    expect(titles(ann, 'walrus -deck')).toEqual(['Walrus readme']);
    expect(() => find(ann, 'NEAR(a b) title:x "unclosed')).not.toThrow();
  });

  it('indexes documents written before search, and documents changed by another path', async () => {
    const old = await sheets.createDoc(annMine, 'Old memo', doc('heron sighting'));
    db.prepare("DELETE FROM search_docs WHERE object_id = ?").run(old.id);
    const changed = await sheets.createDoc(annMine, 'Changed memo', doc('egret'));
    db.prepare("UPDATE sheets SET updated_at = '2999-01-01T00:00:00.000Z' WHERE id = ?").run(changed.id);
    await sheets.reindexStale();
    expect(titles(ann, 'heron')).toEqual(['Old memo']);
    expect(db.prepare("SELECT rev FROM search_docs WHERE object_id = ?").get(changed.id)).toEqual({ rev: `${TEXT_VERSION}:2999-01-01T00:00:00.000Z` });
    // Rows indexed by an older way of taking the words are indexed again.
    db.prepare("UPDATE search_docs SET rev = '1:' || substr(rev, 3), body = 'stale' WHERE object_id = ?").run(old.id);
    await sheets.reindexStale();
    expect(titles(ann, 'heron')).toEqual(['Old memo']);
  });
});

describe('GET /api/search', () => {
  it('answers hits in the shared shape, only the caller’s, and refuses an empty query', async () => {
    const { buildApp } = await import('./app.ts');
    const { mailbox, signUp } = await import('./testing.ts');
    const appDir = mkdtempSync(path.join(tmpdir(), 'docs-search-app-'));
    const box = mailbox();
    const app = await buildApp({ dataDir: appDir, sendMail: box.send, appUrl: 'https://sheets.test', blob: null });
    try {
      const mine = (await signUp(app, box, 'searcher@x.com')).cookie;
      const theirs = (await signUp(app, box, 'other@x.com')).cookie;
      const get = async (url: string, cookie = mine) => {
        const res = await app.inject({ method: 'GET', url, headers: { cookie } });
        return { status: res.statusCode, body: res.json() as { hits: { title: string; kind: string; url: string; snippet: string; source: string }[] } };
      };
      const made = await app.inject({ method: 'POST', url: '/api/markdown', payload: { title: 'Ocelot notes', text: 'The ocelot sleeps all day.' }, headers: { cookie: mine } });
      const id = (made.json() as { doc: { id: string } }).doc.id;

      const found = await get('/api/search?q=ocelot');
      expect(found.status).toBe(200);
      expect(found.body.hits).toEqual([expect.objectContaining({ source: 'docs', kind: 'markdown', title: 'Ocelot notes', url: `/md/${id}` })]);
      expect(found.body.hits[0]!.snippet).toContain('\u0002ocelot\u0003');
      expect((await get('/api/search?q=ocel&prefix=1')).body.hits).toHaveLength(1);
      expect((await get('/api/search?q=ocelot&type=sheet')).body.hits).toEqual([]);
      expect((await get('/api/search?q=ocelot', theirs)).body.hits).toEqual([]);
      expect((await get('/api/search?q=%20')).status).toBe(400);
    } finally {
      await app.close();
      rmSync(appDir, { recursive: true, force: true });
    }
  });
});

describe('the search_content tool', () => {
  it('answers hits with marked snippets, takes filters as fields, and says when nothing matched', async () => {
    const { runServerTool } = await import('./agent/tools.ts');
    await sheets.createDoc(annMine, 'Puffin survey', doc('Puffins nest on the cliffs.'));
    const env = { userId: 'ann', viewer: ann, scope: annMine, sheets, context: { page: 'home' } } as never;
    const found = JSON.parse(await runServerTool('search_content', { query: 'nesting' }, env));
    expect(found.total).toBe(1);
    expect(found.hits[0]).toMatchObject({ kind: 'doc', title: 'Puffin survey', snippet: 'Puffins «nest» on the cliffs.' });
    expect(JSON.parse(await runServerTool('search_content', { query: 'nesting', type: 'sheet' }, env)).total).toBe(0);
    expect(JSON.parse(await runServerTool('search_content', { query: 'nesting', after: '2999-01-01' }, env)).note).toMatch(/Nothing matched/);
    await expect(runServerTool('search_content', { query: '  ' }, env)).rejects.toThrow(/Say what to look for/);
    // Bob does not see Ann's private file.
    expect(JSON.parse(await runServerTool('search_content', { query: 'puffin' }, { ...(env as object), userId: 'bob', viewer: bob, scope: { ...annMine, ownerId: 'bob' } } as never)).total).toBe(0);
  });
});
