// Apps being built in the suite (docs/specs/user-apps.md §9.6): one draft per app and author, its files kept here as they
// change. A draft runs nowhere until its author tries it (a dev install, §9.3) or publishes it as a version an owner or
// admin installs. These functions run inside the Org object's database scope (withDb).
import { and, eq } from 'drizzle-orm';
import { randomBytes } from 'node:crypto';
import { APP_NAME, checkHostedFiles, checkUserAppManifest, HOSTED_APP_LIMITS, RESERVED_APP_NAMES, type UserAppManifest } from '@flow/shared';
import { db, schema } from '../db/index.js';
import { decryptBody, encryptBody } from '../crypto/index.js';
import { ApiError, badRequest, notFound } from '../../errors';

const { userAppDrafts, userAppDraftFiles } = schema;

export const MANIFEST_FILE = 'freeflow-app.json';
/** A draft's files: the manifest and a version's files (checkHostedFiles says which those are). */
const DRAFT_PATH = /^(freeflow-app\.json|server\.js|migrations\/[0-9]{4}_[a-z0-9_]{1,60}\.sql|ui\/[A-Za-z0-9._\-/]{1,190})$/;
/** At most this many drafts per author. */
export const DRAFTS_PER_AUTHOR = 10;

const enc = new TextEncoder();
const dec = new TextDecoder();

/** One draft as its author's page and tools see it. */
export interface AppDraftDTO {
  name: string;
  label: string;
  files: Record<string, number>;
  /** What stands between the draft and a version: the manifest's and the files' problems. Empty when it may be published. */
  problems: string[];
  devHost: string;
  createdAt: string;
  updatedAt: string;
}

/** The starter project of a new app (§9.6): a manifest, one tool, one route, one table and a screen that uses them. */
export function starterFiles(name: string, label: string): Record<string, string> {
  const manifest: UserAppManifest = {
    name,
    label,
    description: `${label}, built in FreeFlow.`,
    server: { hosted: true },
    ui: { hosted: true },
    kinds: [{ kind: 'item', label: 'Item' }],
    scopes: [{ id: `${name}:use`, label: `Use ${label}`, read: true }],
    tools: [
      { name: 'add_item', description: `Adds an item to ${label}.`, input: { type: 'object', properties: { text: { type: 'string', description: 'The item.' } }, required: ['text'] }, scopes: [`${name}:use`] },
      { name: 'list_items', description: `Lists the items in ${label}, newest first.`, input: { type: 'object', properties: {} }, scopes: [`${name}:use`] },
    ],
    events: ['item.added'],
  };
  const server = `import { defineApp } from 'freeflow';

export default defineApp({
  tools: {
    add_item: async (input, ctx) => {
      const [row] = await ctx.db.all('INSERT INTO items (text, by, at) VALUES (?, ?, ?) RETURNING id', String(input.text), ctx.caller.accountId, Date.now());
      await ctx.publish('item.added', { text: input.text }, { ref: { kind: 'item', id: String(row.id) } });
      return { id: row.id };
    },
    list_items: async (input, ctx) => ctx.db.all('SELECT id, text, by, at FROM items ORDER BY id DESC LIMIT 100'),
  },
  routes: {
    'GET /api/items': async (request, ctx) => ({ viewer: ctx.caller?.displayName ?? null, items: await ctx.db.all('SELECT id, text, at FROM items ORDER BY id DESC LIMIT 100') }),
    'POST /api/items': async (request, ctx) => {
      const { text } = await request.json();
      await ctx.db.run('INSERT INTO items (text, by, at) VALUES (?, ?, ?)', String(text), ctx.caller.accountId, Date.now());
      return { ok: true };
    },
  },
});
`;
  const html = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${label}</title>
<style>
  body { font: 15px system-ui, sans-serif; margin: 24px; color: #1f1f1f; }
  form { display: flex; gap: 8px; margin: 16px 0; }
  input { flex: 1; padding: 6px 8px; border: 1px solid #dadce0; border-radius: 6px; }
  button { padding: 6px 12px; border: 0; border-radius: 6px; background: #1a73e8; color: #fff; }
  li { padding: 6px 0; border-bottom: 1px solid #e3e6ea; list-style: none; }
  ul { padding: 0; }
</style>
<h1>${label}</h1>
<p id="who"></p>
<form id="add"><input name="text" placeholder="New item" required><button>Add</button></form>
<ul id="items"></ul>
<script>
  async function load() {
    const r = await fetch('api/items');
    const data = await r.json();
    document.getElementById('who').textContent = data.viewer ? 'Signed in as ' + data.viewer : '';
    document.getElementById('items').replaceChildren(...data.items.map((i) => Object.assign(document.createElement('li'), { textContent: i.text })));
  }
  document.getElementById('add').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = new FormData(e.target).get('text');
    await fetch('api/items', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
    e.target.reset();
    load();
  });
  load();
</script>
</html>
`;
  return {
    [MANIFEST_FILE]: JSON.stringify(manifest, null, 2) + '\n',
    'server.js': server,
    'migrations/0001_items.sql': 'CREATE TABLE items (id INTEGER PRIMARY KEY, text TEXT NOT NULL, by TEXT, at INTEGER NOT NULL);\n',
    'ui/index.html': html,
  };
}

/** The checks of a manifest and a version's files, for a draft's files (§4, §14 phase 2 step 1). */
export function draftProblems(files: Record<string, Uint8Array>): string[] {
  const raw = files[MANIFEST_FILE];
  if (!raw) return [`${MANIFEST_FILE} is missing`];
  let json: unknown;
  try {
    json = JSON.parse(dec.decode(raw));
  } catch (e) {
    return [`${MANIFEST_FILE} is not JSON: ${(e as Error).message}`];
  }
  const checked = checkUserAppManifest(json);
  if (!checked.ok) return checked.problems;
  const sizes = Object.fromEntries(Object.entries(files).filter(([p]) => p !== MANIFEST_FILE).map(([p, b]) => [p, b.byteLength]));
  return checkHostedFiles(checked.manifest, sizes);
}

async function filesOf(name: string, author: string): Promise<Record<string, Uint8Array>> {
  const rows = await db.select({ path: userAppDraftFiles.path, body: userAppDraftFiles.body }).from(userAppDraftFiles).where(and(eq(userAppDraftFiles.name, name), eq(userAppDraftFiles.author, author)));
  return Object.fromEntries(rows.map((r) => [r.path, new Uint8Array(r.body as Uint8Array)]));
}

async function draftRow(name: string, author: string) {
  const [row] = await db.select().from(userAppDrafts).where(and(eq(userAppDrafts.name, name), eq(userAppDrafts.author, author))).limit(1);
  if (!row) throw notFound(`you have no draft of "${name}"`);
  return row;
}

function toDTO(row: typeof userAppDrafts.$inferSelect, files: Record<string, Uint8Array>): AppDraftDTO {
  let label = row.name;
  try { label = (JSON.parse(dec.decode(files[MANIFEST_FILE] ?? new Uint8Array())) as { label?: string }).label ?? row.name; } catch { /* the name */ }
  return {
    name: row.name, label, files: Object.fromEntries(Object.entries(files).map(([p, b]) => [p, b.byteLength])), problems: draftProblems(files),
    devHost: row.devHost, createdAt: new Date(row.createdAt).toISOString(), updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

/** The author's drafts, newest change first. */
export async function listDrafts(author: string): Promise<AppDraftDTO[]> {
  const rows = await db.select().from(userAppDrafts).where(eq(userAppDrafts.author, author));
  const out: AppDraftDTO[] = [];
  for (const row of rows.sort((a, b) => b.updatedAt - a.updatedAt)) out.push(toDTO(row, await filesOf(row.name, author)));
  return out;
}

export async function getDraft(name: string, author: string): Promise<AppDraftDTO> {
  return toDTO(await draftRow(name, author), await filesOf(name, author));
}

/**
 * A new draft: the starter project, or (`files`) the installed app's version, to change it. The name is the app's: one
 * draft per name and author.
 */
export async function createDraft(p: { name: string; label: string; author: string; files?: Record<string, Uint8Array> }): Promise<AppDraftDTO> {
  if (!APP_NAME.test(p.name)) throw badRequest('validation', `name: "${p.name}" must be 2-20 lowercase letters and digits, starting with a letter`);
  if (RESERVED_APP_NAMES.has(p.name)) throw badRequest('validation', `name: "${p.name}" is reserved`);
  const mine = await db.select({ name: userAppDrafts.name }).from(userAppDrafts).where(eq(userAppDrafts.author, p.author));
  if (mine.some((d) => d.name === p.name)) throw new ApiError(409, 'draft_exists', `you already have a draft of "${p.name}"`);
  if (mine.length >= DRAFTS_PER_AUTHOR) throw badRequest('too_many', `at most ${DRAFTS_PER_AUTHOR} drafts each; delete one first`);
  const secret = encryptBody(randomBytes(32).toString('base64'));
  const now = Date.now();
  await db.insert(userAppDrafts).values({
    name: p.name, author: p.author, secret: secret.body, secretNonce: secret.bodyNonce, encKeyId: secret.encKeyId, encScheme: secret.encScheme,
    devHost: randomBytes(5).toString('hex'), createdAt: now, updatedAt: now,
  });
  const files = p.files ?? Object.fromEntries(Object.entries(starterFiles(p.name, p.label)).map(([k, v]) => [k, enc.encode(v)]));
  for (const [path, body] of Object.entries(files)) await db.insert(userAppDraftFiles).values({ name: p.name, author: p.author, path, body: Buffer.from(body), updatedAt: now });
  return getDraft(p.name, p.author);
}

/** One file's text. */
export async function readDraftFile(name: string, author: string, path: string): Promise<string> {
  await draftRow(name, author);
  const [row] = await db.select({ body: userAppDraftFiles.body }).from(userAppDraftFiles).where(and(eq(userAppDraftFiles.name, name), eq(userAppDraftFiles.author, author), eq(userAppDraftFiles.path, path))).limit(1);
  if (!row) throw notFound(`the draft has no file ${path}`);
  return dec.decode(row.body as Uint8Array);
}

/** Writes one file (made or replaced). Back comes the draft, with its problems now. */
export async function writeDraftFile(name: string, author: string, path: string, text: string): Promise<AppDraftDTO> {
  await draftRow(name, author);
  if (!DRAFT_PATH.test(path) || path.includes('..') || path.includes('//')) throw badRequest('validation', `${path} is not freeflow-app.json, server.js, migrations/NNNN_name.sql or ui/<path>`);
  const body = Buffer.from(enc.encode(text));
  if (body.byteLength > 1_500_000) throw badRequest('validation', `${path} is over 1.5 MB`);
  const others = Object.entries(await filesOf(name, author)).filter(([p]) => p !== path).reduce((n, [, b]) => n + b.byteLength, 0);
  if (others + body.byteLength > HOSTED_APP_LIMITS.bytes) throw badRequest('validation', `the draft would be over ${HOSTED_APP_LIMITS.bytes} bytes`);
  const now = Date.now();
  await db.insert(userAppDraftFiles).values({ name, author, path, body, updatedAt: now })
    .onConflictDoUpdate({ target: [userAppDraftFiles.name, userAppDraftFiles.author, userAppDraftFiles.path], set: { body, updatedAt: now } });
  await db.update(userAppDrafts).set({ updatedAt: now }).where(and(eq(userAppDrafts.name, name), eq(userAppDrafts.author, author)));
  return getDraft(name, author);
}

export async function deleteDraftFile(name: string, author: string, path: string): Promise<AppDraftDTO> {
  await draftRow(name, author);
  await db.delete(userAppDraftFiles).where(and(eq(userAppDraftFiles.name, name), eq(userAppDraftFiles.author, author), eq(userAppDraftFiles.path, path)));
  await db.update(userAppDrafts).set({ updatedAt: Date.now() }).where(and(eq(userAppDrafts.name, name), eq(userAppDrafts.author, author)));
  return getDraft(name, author);
}

export async function deleteDraft(name: string, author: string): Promise<void> {
  await draftRow(name, author);
  await db.delete(userAppDraftFiles).where(and(eq(userAppDraftFiles.name, name), eq(userAppDraftFiles.author, author)));
  await db.delete(userAppDrafts).where(and(eq(userAppDrafts.name, name), eq(userAppDrafts.author, author)));
}

/** Everything a dev install runs (§9.3): the checked manifest, the files, the draft's secret, and a key that changes with any edit. */
export async function draftCode(name: string, author: string): Promise<{ manifest: UserAppManifest; files: Record<string, Uint8Array>; secret: Buffer; key: string; devHost: string }> {
  const row = await draftRow(name, author);
  const files = await filesOf(name, author);
  const problems = draftProblems(files);
  if (problems.length) throw new ApiError(400, 'draft_problems', problems.join('\n'));
  const manifest = JSON.parse(dec.decode(files[MANIFEST_FILE]!)) as UserAppManifest;
  const secret = Buffer.from(decryptBody({ body: row.secret, bodyNonce: row.secretNonce, encKeyId: row.encKeyId, encScheme: row.encScheme }), 'base64');
  return { manifest, files, secret, key: `${row.updatedAt}`, devHost: row.devHost };
}

/** The draft whose preview a host names (§9.6): its name and author, or null. */
export async function draftByDevHost(devHost: string): Promise<{ name: string; author: string } | null> {
  const [row] = await db.select({ name: userAppDrafts.name, author: userAppDrafts.author }).from(userAppDrafts).where(eq(userAppDrafts.devHost, devHost)).limit(1);
  return row ?? null;
}
