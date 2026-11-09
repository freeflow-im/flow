// The one-time import's way in (packages/server/scripts/export-to-edge.ts). Only the origin can call it: it holds the same
// secret the Worker sends to Caddy. Rows go to the directory, an organization's Chat object or its Docs object; Docs' file
// bodies go to R2 under that object's prefix. Beside it, behind the same secret, the one-time move of Mail and Calendar
// from the per-person objects to the per-account ones (POST /v1/admin/accounts/rekey, platform.md §3.6), of the assistant's
// chats from the Docs objects to the Assistant objects (POST /v1/admin/assistant/migrate, platform.md §5.5), and of one
// person's Docs files and chats from one organization to another (POST /v1/admin/accounts/move, docs/move.ts).
import { timingSafeEqual } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { AwsClient } from 'aws4fetch';
import type { Docs } from '../docs/object';
import type { Directory } from '../directory/object';
import type { Org } from '../org/object';
import type { AccountDTO } from '@flow/shared';
import type { Calendar } from '../calendar/object';
import type { Assistant } from '../assistant/object';
import { CALENDAR_TABLES } from '../calendar/store';
import { MAIL_TABLES, type Mail } from '../imap/object';
import type { ImportRow } from '../importing';
import { EXPORT_PAGE } from '../perAccount';
import { directory } from './auth';
import { z } from 'zod';
import { formatReference } from '@flow/shared';
import type { MovedChats } from '../assistant/object';
import { MOVED_TABLES, OWNED_TABLES, planDocsMove, pruneSelection, type DroppedGrant, type MovedTable, type MoveOptions, type MoveSource, type OwnedTable, type PruneSelection, type Row } from '../docs/move';

export interface AdminEnv {
  EDGE_ORIGIN_SECRET: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_ENDPOINT?: string;
  R2_BUCKET?: string;
  DIRECTORY: DurableObjectNamespace<Directory>;
  ORG: DurableObjectNamespace<Org>;
  DOCS: DurableObjectNamespace<Docs>;
  MAIL: DurableObjectNamespace<Mail>;
  CALENDAR: DurableObjectNamespace<Calendar>;
  ASSISTANT: DurableObjectNamespace<Assistant>;
  BLOBS: R2Bucket;
}

export const adminRoutes = new Hono<{ Bindings: AdminEnv }>();

const requireSecret = async (c: Context<{ Bindings: AdminEnv }>, next: () => Promise<void>) => {
  const given = c.req.header('x-edge-secret') ?? '';
  const want = c.env.EDGE_ORIGIN_SECRET ?? '';
  const a = Buffer.from(given), b = Buffer.from(want);
  if (!want || a.length !== b.length || !timingSafeEqual(a, b)) return c.json({ error: 'forbidden' }, 403);
  await next();
};
adminRoutes.use('/edge/admin/*', requireSecret);
adminRoutes.use('/v1/admin/*', requireSecret);

const docsStub = (env: AdminEnv, org: string) => env.DOCS.get(env.DOCS.idFromName(org));

adminRoutes.post('/edge/admin/directory', async (c) => {
  const { table, rows } = await c.req.json<{ table: string; rows: ImportRow[] }>();
  const stub = c.env.DIRECTORY.get(c.env.DIRECTORY.idFromName('directory'));
  return c.json(await stub.importRows(table, rows));
});
adminRoutes.post('/edge/admin/org/:id', async (c) => {
  const { table, rows } = await c.req.json<{ table: string; rows: ImportRow[] }>();
  return c.json(await c.env.ORG.get(c.env.ORG.idFromName(c.req.param('id'))).importRows(table, rows));
});
adminRoutes.post('/edge/admin/org/:id/done', async (c) => c.json(await c.env.ORG.get(c.env.ORG.idFromName(c.req.param('id'))).importDone()));
adminRoutes.get('/edge/admin/org/:id/counts', async (c) => c.json(await c.env.ORG.get(c.env.ORG.idFromName(c.req.param('id'))).counts()));
adminRoutes.get('/edge/admin/docs/:id/counts', async (c) => c.json(await docsStub(c.env, c.req.param('id')).counts()));
adminRoutes.post('/edge/admin/docs/:id', async (c) => {
  const { table, rows } = await c.req.json<{ table: string; rows: ImportRow[] }>();
  return c.json(await docsStub(c.env, c.req.param('id')).importRows(table, rows, c.req.param('id')));
});
/**
 * A signed address to put a large Docs file body straight into R2, at the same key the route below would use. Cloudflare
 * refuses a request body over 100 MB, so a file larger than that cannot come through the Worker.
 */
adminRoutes.get('/edge/admin/docs/:id/upload-url', async (c) => {
  const rel = c.req.query('path') ?? '';
  if (!/^(sheets|files|images)\/[^/]+$/.test(rel)) return c.json({ error: 'bad path' }, 400);
  const e = c.env;
  if (!e.R2_ACCESS_KEY_ID || !e.R2_SECRET_ACCESS_KEY || !e.R2_ENDPOINT || !e.R2_BUCKET) return c.json({ error: 'the Worker has no R2 keys' }, 500);
  const key = `docs/${e.DOCS.idFromName(c.req.param('id')).toString()}/data/${rel}`;
  const url = new URL(`${e.R2_ENDPOINT.replace(/\/$/, '')}/${e.R2_BUCKET}/${key.split('/').map(encodeURIComponent).join('/')}`);
  url.searchParams.set('X-Amz-Expires', '3600');
  const client = new AwsClient({ accessKeyId: e.R2_ACCESS_KEY_ID, secretAccessKey: e.R2_SECRET_ACCESS_KEY, service: 's3', region: 'auto' });
  const signed = await client.sign(new Request(url, { method: 'PUT' }), { aws: { signQuery: true } });
  return c.json({ url: signed.url });
});

/** A Docs file body, at the key the object's file system will look for it (packages/docs server/runtime/workerd/fsp.ts). */
adminRoutes.put('/edge/admin/docs/:id/file/*', async (c) => {
  const rel = new URL(c.req.url).pathname.split('/file/')[1]!;
  if (!/^(sheets|files|images)\/[^/]+$/.test(decodeURIComponent(rel))) return c.json({ error: 'bad path' }, 400);
  const prefix = `docs/${c.env.DOCS.idFromName(c.req.param('id')).toString()}/data/`;
  await c.env.BLOBS.put(prefix + decodeURIComponent(rel), c.req.raw.body);
  return c.json({ ok: true });
});

/** One object's rows into another of its kind, a page at a time: how many rows each table had. */
async function copyRows(
  from: { exportRows(o: { table?: string; offset?: number; limit?: number }): Promise<{ table: string; rows: ImportRow[] }[]> },
  to: { importRows(table: string, rows: ImportRow[]): Promise<{ added: number }> },
  tables: readonly string[], prefix: string, counts: Record<string, number>,
): Promise<void> {
  for (const table of tables) {
    let offset = 0;
    for (;;) {
      const rows = (await from.exportRows({ table, offset, limit: EXPORT_PAGE }))[0]?.rows ?? [];
      if (rows.length) await to.importRows(table, rows);
      offset += rows.length;
      if (rows.length < EXPORT_PAGE) break;
    }
    if (offset) counts[`${prefix}.${table}`] = offset;
  }
}

/**
 * The one-time move (platform.md §11, phase 1 item 4): each person's Mail and Calendar rows, from the objects named by
 * their user id to the ones named by their account's id, `INSERT OR IGNORE`, so it can run again; the old objects are left
 * as they were (the rollback). The account is the person's only one, else the earliest made that is not removed: `others`
 * lists the rest, for the operator to move by hand. `{ users: [...] }` limits a run to those people (a Worker request
 * may make only so many calls).
 */
adminRoutes.post('/v1/admin/accounts/rekey', async (c) => {
  const only = ((await c.req.json().catch(() => ({}))) as { users?: unknown }).users;
  const wanted = Array.isArray(only) ? new Set(only.filter((u): u is string => typeof u === 'string')) : null;
  const people = (await directory(c as never, 'principalsWithAccounts')) as { userId: string; accounts: AccountDTO[] }[];
  const moved: { userId: string; accountId: string; tables: Record<string, number>; others?: string[] }[] = [];
  const skipped: { userId: string; reason: string }[] = [];
  for (const { userId, accounts } of people) {
    if (wanted && !wanted.has(userId)) continue;
    if (!accounts.length) { skipped.push({ userId, reason: 'no account' }); continue; }
    const target = accounts.find((a) => a.state !== 'removed') ?? accounts[0]!;
    const tables: Record<string, number> = {};
    await copyRows(c.env.MAIL.get(c.env.MAIL.idFromName(userId)), c.env.MAIL.get(c.env.MAIL.idFromName(target.id)), MAIL_TABLES, 'mail', tables);
    await copyRows(c.env.CALENDAR.get(c.env.CALENDAR.idFromName(userId)), c.env.CALENDAR.get(c.env.CALENDAR.idFromName(target.id)), CALENDAR_TABLES, 'calendar', tables);
    const others = accounts.filter((a) => a.id !== target.id).map((a) => a.id);
    if (!Object.keys(tables).length) { skipped.push({ userId, reason: 'nothing to move' }); continue; }
    moved.push({ userId, accountId: target.id, tables, ...(others.length ? { others } : {}) });
  }
  return c.json({ moved, skipped });
});

/** Where one person's assistant rows from an organization's Docs object go: their account there, if they have one. */
export interface AssistantMove {
  organizationId: string; userId: string; accountId: string;
  conversations: number; messages: number; settings: number; usage: number;
  /** Conversations already in the Assistant object (an earlier run), left as they are. */
  already: number;
}

/** What the move reads (the Docs object) and writes (an Assistant object): the methods it calls, for its test. */
export interface AssistantMoveObjects {
  docs(organizationId: string): {
    assistantRows(table: 'agent_conversations' | 'assistant_settings' | 'agent_usage', offset?: number, limit?: number): Promise<Record<string, unknown>[]>;
    assistantMessages(conversationId: string, offset?: number, limit?: number): Promise<Record<string, unknown>[]>;
  };
  assistant(accountId: string): {
    importRows(table: string, rows: ImportRow[]): Promise<{ added: number }>;
    importChat(conversation: ImportRow, messages: ImportRow[]): Promise<{ added: boolean; messages: number }>;
  };
}

/**
 * The one-time move (platform.md §11, phase 6 item 3): each person's chats, settings and usage from every organization's
 * Docs object into their Assistant object for their account in that organization (a conversation started in another
 * organization they have an account in, its `workspace_id`, goes to that account's), `INSERT OR IGNORE` and whole
 * conversations, so it can run again; the Docs rows are left in place (the rollback). A person with no account in the
 * organization is skipped and reported, as is one with nothing new to move.
 */
export async function moveAssistantRows(objects: AssistantMoveObjects, people: { userId: string; accounts: AccountDTO[] }[], organizations: string[]): Promise<{ moved: AssistantMove[]; skipped: { organizationId: string; userId: string; reason: string }[] }> {
  const accountsOf = new Map(people.map((p) => [p.userId, p.accounts]));
  const accountIn = (userId: string, organizationId: string) => {
    const mine = (accountsOf.get(userId) ?? []).filter((a) => a.organizationId === organizationId);
    return mine.find((a) => a.state !== 'removed') ?? mine[0] ?? null;
  };
  const moves = new Map<string, AssistantMove>();
  const skipped = new Map<string, { organizationId: string; userId: string; reason: string }>();
  const moveFor = (organizationId: string, userId: string, account: AccountDTO) => {
    const k = `${organizationId}|${account.id}`;
    let m = moves.get(k);
    if (!m) moves.set(k, (m = { organizationId, userId, accountId: account.id, conversations: 0, messages: 0, settings: 0, usage: 0, already: 0 }));
    return m;
  };
  const skip = (organizationId: string, userId: string, reason: string) => skipped.set(`${organizationId}|${userId}`, { organizationId, userId, reason });
  const pages = async function* (read: (offset: number) => Promise<Record<string, unknown>[]>) {
    for (let offset = 0; ; ) {
      const rows = await read(offset);
      if (rows.length) yield rows;
      offset += rows.length;
      if (rows.length < EXPORT_PAGE) return;
    }
  };

  for (const organizationId of organizations) {
    const docs = objects.docs(organizationId);
    for (const table of ['assistant_settings', 'agent_usage'] as const) {
      for await (const rows of pages((offset) => docs.assistantRows(table, offset, EXPORT_PAGE))) {
        const byUser = new Map<string, ImportRow[]>();
        for (const r of rows) byUser.set(String(r.user_id), [...(byUser.get(String(r.user_id)) ?? []), r as ImportRow]);
        for (const [userId, mine] of byUser) {
          const account = accountIn(userId, organizationId);
          if (!account) { skip(organizationId, userId, 'no account in the organization'); continue; }
          const { added } = await objects.assistant(account.id).importRows(table, mine);
          moveFor(organizationId, userId, account)[table === 'agent_usage' ? 'usage' : 'settings'] += added;
        }
      }
    }
    for await (const rows of pages((offset) => docs.assistantRows('agent_conversations', offset, EXPORT_PAGE))) {
      for (const conversation of rows) {
        const userId = String(conversation.user_id);
        const started = typeof conversation.workspace_id === 'string' ? conversation.workspace_id : null;
        const target = started && accountIn(userId, started) ? started : organizationId;
        const account = accountIn(userId, target);
        if (!account) { skip(organizationId, userId, 'no account in the organization'); continue; }
        const messages: ImportRow[] = [];
        for await (const page of pages((offset) => docs.assistantMessages(String(conversation.id), offset, EXPORT_PAGE))) messages.push(...(page as ImportRow[]));
        const done = await objects.assistant(account.id).importChat(conversation as ImportRow, messages);
        const m = moveFor(target, userId, account);
        if (done.added) { m.conversations++; m.messages += done.messages; } else m.already++;
      }
    }
  }
  const moved = [...moves.values()].filter((m) => m.conversations || m.messages || m.settings || m.usage);
  for (const m of moves.values()) if (!moved.includes(m)) skip(m.organizationId, m.userId, 'nothing new to move');
  return { moved, skipped: [...skipped.values()] };
}

/** POST /v1/admin/accounts/provision `{ accountId }`: sends one account to be provisioned (a mailbox and a native calendar),
 * where the owner's "Set up mailboxes for everyone" would send every member. `queued` is false when the account already
 * has a mailbox, or is removed or suspended. */
adminRoutes.post('/v1/admin/accounts/provision', async (c) => {
  const body = z.object({ accountId: z.string().min(1) }).safeParse(await c.req.json().catch(() => undefined));
  if (!body.success) return c.json({ error: 'accountId required' }, 400);
  return c.json({ accountId: body.data.accountId, queued: await directory(c as never, 'provisionAccount', body.data.accountId) });
});

/**
 * POST /v1/admin/assistant/migrate: `moveAssistantRows` for every organization with members, or the ones named
 * (`{ organizations: [...] }`; a Worker request may make only so many calls, so a large deployment runs it in parts).
 */
adminRoutes.post('/v1/admin/assistant/migrate', async (c) => {
  const only = ((await c.req.json().catch(() => ({}))) as { organizations?: unknown }).organizations;
  const people = (await directory(c as never, 'principalsWithAccounts')) as { userId: string; accounts: AccountDTO[] }[];
  const all = [...new Set(people.flatMap((p) => p.accounts.map((a) => a.organizationId)))];
  const organizations = Array.isArray(only) ? all.filter((o) => only.includes(o)) : all;
  return c.json(
    await moveAssistantRows(
      {
        docs: (organizationId) => docsStub(c.env, organizationId) as never,
        assistant: (accountId) => c.env.ASSISTANT.get(c.env.ASSISTANT.idFromName(accountId)) as never,
      },
      people,
      organizations,
    ),
  );
});

// ---- one person's Docs and chats from one organization to another (POST /v1/admin/accounts/move) ------------------------

/** What `moveDocs` reads and writes: two organizations' Docs objects, their R2 prefixes, and the share index and directory. */
export interface DocsMoveObjects {
  docs(organizationId: string): {
    ownedRows(userId: string, table: OwnedTable, offset?: number, limit?: number): Promise<Row[]>;
    grantsOn(objects: { kind: string; id: string }[]): Promise<Row[]>;
    presentKeys(keys: string[]): Promise<string[]>;
    importMoved(table: MovedTable, rows: Row[], organizationId: string): Promise<{ added: boolean[] }>;
    pruneOwned(userId: string, sel: Omit<PruneSelection, 'bodies' | 'indexIds' | 'grants'>): Promise<Record<string, number>>;
  };
  /** The R2 prefix of an organization's Docs object (as docs/object.ts makes it). */
  prefix(organizationId: string): string;
  bucket: Pick<R2Bucket, 'get' | 'put' | 'delete'>;
  recordShare(organizationId: string, input: { ref: string; principal: string; role: string; grantedBy: string; title: string; kind: string; silent: true }): Promise<void>;
  revokeShare(organizationId: string, input: { ref: string; principal: string; revokedBy: string }): Promise<void>;
  reindex(ids: string[], organizationId: string): Promise<unknown>;
}

export interface DocsMoveResult {
  /** Rows new in the target, and rows it already had (an earlier run), per table. */
  copied: Record<string, number>;
  already: Record<string, number>;
  bodies: { copied: number; skipped: number; missing: string[] };
  madePrivate: number;
  foldersMade: number;
  droppedGrants: DroppedGrant[];
  /** With prune: rows and bodies taken from the source, and moved objects not found in the target (left in place). */
  deleted?: Record<string, number>;
  notVerified?: number;
}

/** Pages of a read, EXPORT_PAGE at a time. */
async function allPages<T>(read: (offset: number) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let offset = 0; ; ) {
    const rows = await read(offset);
    out.push(...rows);
    offset += rows.length;
    if (rows.length < EXPORT_PAGE) return out;
  }
}
const chunks = <T>(xs: T[], n = EXPORT_PAGE): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, (i + 1) * n));

/** One R2 object to another key, streamed in the Worker. False when the source is not there. */
async function copyBody(bucket: DocsMoveObjects['bucket'], from: string, to: string): Promise<boolean> {
  const obj = await bucket.get(from);
  if (!obj) return false;
  // R2 takes a stream only of a known length.
  const body = typeof FixedLengthStream === 'function' ? obj.body.pipeThrough(new FixedLengthStream(obj.size)) : obj.body;
  await bucket.put(to, body, { httpMetadata: obj.httpMetadata, customMetadata: obj.customMetadata });
  return true;
}

/**
 * The person's Docs from `from`'s object to `to`'s (docs/move.ts says what moves and how it is rewritten): bodies first,
 * sequentially, for objects the target does not have yet; then the rows, `INSERT OR IGNORE`; the kept link grants into the
 * target's share index. With `prune`, only what the target is found to have is then deleted from the source (rows, grants
 * and their share-index entries, bodies) and the directory places its ids and link tokens in the target.
 */
export async function moveDocs(objects: DocsMoveObjects, o: MoveOptions & { prune?: boolean }): Promise<DocsMoveResult> {
  const a = objects.docs(o.from), b = objects.docs(o.to);
  const source = { grants: [] } as unknown as MoveSource;
  for (const table of OWNED_TABLES) source[table] = await allPages((offset) => a.ownedRows(o.userId, table, offset, EXPORT_PAGE));
  const owned = (r: Row) => r.owner_id === o.userId;
  const grantable = [
    ...source.sheets.filter(owned).map((s) => ({ kind: 'sheet', id: String(s.id) })),
    ...source.stored_files.filter(owned).map((f) => ({ kind: 'file', id: String(f.id) })),
    ...source.folders.filter(owned).map((f) => ({ kind: 'folder', id: `${String(f.scope)}/${String(f.path)}` })),
  ];
  for (const page of chunks(grantable)) source.grants.push(...(await a.grantsOn(page)));
  const plan = planDocsMove(source, o);

  const result: DocsMoveResult = { copied: {}, already: {}, bodies: { copied: 0, skipped: 0, missing: [] }, madePrivate: plan.madePrivate, foldersMade: plan.foldersMade, droppedGrants: plan.dropped };
  // Bodies before rows, so a row in the target never names a body it lacks; an object already there had its bodies copied.
  const there = new Set<string>();
  for (const page of chunks(plan.objects.map((x) => x.target))) for (const k of await b.presentKeys(page)) there.add(k);
  const fromPrefix = objects.prefix(o.from), toPrefix = objects.prefix(o.to);
  for (const body of plan.bodies) {
    if (there.has(body.of)) { if (!body.optional) result.bodies.skipped++; continue; }
    const ok = await copyBody(objects.bucket, fromPrefix + body.path, toPrefix + body.path);
    if (ok && !body.optional) result.bodies.copied++;
    if (!ok && !body.optional) result.bodies.missing.push(body.path);
  }
  const newLinks = new Set<string>();
  for (const table of MOVED_TABLES) {
    const rows = plan.rows[table];
    for (const page of chunks(rows)) {
      const { added } = await b.importMoved(table, page, o.to);
      added.forEach((yes, i) => { if (yes && table === 'grants') newLinks.add(`${String(page[i]!.object_kind)}:${String(page[i]!.object_id)}:${String(page[i]!.principal)}`); });
      result.copied[table] = (result.copied[table] ?? 0) + added.filter(Boolean).length;
      result.already[table] = (result.already[table] ?? 0) + added.filter((x) => !x).length;
    }
  }
  for (const l of plan.links) {
    if (!newLinks.has(`${l.kind}:${l.id}:${l.principal}`)) continue;
    await objects.recordShare(o.to, { ref: formatReference({ organizationId: o.to, app: 'docs', kind: l.kind, id: l.id }), principal: l.principal, role: l.role, grantedBy: o.toAccountId ?? o.userId, title: l.title, kind: l.fileKind, silent: true });
  }
  if (!o.prune) return result;

  const present: string[] = [];
  for (const page of chunks(plan.objects.map((x) => x.target))) present.push(...(await b.presentKeys(page)));
  const sel = pruneSelection(plan, present);
  result.notVerified = plan.objects.length - sel.sheets.length - sel.stored_files.length - sel.images.length - sel.folders.length;
  const deleted = await a.pruneOwned(o.userId, { sheets: sel.sheets, stored_files: sel.stored_files, images: sel.images, folders: sel.folders, favorites: sel.favorites, recent_opens: sel.recent_opens, public_links: sel.public_links });
  for (const page of chunks(sel.bodies, 1000)) await objects.bucket.delete(page.map((p) => fromPrefix + p));
  deleted.bodies = plan.bodies.filter((x) => !x.optional && sel.bodies.includes(x.path)).length;
  for (const g of sel.grants) await objects.revokeShare(o.from, { ref: formatReference({ organizationId: o.from, app: 'docs', kind: g.kind, id: g.id }), principal: g.principal, revokedBy: o.fromAccountId ?? o.userId });
  if (sel.indexIds.length) await objects.reindex(sel.indexIds, o.to);
  result.deleted = deleted;
  return result;
}

/** What `moveChats` reads and writes: two Assistant objects. */
export interface ChatsMoveObjects {
  exportRows(o: { table?: string; offset?: number; limit?: number }): Promise<{ table: string; rows: ImportRow[] }[]>;
  conversationMessages(conversationId: string, offset?: number, limit?: number): Promise<ImportRow[]>;
  importRows(table: string, rows: ImportRow[]): Promise<{ added: number }>;
  importChat(conversation: ImportRow, messages: ImportRow[]): Promise<{ added: boolean; messages: number }>;
  presentRows(want: MovedChats): Promise<MovedChats>;
  pruneMoved(rows: MovedChats): Promise<Record<string, number>>;
}

/**
 * The person's chats, usage and settings from one account's Assistant object to another's: settings and usage
 * `INSERT OR IGNORE` (the target's own are kept), each conversation whole with its messages (one the target has is left),
 * its organization rewritten. With `prune`, what the target is found to have is deleted from the source.
 */
export async function moveChats(src: ChatsMoveObjects, dst: ChatsMoveObjects, o: { from: string; to: string; prune?: boolean }) {
  const copied = { conversations: 0, messages: 0, agent_usage: 0, assistant_settings: 0 }, already = { conversations: 0, agent_usage: 0, assistant_settings: 0 };
  const read = (table: string) => allPages(async (offset) => (await src.exportRows({ table, offset, limit: EXPORT_PAGE }))[0]?.rows ?? []);
  const moved: MovedChats = { conversations: [], usage: [], settings: [] };
  for (const table of ['assistant_settings', 'agent_usage'] as const) {
    const rows = await read(table);
    for (const page of chunks(rows)) {
      // Counted by what the target has first: importRows' count is rows written, indexes included.
      const keys: MovedChats = table === 'assistant_settings'
        ? { conversations: [], usage: [], settings: page.map((r) => String(r.user_id)) }
        : { conversations: [], usage: page.map((r) => ({ user_id: String(r.user_id), day: String(r.day) })), settings: [] };
      const had = await dst.presentRows(keys);
      const there = table === 'assistant_settings' ? had.settings.length : had.usage.length;
      await dst.importRows(table, page);
      copied[table] += page.length - there;
      already[table] += there;
      moved.settings.push(...keys.settings);
      moved.usage.push(...keys.usage);
    }
  }
  for (const c of await read('agent_conversations')) {
    const messages = await allPages((offset) => src.conversationMessages(String(c.id), offset, EXPORT_PAGE));
    const done = await dst.importChat({ ...c, workspace_id: c.workspace_id === o.from ? o.to : c.workspace_id }, messages);
    if (done.added) { copied.conversations++; copied.messages += done.messages; } else already.conversations++;
    moved.conversations.push(String(c.id));
  }
  if (!o.prune) return { copied, already };
  const present = await dst.presentRows(moved);
  const deleted = await src.pruneMoved(present);
  return { copied, already, deleted };
}

const moveBody = z.object({
  userId: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  what: z.array(z.enum(['docs', 'assistant'])).min(1).optional(),
  prune: z.boolean().optional(),
});

/**
 * POST /v1/admin/accounts/move: one person's Docs files (`docs`) and assistant chats (`assistant`) from one organization
 * they belong to (`from`) to another (`to`); both by default. Copies, `INSERT OR IGNORE`, so it can run again and in parts
 * (`what`); without `prune` nothing in `from` changes, with it what `to` is found to have is deleted from `from`.
 */
adminRoutes.post('/v1/admin/accounts/move', async (c) => {
  const parsed = moveBody.safeParse(await c.req.json().catch(() => undefined));
  if (!parsed.success) return c.json({ error: 'bad_request', message: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') }, 400);
  const { userId, from, to, prune = false } = parsed.data;
  const what = new Set(parsed.data.what ?? ['docs', 'assistant']);
  if (from === to) return c.json({ error: 'bad_request', message: 'from and to are the same organization' }, 400);
  const people = (await directory(c as never, 'principalsWithAccounts')) as { userId: string; accounts: AccountDTO[] }[];
  const accounts = people.find((p) => p.userId === userId)?.accounts;
  if (!accounts) return c.json({ error: 'not_found', message: 'no such user' }, 404);
  const accountIn = (org: string) => {
    const mine = accounts.filter((a) => a.organizationId === org);
    return mine.find((a) => a.state !== 'removed') ?? mine[0] ?? null;
  };
  const fromAccount = accountIn(from), toAccount = accountIn(to);
  if (!toAccount || toAccount.state === 'removed') return c.json({ error: 'no_account', message: 'the user has no account in the target organization' }, 400);
  const env = c.env;
  const out: Record<string, unknown> = { userId, from, to, prune, fromAccountId: fromAccount?.id ?? null, toAccountId: toAccount.id };
  if (what.has('docs')) {
    out.docs = await moveDocs(
      {
        docs: (org) => docsStub(env, org) as never,
        prefix: (org) => `docs/${env.DOCS.idFromName(org).toString()}/`,
        bucket: env.BLOBS,
        recordShare: (org, input) => env.ORG.get(env.ORG.idFromName(org)).recordShare(input),
        revokeShare: (org, input) => env.ORG.get(env.ORG.idFromName(org)).revokeShare(input),
        reindex: (ids, org) => directory(c as never, 'reindexIds', ids, org),
      },
      { userId, from, to, fromAccountId: fromAccount?.id ?? null, toAccountId: toAccount.id, prune },
    );
  }
  if (what.has('assistant')) {
    if (!fromAccount) out.assistant = { skipped: 'the user has no account in the source organization' };
    else {
      const stub = (id: string) => env.ASSISTANT.get(env.ASSISTANT.idFromName(id)) as unknown as ChatsMoveObjects;
      out.assistant = await moveChats(stub(fromAccount.id), stub(toAccount.id), { from, to, prune });
    }
  }
  return c.json(out);
});
