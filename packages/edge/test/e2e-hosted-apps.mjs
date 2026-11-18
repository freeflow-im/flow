// End-to-end check of hosted user apps, phase 2 (docs/specs/user-apps.md §14): a small hosted app uploaded as a version,
// installed, and run by the Worker Loader: its tools, its store per organization, its migrations, its events, and its
// internet limited to the hosts it declared. Against a local `wrangler dev` of its own (as e2e-user-apps.mjs):
//   printf 'EDGE_ORIGIN_SECRET=x\nFLOW_DATA_KEY=%s\n' "$(openssl rand -base64 32)" > .dev.vars; mkdir -p public; rm -rf .wrangler/state
//   npx wrangler dev --port 18799 --inspector-port 19299 --local --enable-containers=false --local-upstream localhost:18799 \
//     --var PORTED_HOSTS:edge.freeflow.im,localhost --var ASSET_HOSTS:none --var ORIGIN_URL:http://localhost:9 \
//     --var WEB_URL_BASE:http://localhost:18799 --var FLOW_WEB_URL:http://localhost:18799 > /tmp/edge-hosted.log 2>&1 &
//   node test/e2e-hosted-apps.mjs /tmp/edge-hosted.log
import fs from 'node:fs';
import http from 'node:http';

const log = process.argv[2];
const B = process.env.B ?? 'http://localhost:18799';
let pass = 0, fail = 0;
const t = (n, ok, d = '') => { ok ? pass++ : fail++; console.log((ok ? 'ok  ' : 'FAIL') + ' ' + n + (d ? ': ' + String(d).slice(0, 220) : '')); };
const api = async (tok, m, p, b) => {
  const r = await fetch(B + p, { method: m, headers: { ...(tok ? { authorization: 'Bearer ' + tok } : {}), ...(b !== undefined ? { 'content-type': 'application/json' } : {}) }, body: b === undefined ? undefined : JSON.stringify(b) });
  const x = await r.text(); let j; try { j = JSON.parse(x); } catch { j = x; } return { s: r.status, j };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function signup(email, name) {
  await api(null, 'POST', '/v1/auth/register', { email }); await sleep(400);
  const m = [...fs.readFileSync(log, 'utf8').matchAll(new RegExp('to=' + email + '.*?signup=([A-Za-z0-9_-]+)', 'g'))].at(-1);
  return (await api(null, 'POST', '/v1/auth/register/complete', { token: m[1], displayName: name, password: 'correct-horse-battery' })).j;
}
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const tag = Date.now().toString(36);

// The app: notes in its own table, an event per note, and a tool that tries the internet.
const manifest = {
  name: 'notes', label: 'Notes', server: { hosted: true }, egress: ['example.com'],
  kinds: [{ kind: 'note' }],
  scopes: [{ id: 'notes:read', label: 'Read notes', read: true }, { id: 'notes:write', label: 'Write notes' }],
  tools: [
    { name: 'add_note', description: 'Adds a note.', input: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, scopes: ['notes:write'] },
    { name: 'list_notes', description: 'Lists notes.', input: { type: 'object' }, scopes: ['notes:read'] },
    { name: 'fetch_url', description: 'Fetches a URL.', input: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }, scopes: ['notes:read'] },
    { name: 'spin', description: 'Uses CPU.', input: { type: 'object' }, scopes: ['notes:read'] },
  ],
  events: ['note.added'],
};
const server = (label) => `
export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    if (path === '/api/whoami') return new Response(request.headers.get('x-freeflow-viewer'), { headers: { 'content-type': 'application/json' } });
    const { tool, input, caller } = await request.json();
    const ok = (result) => Response.json({ result });
    if (tool === 'add_note') {
      const [row] = await env.DB.exec('INSERT INTO notes (text, by) VALUES (?, ?) RETURNING id', [input.text, caller.accountId]);
      await env.SUITE.publish('note.added', { text: input.text }, { kind: 'note', id: String(row.id) }, [caller.accountId]);
      return ok({ id: row.id, label: ${JSON.stringify(label)} });
    }
    if (tool === 'list_notes') return ok({ notes: await env.DB.exec('SELECT id, text, by FROM notes ORDER BY id'), label: ${JSON.stringify(label)} });
    if (tool === 'fetch_url') { const r = await fetch(input.url); return ok({ status: r.status }); }
    if (tool === 'spin') { let x = 0; for (;;) x++; }
    return Response.json({ error: 'no tool ' + tool });
  },
};`;
const files = (label) => ({ 'server.js': b64(server(label)), 'migrations/0001_notes.sql': b64('CREATE TABLE notes (id INTEGER PRIMARY KEY, text TEXT NOT NULL, by TEXT);') });

const O = await signup(`olga-${tag}@example.com`, 'Olga'), P = await signup(`pia-${tag}@example.com`, 'Pia');
let r = await api(O.token, 'POST', '/v1/workspaces', { name: `Acme ${tag}`, slug: `acme-${tag}` }); const A = r.j.id;
r = await api(P.token, 'POST', '/v1/workspaces', { name: `Bravo ${tag}`, slug: `bravo-${tag}` }); const Bo = r.j.id;
t('two organizations', A && Bo);

// --- Upload and install (step 1) ------------------------------------------------------------------------------------------
r = await api(O.token, 'POST', `/v1/workspaces/${A}/apps/versions`, { manifest, files: { 'ui/x.js': b64('x') } });
t('a version without server.js is refused with the reason', r.s === 400 && /server\.js is missing/.test(r.j.error?.message), JSON.stringify(r.j));
r = await api(O.token, 'POST', `/v1/workspaces/${A}/apps/versions`, { manifest, files: files('v1') });
t('Olga uploads version 1', r.s === 201 && r.j.version === 1, JSON.stringify(r.j));
r = await api(O.token, 'POST', `/v1/workspaces/${A}/apps`, { name: 'notes', version: 1, grants: { members: true, accounts: [] } });
t('and installs it', r.s === 201 && r.j.version === 1, JSON.stringify(r.j));
await api(P.token, 'POST', `/v1/workspaces/${Bo}/apps/versions`, { manifest, files: files('v1') });
r = await api(P.token, 'POST', `/v1/workspaces/${Bo}/apps`, { name: 'notes', version: 1, grants: { members: true, accounts: [] } });
t('Pia installs the same app in Bravo', r.s === 201, JSON.stringify(r.j));

// --- The runner (step 2) --------------------------------------------------------------------------------------------------
const call = (tok, org, name, input) => api(tok, 'POST', `/v1/workspaces/${org}/tools/call`, { name, input });
r = await call(O.token, A, 'notes__add_note', { text: 'first' });
t('a tool runs in the loaded app, on its migrated table', r.j.ok && r.j.result.id === 1 && r.j.result.label === 'v1', JSON.stringify(r.j));
await call(O.token, A, 'notes__add_note', { text: 'second' });
r = await call(P.token, Bo, 'notes__add_note', { text: 'bravo only' });
r = await call(O.token, A, 'notes__list_notes', {});
t("Acme's store holds Acme's notes only", r.j.ok && r.j.result.notes.map((n) => n.text).join(',') === 'first,second', JSON.stringify(r.j));
r = await call(P.token, Bo, 'notes__list_notes', {});
t("and Bravo's Bravo's", r.j.ok && r.j.result.notes.map((n) => n.text).join(',') === 'bravo only', JSON.stringify(r.j));
r = await call(O.token, A, 'notes__fetch_url', { url: 'https://example.com/' });
t('it reaches a host it declared', r.j.ok && r.j.result.status === 200, JSON.stringify(r.j));
r = await call(O.token, A, 'notes__fetch_url', { url: 'https://evil.example.net/' });
t('and no other', r.j.ok && r.j.result.status === 403, JSON.stringify(r.j));
r = await api(O.token, 'GET', `/v1/events?workspace=${A}&types=app.notes.*`);
t('its events are in the log, about their author', (r.j.events ?? []).length === 2 && r.j.events[0].ref?.kind === 'note' && r.j.events[0].about?.length === 1, JSON.stringify(r.j).slice(0, 200));
r = await api(P.token, 'GET', `/v1/events?workspace=${Bo}&types=app.notes.*`);
t("Bravo's log has Bravo's one", (r.j.events ?? []).length === 1, (r.j.events ?? []).length);

// --- An update (step 1's versions, run by step 2) --------------------------------------------------------------------------
r = await api(O.token, 'POST', `/v1/workspaces/${A}/apps/versions`, { manifest, files: { ...files('v2'), 'migrations/0002_tags.sql': b64('ALTER TABLE notes ADD tag TEXT;') } });
r = await api(O.token, 'PUT', `/v1/workspaces/${A}/apps/notes`, { version: r.j.version, grants: { members: true, accounts: [] } });
t('Olga updates Acme to version 2', r.s === 200 && r.j.version === 2, JSON.stringify(r.j));
r = await call(O.token, A, 'notes__list_notes', {});
t('the new code runs on the same data', r.j.ok && r.j.result.label === 'v2' && r.j.result.notes.length === 2, JSON.stringify(r.j));

// --- The screen on the apps domain (step 3) ------------------------------------------------------------------------------
// The app's host goes in the Host header, to the local Worker's port: *.flowtoo.localhost needs no DNS this way.
const DOMAIN = process.env.APPS_DOMAIN ?? 'flowtoo.localhost:18899';
const raw = (u, cookie) => new Promise((resolve, reject) => {
  const url = new URL(u);
  const req = http.request({ host: '127.0.0.1', port: new URL(B).port, path: url.pathname + url.search, method: 'GET', headers: { host: url.host, 'x-forwarded-host': url.host, ...(cookie ? { cookie } : {}) } }, (res) => {
    let body = ''; res.setEncoding('utf8'); res.on('data', (d) => { body += d; }); res.on('end', () => resolve({ s: res.statusCode, h: res.headers, body }));
  });
  req.on('error', reject); req.end();
});
const screenManifest = { ...manifest, ui: { hosted: true } };
r = await api(O.token, 'POST', `/v1/workspaces/${A}/apps/versions`, { manifest: screenManifest, files: { ...files('v3'), 'ui/index.html': b64('<!doctype html><title>Notes</title><h1>Notes screen</h1>') } });
await api(O.token, 'PUT', `/v1/workspaces/${A}/apps/notes`, { version: r.j.version, grants: { members: true, accounts: [] } });
r = await api(O.token, 'POST', `/v1/workspaces/${A}/apps/notes/screen`, {});
const screenUrl = r.j.url ?? '';
t("the tab's door key points at the app's own host", r.s === 200 && new URL(screenUrl).host === `notes--${A.replace(/-/g, '')}.${DOMAIN}`, screenUrl);
let s1 = await raw(screenUrl);
const cookie = (s1.h['set-cookie']?.[0] ?? '').split(';')[0];
t('the key opens a session on that host, and the address loses the key', s1.s === 302 && cookie.startsWith('ff_app_session=') && s1.h.location === '/', s1.s + ' ' + JSON.stringify(s1.h));
s1 = await raw(screenUrl);
t('the same key does not open a second', s1.s === 401, s1.s);
const home = `http://notes--${A.replace(/-/g, '')}.${DOMAIN}/`;
s1 = await raw(home, cookie);
t('the session gets the screen from its ui/ files', s1.s === 200 && s1.body.includes('Notes screen') && /text\/html/.test(s1.h['content-type']), s1.s + ' ' + s1.body.slice(0, 80));
s1 = await raw(home + 'api/whoami', cookie);
let who = null; try { who = JSON.parse(s1.body); } catch { /* below */ }
t("the app's own path is answered by its isolate, told who is looking", s1.s === 200 && who?.organizationId === A && who?.scopes?.includes('notes:read'), s1.s + ' ' + s1.body.slice(0, 160));
s1 = await raw(home);
t('without the session, nothing', s1.s === 401, s1.s);
s1 = await raw(home + '__freeflow/tool', cookie);
t("the host's own path is not the screen's", s1.s === 404, s1.s);
await api(O.token, 'PUT', `/v1/workspaces/${A}/apps/notes/grants`, { members: false, accounts: [] });
s1 = await raw(home, cookie);
t('taking the scopes away closes the screen at once', s1.s === 401, s1.s);

// --- The suite for the app, as its caller (step 4) --------------------------------------------------------------------
const U = await signup(`uma-${tag}@example.com`, 'Uma');
r = await api(O.token, 'POST', `/v1/workspaces/${A}/invites`, { email: `uma-${tag}@example.com` });
await api(U.token, 'POST', '/v1/invites/accept', { token: (r.j.inviteUrl ?? '').split('/').pop() });
await api(O.token, 'PUT', `/v1/workspaces/${A}/apps/notes/grants`, { members: true, accounts: [] });
r = await api(O.token, 'GET', `/v1/workspaces/${A}/channels`);
const general = (r.j.channels ?? r.j ?? []).find?.((c) => c.name === 'general')?.id;
r = await api(O.token, 'POST', `/api/sheets?workspace=${A}`, { title: `Olga's private sheet ${tag}` });
const sheet = r.j.sheet?.id;
t('a channel and a private sheet of Olga\'s', general && sheet, JSON.stringify([general, sheet]));
const suiteServer = `
export default {
  async fetch(request, env) {
    const { tool, input, caller } = await request.json();
    try {
      if (tool === 'announce') return Response.json({ result: await env.SUITE.postMessage(input.forged ? 'x.y' : caller.ticket, input.channelId, input.text) });
      if (tool === 'read_doc') return Response.json({ result: await env.SUITE.readDocs(caller.ticket, input.path) });
    } catch (e) { return Response.json({ error: e.message }); }
    return Response.json({ error: 'no tool ' + tool });
  },
};`;
const suiteManifest = (uses) => ({
  name: 'notes', label: 'Notes', server: { hosted: true }, ...(uses ? { uses } : {}),
  scopes: [{ id: 'notes:read', label: 'Read notes', read: true }],
  tools: [
    { name: 'announce', description: 'Posts in Chat.', input: { type: 'object', properties: { channelId: { type: 'string' }, text: { type: 'string' }, forged: { type: 'boolean' } } }, scopes: ['notes:read'] },
    { name: 'read_doc', description: 'Reads a Docs file.', input: { type: 'object', properties: { path: { type: 'string' } } }, scopes: ['notes:read'] },
  ],
});
const installSuite = async (uses) => {
  const up = await api(O.token, 'POST', `/v1/workspaces/${A}/apps/versions`, { manifest: suiteManifest(uses), files: { 'server.js': b64(suiteServer) } });
  return api(O.token, 'PUT', `/v1/workspaces/${A}/apps/notes`, { version: up.j.version, grants: { members: true, accounts: [] } });
};
r = await installSuite(null);
r = await call(O.token, A, 'notes__announce', { channelId: general, text: 'hello' });
t('without chat:write in its uses, the app cannot post', r.j.ok === false && /does not declare "chat:write"/.test(r.j.error), JSON.stringify(r.j));
r = await installSuite(['chat:write', 'docs:read']);
r = await call(O.token, A, 'notes__announce', { channelId: general, text: `hello from the app ${tag}` });
t('with it, the app posts as its caller', r.j.ok && r.j.result?.id, JSON.stringify(r.j));
r = await api(O.token, 'GET', `/v1/channels/${general}/messages?limit=5`);
const posted = (r.j.messages ?? r.j ?? []).find?.((m) => (m.body ?? m.text ?? '').includes(`hello from the app ${tag}`));
t('the message is in the channel, from Olga', !!posted, JSON.stringify(r.j).slice(0, 160));
r = await call(O.token, A, 'notes__announce', { channelId: general, text: 'x', forged: true });
t('a made-up ticket is refused', r.j.ok === false && /ticket is not valid/.test(r.j.error), JSON.stringify(r.j));
r = await call(O.token, A, 'notes__read_doc', { path: `/api/sheets/${sheet}` });
t('the app reads Olga\'s sheet for Olga', r.j.ok && JSON.stringify(r.j.result).includes(sheet), JSON.stringify(r.j).slice(0, 160));
r = await call(U.token, A, 'notes__read_doc', { path: `/api/sheets/${sheet}` });
t('but not for Uma, who cannot see it', r.j.ok === false, JSON.stringify(r.j).slice(0, 160));
r = await call(O.token, A, 'notes__read_doc', { path: '/api/settings' });
t('and only Docs\' read paths', r.j.ok === false && /readDocs reads/.test(r.j.error), JSON.stringify(r.j));

// --- Publishing with the bridge, going back, the export (step 5) ------------------------------------------------------
const { execFileSync } = await import('node:child_process');
const os = await import('node:os');
const pathMod = await import('node:path');
const bridge = pathMod.resolve(pathMod.dirname(new URL(import.meta.url).pathname), '../../agent-bridge/dist/index.js');
const folder = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'ff-app-'));
const kv = { name: 'kv', label: 'Key values', server: { hosted: true }, scopes: [{ id: 'kv:use', label: 'Use it' }],
  tools: [{ name: 'put', description: 'Sets a key.', input: { type: 'object' }, scopes: ['kv:use'] }, { name: 'all', description: 'Lists keys.', input: { type: 'object' }, scopes: ['kv:use'] }] };
const kvServer = (label) => `export default { async fetch(request, env) {
  const { tool, input } = await request.json();
  if (tool === 'put') { await env.DB.exec('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)', [input.k, input.v]); return Response.json({ result: { ok: true } }); }
  return Response.json({ result: { label: ${JSON.stringify('LABEL')}.replace('LABEL', ${JSON.stringify(label)}), rows: await env.DB.exec('SELECT k, v FROM kv ORDER BY k') } });
} };`;
fs.writeFileSync(pathMod.join(folder, 'freeflow-app.json'), JSON.stringify(kv));
fs.writeFileSync(pathMod.join(folder, 'server.js'), kvServer('kv1'));
fs.mkdirSync(pathMod.join(folder, 'migrations'));
fs.writeFileSync(pathMod.join(folder, 'migrations', '0001_kv.sql'), 'CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT);');
const publish = () => execFileSync(process.execPath, [bridge, 'app', 'publish', folder, '--workspace', A], { env: { ...process.env, FLOW_SERVER_URL: B, FLOW_TOKEN: U.token }, cwd: os.tmpdir(), encoding: 'utf8' });
let out = publish();
t('a member publishes a folder with the bridge', /uploaded kv version 1/.test(out), out);
r = await api(U.token, 'POST', `/v1/workspaces/${A}/apps`, { name: 'kv', version: 1, grants: { members: true, accounts: [] } });
t('but only an owner or admin installs it', r.s === 403, r.s);
r = await api(O.token, 'GET', `/v1/workspaces/${A}/apps/versions`);
t('Olga sees the upload, not installed', (r.j.versions ?? []).some((v) => v.name === 'kv' && v.version === 1 && !v.installed), JSON.stringify(r.j).slice(0, 160));
await api(O.token, 'POST', `/v1/workspaces/${A}/apps`, { name: 'kv', version: 1, grants: { members: true, accounts: [] } });
await call(O.token, A, 'kv__put', { k: 'a', v: 'before' });
fs.writeFileSync(pathMod.join(folder, 'server.js'), kvServer('kv2'));
out = publish();
await api(O.token, 'PUT', `/v1/workspaces/${A}/apps/kv`, { version: 2, grants: { members: true, accounts: [] } });
await call(O.token, A, 'kv__put', { k: 'b', v: 'after' });
r = await call(O.token, A, 'kv__all', {});
t('version 2 runs, with a row written after the update', r.j.ok && r.j.result.label === 'kv2' && r.j.result.rows.length === 2, JSON.stringify(r.j));
r = await api(O.token, 'GET', `/v1/workspaces/${A}/apps`);
const kvApp = (r.j.apps ?? []).find((a) => a.name === 'kv');
t('Admin sees a restore point back to version 1', kvApp?.restorePoint?.fromVersion === 1 && kvApp.version === 2, JSON.stringify(kvApp?.restorePoint));
r = await api(O.token, 'GET', `/v1/workspaces/${A}/apps/kv/export`);
t('the export holds the app\'s table and its rows, not the platform\'s', r.s === 200 && r.j.tables?.kv?.length === 2 && !Object.keys(r.j.tables).some((k) => k.startsWith('_freeflow')), JSON.stringify(r.j).slice(0, 200));
r = await api(O.token, 'POST', `/v1/workspaces/${A}/apps/kv/restore`, {});
t('Olga goes back', r.s === 200 && r.j.version === 1, JSON.stringify(r.j));
await sleep(500);
r = await call(O.token, A, 'kv__all', {});
// A local runtime switches the version back but keeps the data (its restore points are not real); Cloudflare restores
// it too, which the spike on the account showed (decision_log 2026-11-17). RESTORE_DATA=1 asks for both, there.
const dataBack = r.j.ok && r.j.result.rows.map((x) => x.k).join() === 'a';
t('version 1 runs again' + (process.env.RESTORE_DATA ? ', on the data from before the update' : ''), r.j.ok && r.j.result.label === 'kv1' && (!process.env.RESTORE_DATA || dataBack), JSON.stringify(r.j));
fs.rmSync(folder, { recursive: true, force: true });

// --- The built-in SDK (step 6) ----------------------------------------------------------------------------------------
const sdkApp = { name: 'todo', label: 'Todo', server: { hosted: true }, ui: { hosted: true }, scopes: [{ id: 'todo:use', label: 'Use it', read: true }],
  tools: [{ name: 'add', description: 'Adds a todo.', input: { type: 'object', properties: { text: { type: 'string' } } }, scopes: ['todo:use'] },
    { name: 'fail', description: 'Refuses.', input: { type: 'object' }, scopes: ['todo:use'] }],
  events: ['todo.added'] };
const sdkServer = `import { defineApp } from 'freeflow';
export default defineApp({
  tools: {
    add: async (input, ctx) => {
      await ctx.db.run('INSERT INTO todos (text, by) VALUES (?, ?)', input.text, ctx.caller.accountId);
      await ctx.publish('todo.added', { text: input.text }, { about: [ctx.caller.accountId] });
      return { count: (await ctx.db.one('SELECT COUNT(*) AS n FROM todos')).n };
    },
    fail: async () => { throw new Error('not today'); },
  },
  routes: { 'GET /api/todos': async (request, ctx) => ({ viewer: ctx.caller.displayName, todos: await ctx.db.all('SELECT text FROM todos') }) },
});`;
r = await api(O.token, 'POST', `/v1/workspaces/${A}/apps/versions`, { manifest: sdkApp, files: { 'server.js': b64(sdkServer), 'migrations/0001_todos.sql': b64('CREATE TABLE todos (id INTEGER PRIMARY KEY, text TEXT, by TEXT);'), 'ui/index.html': b64('<h1>Todo</h1>') } });
await api(O.token, 'POST', `/v1/workspaces/${A}/apps`, { name: 'todo', version: r.j.version, grants: { members: true, accounts: [] } });
r = await call(O.token, A, 'todo__add', { text: 'buy milk' });
t('an app written with the built-in SDK answers its tool', r.j.ok && r.j.result.count === 1, JSON.stringify(r.j));
r = await call(O.token, A, 'todo__fail', {});
t("a tool's throw is the agent's error", r.j.ok === false && r.j.error === 'not today', JSON.stringify(r.j));
r = await api(O.token, 'POST', `/v1/workspaces/${A}/apps/todo/screen`, {});
let s2 = await raw(r.j.url);
const todoCookie = (s2.h['set-cookie']?.[0] ?? '').split(';')[0];
s2 = await raw(`http://todo--${A.replace(/-/g, '')}.${DOMAIN}/api/todos`, todoCookie);
t("and the screen's route, with ctx.caller the viewer", s2.s === 200 && JSON.parse(s2.body).viewer === 'Olga' && JSON.parse(s2.body).todos.length === 1, s2.s + ' ' + s2.body.slice(0, 120));

// --- Drafts and dev installs (step 7) -------------------------------------------------------------------------------
r = await api(U.token, 'POST', `/v1/workspaces/${A}/apps/drafts`, { name: 'shop', label: 'Shopping' });
t('a member starts a draft from the starter project', r.s === 201 && r.j.draft?.problems?.length === 0 && 'server.js' in (r.j.draft?.files ?? {}), JSON.stringify(r.j).slice(0, 200));
r = await api(U.token, 'POST', `/v1/workspaces/${A}/apps/drafts/shop/try`, { tool: 'add_item', input: { text: 'bread' } });
t('Uma tries its tool in her dev install', r.j.ok && r.j.result?.id === 1, JSON.stringify(r.j));
await api(U.token, 'DELETE', `/v1/workspaces/${A}/apps/drafts/shop`);
await api(U.token, 'POST', `/v1/workspaces/${A}/apps/drafts`, { name: 'shop', label: 'Shopping' });
r = await api(U.token, 'POST', `/v1/workspaces/${A}/apps/drafts/shop/try`, { tool: 'list_items', input: {} });
t("deleting a draft deletes its dev install's data", r.j.ok && r.j.result.length === 0, JSON.stringify(r.j));
r = await api(U.token, 'POST', `/v1/workspaces/${A}/apps/drafts/shop/try`, { tool: 'add_item', input: { text: 'bread' } });
r = await api(U.token, 'POST', `/v1/workspaces/${A}/apps/drafts/shop/try`, { tool: 'list_items', input: {} });
t('and its data is there', r.j.ok && r.j.result?.length === 1 && r.j.result[0].text === 'bread', JSON.stringify(r.j));
r = await api(O.token, 'GET', `/v1/workspaces/${A}/apps/drafts/shop`);
t("Olga does not see Uma's draft", r.s === 404, r.s);
r = await api(O.token, 'POST', `/v1/workspaces/${A}/apps/drafts/shop/try`, { tool: 'list_items', input: {} });
t('nor try it', r.j.ok === false, JSON.stringify(r.j));
r = await api(U.token, 'GET', `/v1/events?workspace=${A}&types=appdev.*`);
t("the dev install's events are Uma's", (r.j.events ?? []).some((e) => e.type === 'appdev.shop.item.added'), (r.j.events ?? []).map((e) => e.type).join());
r = await api(O.token, 'GET', `/v1/events?workspace=${A}&types=appdev.*`);
t("and not Olga's", (r.j.events ?? []).length === 0, (r.j.events ?? []).length);
r = await api(U.token, 'GET', `/v1/workspaces/${A}/apps/drafts/shop/file?path=server.js`);
const original = r.j.text;
r = await api(U.token, 'PUT', `/v1/workspaces/${A}/apps/drafts/shop/file`, { path: 'server.js', text: original.replace("list_items: async (input, ctx) =>", "list_items: async (input, ctx) => { throw new Error('broken on purpose'); }, old_list: async (input, ctx) =>") });
r = await api(U.token, 'POST', `/v1/workspaces/${A}/apps/drafts/shop/try`, { tool: 'list_items', input: {} });
t('an edit runs at once, its error shown', r.j.ok === false && /broken on purpose/.test(r.j.error), JSON.stringify(r.j));
await api(U.token, 'PUT', `/v1/workspaces/${A}/apps/drafts/shop/file`, { path: 'server.js', text: original });
r = await api(U.token, 'PUT', `/v1/workspaces/${A}/apps/drafts/shop/file`, { path: 'freeflow-app.json', text: '{ "name": "shop" }' });
t('a broken manifest shows as problems', (r.j.draft?.problems ?? []).length > 0, JSON.stringify(r.j.draft?.problems).slice(0, 160));
r = await api(U.token, 'POST', `/v1/workspaces/${A}/apps/drafts/shop/try`, { tool: 'list_items', input: {} });
t('and the draft does not run until they are fixed', r.j.ok === false, JSON.stringify(r.j).slice(0, 160));
await api(U.token, 'DELETE', `/v1/workspaces/${A}/apps/drafts/shop`);
r = await api(U.token, 'POST', `/v1/workspaces/${A}/apps/drafts`, { name: 'shop', label: 'Shopping' });
await api(U.token, 'POST', `/v1/workspaces/${A}/apps/drafts/shop/try`, { tool: 'add_item', input: { text: 'dev only' } });
r = await api(U.token, 'POST', `/v1/workspaces/${A}/apps/drafts/shop/publish`, {});
t('Uma publishes it as a version', r.s === 201 && r.j.name === 'shop' && r.j.version >= 1, JSON.stringify(r.j));
const shopVersion = r.j.version;
r = await api(O.token, 'POST', `/v1/workspaces/${A}/apps`, { name: 'shop', version: shopVersion, grants: { members: true, accounts: [] } });
t('Olga installs it', r.s === 201, JSON.stringify(r.j).slice(0, 120));
r = await call(U.token, A, 'shop__list_items', {});
t("the installed app starts with its own data, not the dev install's", r.j.ok && r.j.result.length === 0, JSON.stringify(r.j));
r = await api(U.token, 'POST', `/v1/workspaces/${A}/apps/drafts`, { name: 'shop', label: 'x', fromInstalled: true });
t('a second draft of the same name is refused', r.s === 409, r.s);
r = await api(O.token, 'POST', `/v1/workspaces/${A}/apps/drafts`, { name: 'shop', label: 'x', fromInstalled: true });
t("Olga starts a draft from the installed app's files", r.s === 201 && r.j.draft?.problems?.length === 0 && 'ui/index.html' in (r.j.draft?.files ?? {}), JSON.stringify(r.j).slice(0, 160));
r = await api(U.token, 'POST', `/v1/workspaces/${A}/apps/drafts`, { name: 'drafts', label: 'x' });
t('a reserved name is refused', r.s === 400, r.s);

// --- An agent builds an app with the building tools (step 8) ------------------------------------------------------
r = await api(O.token, 'POST', `/v1/workspaces/${A}/agent-invites`, {});
r = await api(null, 'POST', '/v1/agents/redeem', { code: r.j.code, username: `builder${tag}`, key: 'a-long-agent-key-for-the-hosted-test', name: 'Builder' });
const BLD = r.j.agentToken;
r = await api(BLD, 'GET', `/v1/tools?door=bridge&workspace=${A}`);
const bt = (r.j.tools ?? []).map((x) => x.name);
t('the bridge lists Builder the building tools', bt.includes('apps__create_draft') && bt.includes('apps__try_tool') && bt.includes('apps__publish_draft'), bt.filter((n) => n.startsWith('apps__')).join());
r = await call(BLD, A, 'apps__guide', {});
t('the guide tells it how', r.j.ok && /defineApp/.test(r.j.result.guide) && /freeflow-app\.json/.test(r.j.result.guide), JSON.stringify(r.j).slice(0, 100));
r = await call(BLD, A, 'apps__create_draft', { name: 'polls', label: 'Polls' });
t('Builder starts a draft', r.j.ok && r.j.result.name === 'polls', JSON.stringify(r.j).slice(0, 120));
r = await call(BLD, A, 'apps__read_file', { app: 'polls', path: 'freeflow-app.json' });
const pm = JSON.parse(r.j.result);
pm.tools.push({ name: 'vote', description: 'Votes for an option.', input: { type: 'object', properties: { option: { type: 'string' } }, required: ['option'] }, scopes: ['polls:use'] });
await call(BLD, A, 'apps__write_file', { app: 'polls', path: 'freeflow-app.json', text: JSON.stringify(pm, null, 2) });
await call(BLD, A, 'apps__write_file', { app: 'polls', path: 'migrations/0002_votes.sql', text: 'CREATE TABLE votes (option TEXT NOT NULL, by TEXT NOT NULL);' });
r = await call(BLD, A, 'apps__read_file', { app: 'polls', path: 'server.js' });
r = await call(BLD, A, 'apps__write_file', { app: 'polls', path: 'server.js', text: r.j.result.replace('  tools: {', "  tools: {\n    vote: async (input, ctx) => { await ctx.db.run('INSERT INTO votes (option, by) VALUES (?, ?)', input.option, ctx.caller.accountId); return ctx.db.all('SELECT option, COUNT(*) AS n FROM votes GROUP BY option'); },") });
t('it adds a tool, a table and the code, and the draft has no problems', r.j.ok && r.j.result.problems.length === 0, JSON.stringify(r.j).slice(0, 200));
r = await call(BLD, A, 'apps__try_tool', { app: 'polls', tool: 'vote', input: { option: 'tea' } });
t('it tries the new tool', r.j.ok && r.j.result?.[0]?.option === 'tea' && r.j.result[0].n === 1, JSON.stringify(r.j));
r = await call(BLD, A, 'apps__publish_draft', { app: 'polls' });
t('and publishes it, told an owner or admin installs it', r.j.ok && r.j.result.name === 'polls' && /owner or admin/.test(r.j.result.next), JSON.stringify(r.j));
r = await api(BLD, 'POST', `/v1/workspaces/${A}/apps`, { name: 'polls', version: r.j.result?.version, grants: { members: true, accounts: [] } });
t('Builder cannot install it itself', r.s === 403, r.s);

// --- A draft's preview (step 9) --------------------------------------------------------------------------------------
r = await api(U.token, 'POST', `/v1/workspaces/${A}/apps/drafts/shop/preview`, {});
const prevUrl = r.j.url ?? '';
t("the draft's preview is on a dev host of its own", r.s === 200 && /^http:\/\/dev-[0-9a-f]{10}--[0-9a-f]{32}\./.test(prevUrl), prevUrl.slice(0, 90));
let pv = await raw(prevUrl);
const prevCookie = (pv.h['set-cookie']?.[0] ?? '').split(';')[0];
t('its author opens it', pv.s === 302 && prevCookie.startsWith('ff_app_session='), pv.s);
const prevHome = `${new URL(prevUrl).origin}/`;
pv = await raw(prevHome, prevCookie);
t("and sees the draft's screen", pv.s === 200 && pv.body.includes('<h1>Shopping</h1>'), pv.s + ' ' + pv.body.slice(0, 60));
pv = await raw(prevHome + 'api/items', prevCookie);
t('its routes run in the dev install, as the author', pv.s === 200 && JSON.parse(pv.body).viewer === 'Uma', pv.s + ' ' + pv.body.slice(0, 100));
await api(U.token, 'PUT', `/v1/workspaces/${A}/apps/drafts/shop/file`, { path: 'ui/index.html', text: '<h1>Changed</h1>' });
pv = await raw(prevHome, prevCookie);
t('an edit shows on the next load', pv.body.includes('Changed'), pv.body.slice(0, 60));
r = await api(O.token, 'POST', `/v1/workspaces/${A}/apps/drafts/shop/preview`, {});
t("Olga's own draft of shop has a preview of its own, not Uma's", r.s === 200 && new URL(r.j.url).host !== new URL(prevUrl).host, r.j.url?.slice(0, 60));
pv = await raw(r.j.url.replace(new URL(r.j.url).host, new URL(prevUrl).host));
t("and her door key does not open Uma's", pv.s === 401, pv.s);
pv = await raw(prevHome, cookie);
t("nor in with another app's session", pv.s === 401, pv.s);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
