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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
