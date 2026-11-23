// End-to-end check of hosted apps' upload addresses (docs/specs/user-apps.md §8.1, ctx.files.uploadUrl): a tool hands
// its caller a one-use address on the app's own host, the caller POSTs a file's bytes there with no session, and the host
// hands them to the app's route as that caller. Against a local `wrangler dev` with an apps domain (as e2e-hosted-apps.mjs):
//   printf 'EDGE_ORIGIN_SECRET=x\nFLOW_DATA_KEY=%s\n' "$(openssl rand -base64 32)" > .dev.vars; mkdir -p public; rm -rf .wrangler/state
//   npx wrangler dev --port 18799 --inspector-port 19299 --local --enable-containers=false --local-upstream localhost:18799 \
//     --var PORTED_HOSTS:edge.freeflow.im,localhost --var ASSET_HOSTS:none --var ORIGIN_URL:http://localhost:9 \
//     --var WEB_URL_BASE:http://localhost:18799 --var FLOW_WEB_URL:http://localhost:18799 \
//     --var APPS_DOMAIN:flowtoo.localhost:18799 --var APPS_SCHEME:http > /tmp/edge-uploads.log 2>&1 &
//   node test/e2e-app-uploads.mjs /tmp/edge-uploads.log
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
/** A request to an app's host: the host in the Host header, to the local Worker's port (*.localhost needs no DNS). */
const raw = (address, { method = 'GET', body, headers = {} } = {}) => new Promise((resolve, reject) => {
  const url = new URL(address);
  const req = http.request({ host: '127.0.0.1', port: new URL(B).port, path: url.pathname + url.search, method, headers: { host: url.host, 'x-forwarded-host': url.host, ...headers } }, (res) => {
    let b = ''; res.setEncoding('utf8'); res.on('data', (d) => { b += d; }); res.on('end', () => { let j; try { j = JSON.parse(b); } catch { j = b; } resolve({ s: res.statusCode, j, h: res.headers }); });
  });
  req.on('error', reject); req.end(body);
});
const post = (url, bytes, type = 'application/x-www-form-urlencoded') => raw(url, { method: 'POST', body: bytes, headers: { 'content-type': type, 'content-length': bytes.length } });
const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7a6a4b10000000049454e44ae426082', 'hex');

// The app: a tool that asks for an address to one of its routes, and the route, which keeps the bytes as its caller's.
const manifest = {
  name: 'shots', label: 'Shots', server: { hosted: true }, ui: { hosted: true }, scopes: [{ id: 'shots:use', label: 'Use it', read: true }],
  tools: [
    { name: 'upload_url', description: 'An upload address.', input: { type: 'object' }, scopes: ['shots:use'] },
    { name: 'list', description: 'The files.', input: { type: 'object' }, scopes: ['shots:use'] },
  ],
};
const server = `import { defineApp, AppError } from 'freeflow';
export default defineApp({
  tools: {
    upload_url: async (input, ctx) => ctx.files.uploadUrl(input.path ?? '/api/shots?name=' + encodeURIComponent(input.name ?? 'a.png')),
    list: async (input, ctx) => ctx.db.all('SELECT key, name, by, size FROM shots ORDER BY key'),
  },
  routes: {
    'POST /api/shots': async (request, ctx) => {
      if (!ctx.caller?.scopes?.includes('shots:use')) throw new AppError('no access', 403);
      const name = new URL(request.url).searchParams.get('name');
      const bytes = await request.arrayBuffer();
      const key = 'shots/' + crypto.randomUUID();
      await ctx.files.put(key, bytes, { type: 'image/png' });
      await ctx.db.run('INSERT INTO shots (key, name, by, size) VALUES (?, ?, ?, ?)', key, name, ctx.caller.accountId, bytes.byteLength);
      return { key, name, size: bytes.byteLength, caller: ctx.caller, type: request.headers.get('content-type') };
    },
  },
});`;
const files = { 'server.js': b64(server), 'migrations/0001_shots.sql': b64('CREATE TABLE shots (key TEXT PRIMARY KEY, name TEXT, by TEXT, size INTEGER);'), 'ui/index.html': b64('<h1>Shots</h1>') };

const O = await signup(`olga-${tag}@example.com`, 'Olga');
let r = await api(O.token, 'POST', '/v1/workspaces', { name: `Acme ${tag}`, slug: `acme-${tag}` }); const A = r.j.id;
r = await api(O.token, 'POST', `/v1/workspaces/${A}/apps/versions`, { manifest, files });
r = await api(O.token, 'POST', `/v1/workspaces/${A}/apps`, { name: 'shots', version: r.j.version, grants: { members: true, accounts: [] } });
t('the app is installed', r.s === 201, JSON.stringify(r.j));
const call = (input) => api(O.token, 'POST', `/v1/workspaces/${A}/tools/call`, { name: 'shots__upload_url', input });

// --- The address -----------------------------------------------------------------------------------------------------------
r = await call({ name: 'card.png' });
const up = r.j.result ?? {};
const host = `shots--${A.replace(/-/g, '')}.flowtoo.localhost:18799`;
t("the tool gets a one-use address on the app's own host", r.j.ok && new URL(up.url).host === host && new URL(up.url).pathname.startsWith('/__freeflow/upload/') && up.method === 'POST' && up.maxBytes === 10_000_000 && up.expiresInSeconds === 300, JSON.stringify(r.j).slice(0, 200));
for (const bad of ['/__freeflow/oauth/github', '//evil.example/x', 'https://evil.example/x', 'api/shots']) {
  r = await call({ path: bad });
  t(`an address to ${bad} is refused`, r.j.ok === false && /own paths/.test(r.j.error), JSON.stringify(r.j));
}

// --- Redeeming it ----------------------------------------------------------------------------------------------------------
let res = await raw(up.url);
t('a GET is refused, and does not spend it', res.s === 405, res.s);
res = await post(up.url, Buffer.alloc(10_000_001)).catch((e) => ({ s: 'error ' + e.message }));
t('a body over 10 MB is refused before it is read', res.s === 413, JSON.stringify(res.j ?? res.s));
res = await post(up.url, Buffer.alloc(0));
t('an empty body is refused', res.s === 400, res.s);
const tampered = up.url.replace(/\.([A-Za-z0-9_-]+)$/, (m, sig) => '.' + (sig[0] === 'A' ? 'B' : 'A') + sig.slice(1));
res = await post(tampered, png);
t('a forged address is refused', res.s === 401, res.s + ' ' + JSON.stringify(res.j));
res = await post(up.url.replace('shots--', 'other--'), png);
t("the address works only on its own app's host", res.s === 401 || res.s === 404, res.s);
res = await post(up.url, png);
t("the bytes reach the app's route, as they were", res.s === 200 && res.j.size === png.length && res.j.name === 'card.png', res.s + ' ' + JSON.stringify(res.j).slice(0, 200));
t('as the caller who asked, marked an upload, with no ticket in sight', res.j.caller?.displayName === 'Olga' && res.j.caller?.upload === true && res.j.caller?.ticket === undefined && res.j.caller?.scopes?.includes('shots:use'), JSON.stringify(res.j.caller));
t("curl's default form type is not passed on as the file's", res.j.type === null, res.j.type);
t('and no cache keeps the answer', /no-store/.test(res.h['cache-control'] ?? ''), res.h['cache-control']);
r = await api(O.token, 'POST', `/v1/workspaces/${A}/tools/call`, { name: 'shots__list', input: {} });
t('the app kept the file', r.j.ok && r.j.result.length === 1 && r.j.result[0].size === png.length, JSON.stringify(r.j));
res = await post(up.url, png);
t('the address works once', res.s === 401 && /used already|expired/.test(res.j.error), res.s + ' ' + JSON.stringify(res.j));

// --- The caller's access is checked again when the bytes come ------------------------------------------------------------
r = await call({ name: 'late.png' });
const late = r.j.result.url;
await api(O.token, 'PUT', `/v1/workspaces/${A}/apps/shots/grants`, { members: false, accounts: [] });
res = await post(late, png);
t('an address whose caller lost the scopes is refused', res.s === 403, res.s + ' ' + JSON.stringify(res.j));
await api(O.token, 'PUT', `/v1/workspaces/${A}/apps/shots/grants`, { members: true, accounts: [] });

// --- A draft's dev install gets addresses on its preview host --------------------------------------------------------------
await api(O.token, 'POST', `/v1/workspaces/${A}/apps/drafts`, { name: 'shots', label: 'Shots', fromInstalled: true });
r = await api(O.token, 'POST', `/v1/workspaces/${A}/apps/drafts/shots/try`, { tool: 'upload_url', input: { name: 'dev.png' } });
const devUrl = r.j.result?.url ?? '';
t("a draft's address is on its preview host", r.j.ok && /^dev-[0-9a-f]{10}--/.test(new URL(devUrl).host), JSON.stringify(r.j).slice(0, 160));
res = await post(devUrl.replace(new URL(devUrl).host, host), png);
t("a draft's address does not work on the installed app's host", res.s === 401, res.s);
res = await post(devUrl, png);
t("and its bytes go to the draft's own store", res.s === 200 && res.j.name === 'dev.png', res.s + ' ' + JSON.stringify(res.j).slice(0, 160));
r = await api(O.token, 'POST', `/v1/workspaces/${A}/tools/call`, { name: 'shots__list', input: {} });
t("not the installed app's", r.j.ok && r.j.result.length === 1, JSON.stringify(r.j));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
