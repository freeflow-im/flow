// Search over an organization's messages (docs/specs/search.md §2 and phase 2): an FTS5 index beside `messages`, whose
// bodies stay AES-GCM encrypted; the index holds their words in plain text (ruling 2026-11-13). A message is indexed as
// it is sent or edited (`indexMessage`), with mentions as the names they stand for and the names of its files; SQL
// triggers drop it when it is deleted. `rev` is MESSAGE_TEXT_VERSION and the message's last change, so a message the
// hooks missed, or one indexed by an older way of taking its words, is stale, and `reindexMessages` indexes it.
//
// Who may see a hit is the rule of requireChannelAccess (services/channels.ts), applied in the query: a member of the
// organization, in a channel they are in or one that is not private (direct messages always are).
import { and, eq, sql, type SQL } from 'drizzle-orm';
import { hasSearchWords, toFtsMatch, type SearchHit, type SearchQuery } from '@flow/shared/search';
import { addressOf } from '@flow/shared/addresses';
import { db, schema } from '../db/index.js';
import { decryptBody } from '../crypto/index.js';
import { requireMembership } from './workspaces.js';
import { inList } from '../sqlList.js';

/** A list as one bound JSON string, read back with json_each: Durable Object SQLite binds at most ~100 variables per
 * statement, and a batch here is longer (sqlList.ts). */
const jsonList = (values: readonly string[]) => sql`(SELECT value FROM json_each(${JSON.stringify(values)}))`;

const { messages } = schema;

/** How a message's words are taken (`messageText`): one more after a change to it, and every message is indexed again. */
export const MESSAGE_TEXT_VERSION = 1;
const REV_PREFIX = `${MESSAGE_TEXT_VERSION}:`;

/** Run by the Org object at start (object.ts) and by the tests' storage: the index and the triggers that keep it. */
export const MESSAGE_SEARCH_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS search_messages (rowid INTEGER PRIMARY KEY, message_id TEXT NOT NULL UNIQUE, rev TEXT NOT NULL, body TEXT NOT NULL)`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS search_messages_fts USING fts5(body, content='search_messages', content_rowid='rowid', tokenize='porter unicode61 remove_diacritics 2', prefix='2 3')`,
  `CREATE TRIGGER IF NOT EXISTS search_messages_ai AFTER INSERT ON search_messages BEGIN INSERT INTO search_messages_fts (rowid, body) VALUES (new.rowid, new.body); END`,
  `CREATE TRIGGER IF NOT EXISTS search_messages_ad AFTER DELETE ON search_messages BEGIN INSERT INTO search_messages_fts (search_messages_fts, rowid, body) VALUES ('delete', old.rowid, old.body); END`,
  `CREATE TRIGGER IF NOT EXISTS search_messages_au AFTER UPDATE ON search_messages BEGIN INSERT INTO search_messages_fts (search_messages_fts, rowid, body) VALUES ('delete', old.rowid, old.body); INSERT INTO search_messages_fts (rowid, body) VALUES (new.rowid, new.body); END`,
  // A deleted message keeps its row as a tombstone (deleteMessage); a channel's deletion removes its messages outright.
  `CREATE TRIGGER IF NOT EXISTS search_message_deleted AFTER UPDATE OF deleted_at ON messages WHEN NEW.deleted_at IS NOT NULL BEGIN DELETE FROM search_messages WHERE message_id = NEW.id; END`,
  `CREATE TRIGGER IF NOT EXISTS search_message_gone AFTER DELETE ON messages BEGIN DELETE FROM search_messages WHERE message_id = OLD.id; END`,
];

type MessageRow = typeof messages.$inferSelect;

/** The text a message is found by: its body with `<@id>` as `@Name`, and the names of the files it carries. */
function messageText(row: MessageRow, names: Map<string, string>, fileNames: string[]): string {
  const body = decryptBody(row).replace(/<@([0-9a-f-]{36})>/g, (_, id: string) => `@${names.get(id) ?? 'someone'}`);
  return [body, ...fileNames].filter(Boolean).join('\n');
}

const revOf = (row: MessageRow) => `${REV_PREFIX}${(row.editedAt ?? row.createdAt).getTime()}`;

function userNames(): Map<string, string> {
  return new Map(db.all<{ id: string; display_name: string }>(sql`SELECT id, display_name FROM users`).map((r) => [r.id, r.display_name]));
}

function fileNamesOf(ids: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!ids.length) return out;
  const rows = db.all<{ message_id: string; name: string }>(
    sql`SELECT mf.message_id, f.name FROM message_files mf JOIN files f ON f.id = mf.file_id WHERE mf.message_id IN ${jsonList(ids)}`,
  );
  for (const r of rows) out.set(r.message_id, [...(out.get(r.message_id) ?? []), r.name]);
  return out;
}

function upsert(row: MessageRow, text: string): void {
  db.run(sql`INSERT INTO search_messages (message_id, rev, body) VALUES (${row.id}, ${revOf(row)}, ${text})
    ON CONFLICT (message_id) DO UPDATE SET rev = excluded.rev, body = excluded.body`);
}

/**
 * Put a message's words in the index, or replace them; a system line ("joined the channel") or a deleted message is left
 * out. Never throws: a failure is logged, and the background pass indexes the message later.
 */
export async function indexMessage(id: string): Promise<void> {
  try {
    const row = (await db.select().from(messages).where(eq(messages.id, id)).limit(1))[0];
    if (!row || row.deletedAt || row.systemKind) return;
    upsert(row, messageText(row, userNames(), fileNamesOf([id]).get(id) ?? []));
  } catch (err) {
    console.error(`search index message ${id}: ${(err as Error).message}`);
  }
}

/**
 * Index up to `batch` messages that have no index row or an older one, newest first, and say how many it looked at: the
 * caller (the Org object) runs it again, between other work, until it answers fewer than `batch`.
 */
export async function reindexMessages(batch = 200): Promise<number> {
  const stale = db.all<{ id: string }>(sql`SELECT m.id FROM messages m LEFT JOIN search_messages s ON s.message_id = m.id
    WHERE m.deleted_at IS NULL AND m.system_kind IS NULL
      AND (s.message_id IS NULL OR s.rev <> ${REV_PREFIX} || COALESCE(m.edited_at, m.created_at))
    ORDER BY m.created_at DESC LIMIT ${batch}`);
  if (!stale.length) return 0;
  const ids = stale.map((r) => r.id);
  const rows = await db.select().from(messages).where(inList(messages.id, ids));
  const names = userNames();
  const fileNames = fileNamesOf(ids);
  for (const row of rows) {
    try {
      upsert(row, messageText(row, names, fileNames.get(row.id) ?? []));
    } catch (err) {
      // A body that cannot be read is indexed empty, so it is not tried again until it changes.
      console.error(`search index message ${row.id}: ${(err as Error).message}`);
      upsert(row, '');
    }
  }
  return stale.length;
}

/** A message found, as every source's hits are (`@flow/shared/search`), with what Chat needs to show and open it. */
export interface MessageSearchHit extends SearchHit {
  channelId: string;
  /** The channel's name; null for a direct message. */
  channelName: string | null;
  channelKind: 'standard' | 'dm' | 'group_dm';
  threadRootId: string | null;
  authorName: string;
}

export interface MessageSearchOptions {
  limit?: number;
  /** `recent`: newest first; `relevance` (the default with words): best match first. */
  sort?: 'relevance' | 'recent';
  /** Search as you type: the last word is a prefix. */
  prefixLast?: boolean;
  /** Channels only, never direct messages: what a person's assistant may search (agents.md §1.1). */
  channelsOnly?: boolean;
}

interface HitRow {
  id: string;
  channel_id: string;
  user_id: string;
  thread_root_id: string | null;
  created_at: number;
  channel_name: string | null;
  channel_kind: 'standard' | 'dm' | 'group_dm';
  author_name: string | null;
  snippet: string;
  rank: number;
}

/** The users `from:` names: `me`, ids, addresses, or display names (whole, any case), among the organization's members. */
function authorsNamed(workspaceId: string, userId: string, values: string[]): string[] {
  const ids = new Set<string>();
  for (const v of values) {
    const value = v.replace(/^@/, '').trim();
    if (value.toLowerCase() === 'me') {
      ids.add(userId);
      continue;
    }
    const rows = db.all<{ id: string }>(sql`SELECT u.id FROM users u JOIN workspace_members wm ON wm.user_id = u.id AND wm.workspace_id = ${workspaceId}
      WHERE u.id = ${value} OR LOWER(u.email) = LOWER(${value}) OR LOWER(u.display_name) = LOWER(${value}) OR LOWER(u.agent_username) = LOWER(${value})`);
    for (const r of rows) ids.add(r.id);
  }
  return [...ids];
}

/** The channel `in:` names: its id or its name, with or without `#`. */
function channelNamed(workspaceId: string, value: string): string | null {
  const v = value.replace(/^#/, '').trim();
  const row = db.all<{ id: string }>(sql`SELECT id FROM channels WHERE workspace_id = ${workspaceId} AND (id = ${v} OR LOWER(name) = LOWER(${v})) LIMIT 1`)[0];
  return row?.id ?? null;
}

/**
 * The messages that match, that the user may read, best match first (or newest first with `sort: 'recent'`, and always
 * for a query of filters alone). A query asking only for kinds messages are not (`type:doc`) finds nothing, as does a
 * `from:` or `in:` that names no one or nothing.
 */
export async function searchMessages(workspaceId: string, userId: string, query: SearchQuery, opts: MessageSearchOptions = {}): Promise<MessageSearchHit[]> {
  await requireMembership(workspaceId, userId);
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const f = query.filters;
  if (f.types && !f.types.includes('message')) return [];

  const where: SQL[] = [
    sql`c.workspace_id = ${workspaceId}`,
    sql`m.deleted_at IS NULL`,
    // requireChannelAccess: a channel the user is in, or one that is not private.
    sql`(c.is_private = 0 OR EXISTS (SELECT 1 FROM channel_members cm WHERE cm.channel_id = c.id AND cm.user_id = ${userId}))`,
  ];
  if (opts.channelsOnly) where.push(sql`c.kind = 'standard'`);
  if (f.from?.length) {
    const authors = authorsNamed(workspaceId, userId, f.from);
    if (!authors.length) return [];
    where.push(sql`m.user_id IN ${jsonList(authors)}`);
  }
  if (f.in) {
    const channel = channelNamed(workspaceId, f.in);
    if (!channel) return [];
    where.push(sql`m.channel_id = ${channel}`);
  }
  if (f.after) where.push(sql`m.created_at >= ${Date.parse(f.after)}`);
  if (f.before) where.push(sql`m.created_at < ${Date.parse(f.before)}`);
  if (f.has?.includes('attachment')) where.push(sql`EXISTS (SELECT 1 FROM message_files mf WHERE mf.message_id = m.id)`);
  if (f.has?.includes('link')) where.push(sql`s.body LIKE '%://%'`);

  const match = hasSearchWords(query) ? toFtsMatch(query, { prefixLast: opts.prefixLast }) : null;
  const recent = !match || opts.sort === 'recent';
  const cols = sql`m.id, m.channel_id, m.user_id, m.thread_root_id, m.created_at, c.name AS channel_name, c.kind AS channel_kind, u.display_name AS author_name`;
  const joins = sql`JOIN messages m ON m.id = s.message_id JOIN channels c ON c.id = m.channel_id LEFT JOIN users u ON u.id = m.user_id`;
  const rows = match
    ? db.all<HitRow>(sql`SELECT ${cols}, snippet(search_messages_fts, 0, char(2), char(3), '…', 20) AS snippet, bm25(search_messages_fts) AS rank
        FROM search_messages_fts JOIN search_messages s ON s.rowid = search_messages_fts.rowid ${joins}
        WHERE search_messages_fts MATCH ${match} AND ${and(...where)}
        ORDER BY ${recent ? sql`m.created_at DESC, m.id DESC` : sql`rank`} LIMIT ${limit}`)
    : db.all<HitRow>(sql`SELECT ${cols}, substr(s.body, 1, 200) AS snippet, 0 AS rank
        FROM search_messages s ${joins}
        WHERE ${and(...where)} ORDER BY m.created_at DESC, m.id DESC LIMIT ${limit}`);

  return rows.map((r) => ({
    source: 'chat',
    kind: 'message',
    id: r.id,
    title: r.channel_kind === 'standard' ? `#${r.channel_name ?? ''}` : 'Direct message',
    snippet: r.snippet ?? '',
    author: r.user_id,
    at: new Date(r.created_at).toISOString(),
    container: r.channel_id,
    url: addressOf({ organizationId: workspaceId, app: 'chat', kind: 'message', id: r.id }) ?? '',
    rank: r.rank,
    channelId: r.channel_id,
    channelName: r.channel_kind === 'standard' ? r.channel_name : null,
    channelKind: r.channel_kind,
    threadRootId: r.thread_root_id,
    authorName: r.author_name ?? 'someone',
  }));
}
