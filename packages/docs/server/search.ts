// The search index of documents (docs/specs/search.md §2.2 and §5): an FTS5 table over the words of every document in
// `sheets`, kept by SheetStore as it writes them (server/sheets.ts). The filter columns stay in `sheets`, joined at query
// time, so a move, a share or a new owner needs no reindexing; `rev` is the document's `updated_at` when it was indexed,
// so a row whose document changed since (or one with no index row) is stale, and `staleDocuments` finds it.
//
// A hit is checked with `roleOf` (server/access.ts), the one access check Docs has, before anything of it is returned.
import { hasSearchWords, toFtsMatch, type SearchHit, type SearchKind, type SearchQuery } from '@flow/shared/search';
import type { DocKind } from '../shared/types.ts';
import { roleOf } from './access.ts';
import type { DB } from './db.ts';
import { viewerOf, type ViewerArg } from './scope.ts';

export const SEARCH_DDL = `
  CREATE TABLE IF NOT EXISTS search_docs (
    rowid INTEGER PRIMARY KEY,
    object_kind TEXT NOT NULL,
    object_id TEXT NOT NULL,
    rev TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    UNIQUE (object_kind, object_id)
  );
  CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
    title, body, content='search_docs', content_rowid='rowid', tokenize='porter unicode61 remove_diacritics 2', prefix='2 3'
  );
  CREATE TRIGGER IF NOT EXISTS search_docs_ai AFTER INSERT ON search_docs BEGIN
    INSERT INTO search_fts (rowid, title, body) VALUES (new.rowid, new.title, new.body);
  END;
  CREATE TRIGGER IF NOT EXISTS search_docs_ad AFTER DELETE ON search_docs BEGIN
    INSERT INTO search_fts (search_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
  END;
  CREATE TRIGGER IF NOT EXISTS search_docs_au AFTER UPDATE ON search_docs BEGIN
    INSERT INTO search_fts (search_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
    INSERT INTO search_fts (rowid, title, body) VALUES (new.rowid, new.title, new.body);
  END;
  CREATE TRIGGER IF NOT EXISTS search_sheet_deleted AFTER DELETE ON sheets BEGIN
    DELETE FROM search_docs WHERE object_kind = 'sheet' AND object_id = OLD.id;
  END;
`;

/** Put a document's words in the index, or replace them. */
export function indexDocument(db: DB, id: string, rev: string, title: string, body: string): void {
  db.prepare(
    `INSERT INTO search_docs (object_kind, object_id, rev, title, body) VALUES ('sheet', ?, ?, ?, ?)
     ON CONFLICT (object_kind, object_id) DO UPDATE SET rev = excluded.rev, title = excluded.title, body = excluded.body`,
  ).run(id, rev, title, body);
}

/** A renamed document: its title in the index, and its revision, so the rename does not make it stale. */
export function retitleDocument(db: DB, id: string, rev: string, title: string): void {
  db.prepare("UPDATE search_docs SET title = ?, rev = ? WHERE object_kind = 'sheet' AND object_id = ?").run(title, rev, id);
}

/** Documents with no index row, or whose row is older than the document, newest first. */
export function staleDocuments(db: DB, limit: number): { id: string }[] {
  return db
    .prepare(
      `SELECT s.id FROM sheets s LEFT JOIN search_docs d ON d.object_kind = 'sheet' AND d.object_id = s.id
       WHERE d.object_id IS NULL OR d.rev <> s.updated_at ORDER BY s.updated_at DESC LIMIT ?`,
    )
    .all(limit) as { id: string }[];
}

export interface DocSearchOptions {
  /** The organization searched in: its shared files and the viewer's own files there (and from before organizations).
   * Without one, the viewer's own files and those of every organization they are in. */
  workspaceId?: string | null;
  limit?: number;
  /** Search as you type: the last word is a prefix. */
  prefixLast?: boolean;
}

export interface DocHitRow {
  id: string;
  kind: DocKind;
  title: string;
  folder: string;
  owner_id: string;
  workspace_id: string | null;
  private: number;
  updated_at: string;
  snippet: string;
  rank: number;
}

const DOC_KINDS: readonly SearchKind[] = ['doc', 'sheet', 'deck', 'markdown'];

/**
 * The documents that match, best first (most recently edited first for a query of filters alone), that the viewer may
 * open. A query that asks only for kinds documents are not (`type:email`) finds nothing.
 */
export function searchDocuments(db: DB, who: ViewerArg, query: SearchQuery, opts: DocSearchOptions = {}): DocHitRow[] {
  const viewer = viewerOf(who);
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const f = query.filters;
  const kinds = f.types ? f.types.filter((k) => DOC_KINDS.includes(k)) : null;
  if (kinds && !kinds.length) return [];
  const match = hasSearchWords(query) ? toFtsMatch(query, { prefixLast: opts.prefixLast }) : null;

  const where: string[] = [];
  const params: (string | number)[] = [];
  // Which rows could be the viewer's at all; roleOf decides each hit below.
  if (opts.workspaceId) {
    where.push('((s.owner_id = ? AND (s.workspace_id = ? OR s.workspace_id IS NULL)) OR s.workspace_id = ?)');
    params.push(viewer.userId, opts.workspaceId, opts.workspaceId);
  } else if (viewer.workspaces.size) {
    where.push(`(s.owner_id = ? OR s.workspace_id IN (${[...viewer.workspaces].map(() => '?').join(', ')}))`);
    params.push(viewer.userId, ...viewer.workspaces);
  } else {
    where.push('s.owner_id = ?');
    params.push(viewer.userId);
  }
  if (kinds) {
    where.push(`s.kind IN (${kinds.map(() => '?').join(', ')})`);
    params.push(...kinds);
  }
  if (f.after) {
    where.push('s.updated_at >= ?');
    params.push(f.after);
  }
  if (f.before) {
    where.push('s.updated_at < ?');
    params.push(f.before);
  }
  if (f.from?.length) {
    const owners = f.from.map((a) => (a.toLowerCase() === 'me' ? viewer.userId : a));
    where.push(`s.owner_id IN (${owners.map(() => '?').join(', ')})`);
    params.push(...owners);
  }
  if (f.in) {
    const folder = f.in.replace(/^\/+|\/+$/g, '');
    where.push("(s.folder = ? OR s.folder LIKE ? ESCAPE '\\')");
    params.push(folder, `${folder.replace(/[\\%_]/g, (c) => `\\${c}`)}/%`);
  }
  if (f.is?.includes('shared')) where.push('s.private = 0');

  // More candidates than asked for: some may be dropped by the access check.
  const candidates = Math.min(limit * 3, 300);
  const cols = 's.id, s.kind, s.title, s.folder, s.owner_id, s.workspace_id, s.private, s.updated_at';
  const rows = match
    ? (db
        .prepare(
          `SELECT ${cols}, snippet(search_fts, 1, char(2), char(3), '…', 16) AS snippet, bm25(search_fts, 5.0, 1.0) AS rank
           FROM search_fts JOIN search_docs d ON d.rowid = search_fts.rowid JOIN sheets s ON d.object_kind = 'sheet' AND s.id = d.object_id
           WHERE search_fts MATCH ? AND ${where.join(' AND ')} ORDER BY rank LIMIT ?`,
        )
        .all(match, ...params, candidates) as unknown as DocHitRow[])
    : (db
        .prepare(`SELECT ${cols}, '' AS snippet, 0 AS rank FROM sheets s WHERE ${where.join(' AND ')} ORDER BY s.updated_at DESC LIMIT ?`)
        .all(...params, candidates) as unknown as DocHitRow[]);

  const out: DocHitRow[] = [];
  for (const r of rows) {
    if (out.length >= limit) break;
    if (roleOf(db, viewer, 'sheet', r)) out.push({ ...r, snippet: r.snippet ?? '' });
  }
  return out;
}

/** Each kind's page in the app (the client's routes; plugin/server/files.ts `placed` names them too). */
export const DOC_PAGES: Record<DocKind, string> = { sheet: 's', doc: 'doc', deck: 'd', markdown: 'md' };

/** A hit as every source returns it (`@flow/shared/search`); `url` is the page inside the Docs app. */
export const toSearchHit = (r: DocHitRow): SearchHit => ({
  source: 'docs',
  kind: r.kind,
  id: r.id,
  title: r.title,
  snippet: r.snippet,
  author: r.owner_id,
  at: r.updated_at,
  ...(r.folder ? { container: r.folder } : {}),
  url: `/${DOC_PAGES[r.kind]}/${encodeURIComponent(r.id)}`,
  rank: r.rank,
});
