// Read-only checks of a host the suite answers on, before and after it moves behind the Worker
// (docs/ops/EDGE_FRONT_DOOR.md). Sends no credentials and changes nothing.
//   node scripts/check-front-door.mjs app.freeflow.im
//   node scripts/check-front-door.mjs docs.freeflow.im --legacy
// Exits 1 if a check fails. `behind the Worker` is reported, not checked: the script runs on both sides of the switch.
import https from 'node:https';
const host = process.argv[2];
const legacy = process.argv.includes('--legacy');
if (!host) throw new Error('Name a host: node scripts/check-front-door.mjs app.freeflow.im');
const base = `https://${host}`;
let failed = 0;

function check(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
  if (!ok) failed++;
}

const get = (path, init = {}) => fetch(base + path, { redirect: 'manual', ...init });

/** A socket upgrade's answer (HTTP/1.1, as browsers make it): its status, without credentials. */
function upgradeStatus(path) {
  return new Promise((resolve) => {
    const req = https.request({ host, path, headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' }, timeout: 8000 });
    req.on('upgrade', (res, socket) => { socket.destroy(); resolve(res.statusCode); });
    req.on('response', (res) => { res.resume(); resolve(res.statusCode); });
    req.on('timeout', () => { req.destroy(); resolve('timed out'); });
    req.on('error', (e) => resolve(e.message));
    req.end();
  });
}

const edge = await get('/edge/health');
console.log(`     behind the Worker: ${edge.status === 200 && (await edge.text()).includes('"ok"') ? 'yes' : 'no'}`);

const metadata = await get('/.well-known/oauth-authorization-server');
check('the plugin\'s OAuth metadata answers', metadata.status === 200, String(metadata.status));

if (legacy) {
  const page = await get('/some/page');
  check('a page redirects to the suite', page.status === 301 && (page.headers.get('location') ?? '').includes('/docs/some/page'), `${page.status} ${page.headers.get('location')}`);
} else {
  const root = await get('/');
  const html = await root.text();
  check('the app\'s page is served', root.status === 200 && html.includes('<div id="root"'), String(root.status));
  const asset = html.match(/(?:src|href)="(\/assets\/[^"]+\.js)"/)?.[1];
  check('the page names a script', !!asset, asset ?? 'none found');
  if (asset) {
    const file = await get(asset);
    check('the script loads', file.status === 200 && (file.headers.get('content-type') ?? '').includes('javascript'), `${file.status}, cache-control: ${file.headers.get('cache-control')}`);
  }
  const deep = await get('/some/deep/link');
  check('a deep link gets the app\'s page', deep.status === 200 && (await deep.text()).includes('<div id="root"'), String(deep.status));
  const workspace = await get('/docs');
  check('/docs sends a stranger to sign in', workspace.status === 302 && (workspace.headers.get('location') ?? '').includes('next='), `${workspace.status} ${workspace.headers.get('location')}`);
  const me = await get('/v1/me');
  check('the API refuses without a session', me.status === 401 && (me.headers.get('content-type') ?? '').includes('json'), String(me.status));
  const docsMe = await get('/api/auth/me');
  check('the Workspace API answers', docsMe.status < 500, String(docsMe.status));
  // The socket is per organization (/v1/ws?workspace=<id>) and authenticates in its first frame; the Worker refuses an
  // address with no organization, and an organization nobody belongs to, before waking an object.
  const bare = await upgradeStatus('/v1/ws');
  check('a socket must name its organization', bare === 404, String(bare));
  const unknown = await upgradeStatus('/v1/ws?workspace=00000000-0000-4000-8000-000000000000');
  check('a socket for no organization is refused', unknown === 404, String(unknown));
}

console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
