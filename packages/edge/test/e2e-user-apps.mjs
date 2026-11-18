// End-to-end check of user apps, phase 1 (docs/specs/user-apps.md §14): the example Taskboard (examples/user-apps/taskboard)
// installed from its manifest URL, its tools at the bridge's door, a signed call and signed events, a wake subscription
// on an assignment, the read-scope rule on its events, the screen's door key, and removal. Against a local `wrangler dev`:
//   printf 'EDGE_ORIGIN_SECRET=x\nFLOW_DATA_KEY=%s\n' "$(openssl rand -base64 32)" > .dev.vars; mkdir -p public; rm -rf .wrangler/state
//   npx wrangler dev --port 18799 --inspector-port 19299 --local --enable-containers=false --local-upstream localhost:18799 \
//     --var PORTED_HOSTS:edge.freeflow.im,localhost --var ASSET_HOSTS:none --var ORIGIN_URL:http://localhost:9 \
//     --var WEB_URL_BASE:http://localhost:18799 --var FLOW_WEB_URL:http://localhost:18799 > /tmp/edge-apps.log 2>&1 &
//   node test/e2e-user-apps.mjs /tmp/edge-apps.log
// It starts the example app itself on :18790 (twice: before the install, then with the secret the install returned).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const log = process.argv[2];
const B = process.env.B ?? 'http://localhost:18799';
const APP_PORT = 18790;
const APP = `http://localhost:${APP_PORT}`;
const example = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../examples/user-apps/taskboard/server.mjs');

let pass = 0, fail = 0;
const t = (n, ok, d = '') => { ok ? pass++ : fail++; console.log((ok ? 'ok  ' : 'FAIL') + ' ' + n + (d ? ': ' + String(d).slice(0, 200) : '')); };
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
let child = null;
async function startApp(env = {}) {
  if (child) { child.kill(); await sleep(300); }
  child = spawn(process.execPath, [example], { env: { ...process.env, PORT: String(APP_PORT), PUBLIC_URL: APP, ...env }, stdio: ['ignore', 'inherit', 'inherit'] });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`${APP}/freeflow-app.json`)).ok) return; } catch { /* not yet */ } await sleep(100); }
  throw new Error('the example app did not start');
}
const tag = Date.now().toString(36);

try {
  await startApp();

  // --- An organization: Olga owns it, Uma is a member, Builder is a shared agent ------------------------------------------
  const O = await signup(`olga-${tag}@example.com`, 'Olga'), U = await signup(`uma-${tag}@example.com`, 'Uma');
  let r = await api(O.token, 'POST', '/v1/workspaces', { name: `Acme ${tag}`, slug: `acme-${tag}` }); const A = r.j.id;
  r = await api(O.token, 'POST', `/v1/workspaces/${A}/invites`, { email: `uma-${tag}@example.com` }); const inv = (r.j.inviteUrl ?? '').split('/').pop();
  r = await api(U.token, 'POST', '/v1/invites/accept', { token: inv }); t('Uma joins Acme', r.s < 300, r.s);
  r = await api(O.token, 'POST', `/v1/workspaces/${A}/agent-invites`, {});
  r = await api(null, 'POST', '/v1/agents/redeem', { code: r.j.code, username: `builder${tag}`, key: 'a-long-agent-key-for-the-apps-test', name: 'Builder' }); const BLD = r.j.agentToken;
  t('Builder joins as a shared agent', r.s === 201 && !!BLD, r.s);
  const accountOf = async (tok) => (await api(tok, 'GET', '/v1/me/accounts')).j.accounts.find((a) => a.organizationId === A)?.id;
  const [OA, UA, BA] = [await accountOf(O.token), await accountOf(U.token), await accountOf(BLD)];
  t('three accounts', OA && UA && BA, JSON.stringify([OA, UA, BA]));

  // --- Install (§4, §9.3) -------------------------------------------------------------------------------------------------
  r = await api(O.token, 'POST', `/v1/workspaces/${A}/apps/preview`, { url: `${APP}/freeflow-app.json` });
  t('the manifest reads and passes', r.s === 200 && r.j.manifest?.name === 'taskboard' && r.j.manifest.tools.length === 6, r.s + ' ' + JSON.stringify(r.j).slice(0, 160));
  r = await api(O.token, 'POST', `/v1/workspaces/${A}/apps/preview`, { url: `${APP}/nothing.json` });
  t('a manifest URL that answers 404 is refused with the reason', r.s === 400 && /answered 404/.test(r.j.error?.message), r.s + ' ' + JSON.stringify(r.j));
  r = await api(U.token, 'POST', `/v1/workspaces/${A}/apps`, { url: `${APP}/freeflow-app.json`, grants: { members: true, accounts: [] } });
  t('a member cannot install', r.s === 403, r.s);
  r = await api(BLD, 'POST', `/v1/workspaces/${A}/apps`, { url: `${APP}/freeflow-app.json`, grants: { members: true, accounts: [] } });
  t('nor can an agent', r.s === 403, r.s);
  r = await api(O.token, 'POST', `/v1/workspaces/${A}/apps`, { url: `${APP}/freeflow-app.json`, grants: { members: true, accounts: [BA] } });
  const secret = r.j.secret;
  t('Olga installs it for every member and Builder, and gets the secret once', r.s === 201 && r.j.app === 'taskboard' && !!secret, r.s + ' ' + JSON.stringify(r.j).slice(0, 120));
  r = await api(O.token, 'POST', `/v1/workspaces/${A}/apps`, { url: `${APP}/freeflow-app.json`, grants: { members: true, accounts: [] } });
  t('a second install of the same name is refused', r.s === 409, r.s);
  await startApp({ FREEFLOW_APP_SECRET: secret, FREEFLOW_EVENTS_URL: `${B}/v1/apps/${A}/taskboard/events` });

  r = await api(U.token, 'GET', `/v1/workspaces/${A}/apps`);
  t('Uma sees it, usable, with no grants (she is no admin)', r.j.apps?.[0]?.usable === true && r.j.apps[0].grants === undefined, JSON.stringify(r.j).slice(0, 200));

  // --- Tools at the bridge's door (§3.3) ----------------------------------------------------------------------------------
  r = await api(BLD, 'GET', `/v1/tools?door=bridge&workspace=${A}`);
  const names = (r.j.tools ?? []).map((x) => x.name);
  t('the bridge lists Builder its app tools', names.includes('taskboard__list_tasks') && names.includes('taskboard__claim_task') && names.includes('send_message'), names.filter((n) => n.includes('__')).join(','));
  t("each says which app answers", /^From the installed app Tasks \(taskboard\)/.test(r.j.tools.find((x) => x.name === 'taskboard__claim_task')?.description ?? ''));
  r = await api(BLD, 'GET', '/v1/tools?door=bridge');
  t('without a workspace, none', !(r.j.tools ?? []).some((x) => x.name.includes('__')));

  // --- An agent works the board (§3.4) ------------------------------------------------------------------------------------
  const call = (tok, name, input) => api(tok, 'POST', `/v1/workspaces/${A}/tools/call`, { name, input });
  r = await call(O.token, 'taskboard__create_task', { title: 'Fix login', labels: ['backend'], status: 'Ready' }); const T1 = r.j.result?.task?.id;
  t('Olga adds a Ready card', r.s === 200 && r.j.ok && T1, JSON.stringify(r.j));
  r = await call(BLD, 'taskboard__list_tasks', { status: 'Ready', label: 'backend' });
  t('Builder finds it', r.j.ok && r.j.result.tasks.length === 1 && r.j.result.tasks[0].id === T1, JSON.stringify(r.j));
  r = await call(BLD, 'taskboard__claim_task', { id: T1 });
  t('and claims it: In progress, assigned to its account', r.j.ok && r.j.result.task.status === 'In progress' && r.j.result.task.assignee === BA, JSON.stringify(r.j));
  r = await call(U.token, 'taskboard__claim_task', { id: T1 });
  t("Uma's claim is refused by the app, its reason passed on", r.j.ok === false && /already assigned/.test(r.j.error), JSON.stringify(r.j));
  r = await call(BLD, 'taskboard__add_comment', { id: T1, text: 'On it.' });
  t('Builder comments', r.j.ok, JSON.stringify(r.j));
  r = await call(BLD, 'send_message', {});
  t('the call route runs app tools only', r.s === 400, r.s);

  // --- The board wakes Builder (§3.4, §5.1) -------------------------------------------------------------------------------
  r = await api(O.token, 'POST', `/v1/events/subscriptions?workspace=${A}`, { name: 'Builder works its cards', filter: { types: ['app.taskboard.task.assigned'], self: true }, delivery: 'wake', consumer: BA, action: { kind: 'wake', prompt: 'Task {{ref}} was assigned to you. Claim it and work on it.' } });
  const SUB = r.j.subscription?.id;
  t('Olga makes the wake subscription for Builder', r.s === 201 && !!SUB, r.s + ' ' + JSON.stringify(r.j).slice(0, 160));
  r = await call(O.token, 'taskboard__create_task', { title: 'Write the release notes', status: 'Ready' }); const T2 = r.j.result?.task?.id;
  r = await call(O.token, 'taskboard__update_task', { id: T2, assignee: UA });
  r = await call(O.token, 'taskboard__update_task', { id: T2, assignee: BA });
  t('Olga assigns a card to Uma, then to Builder', r.j.ok && r.j.result.task.assignee === BA, JSON.stringify(r.j));
  let jobs = [];
  for (let i = 0; i < 30 && !jobs.length; i++) { await sleep(300); jobs = (await api(O.token, 'GET', `/v1/events/jobs?workspace=${A}&subscription=${SUB}`)).j.jobs ?? []; }
  t('one job wakes Builder: the assignment to Uma did not', jobs.length === 1 && jobs[0].agent === BA && jobs[0].prompt.includes(`/taskboard/task/${T2}`), JSON.stringify(jobs).slice(0, 220));

  // --- Who sees the app's events (§5.1) -----------------------------------------------------------------------------------
  const appEvents = async (tok) => ((await api(tok, 'GET', `/v1/events?workspace=${A}&types=app.taskboard.*`)).j.events ?? []);
  let ev = await appEvents(U.token);
  t('Uma, holding taskboard:read, sees the events', ev.length >= 5 && ev.some((e) => e.type === 'app.taskboard.task.assigned' && e.about?.includes(BA)), ev.map((e) => e.type).join(','));
  r = await api(O.token, 'PUT', `/v1/workspaces/${A}/apps/taskboard/grants`, { members: false, accounts: [BA] });
  t('Olga gives it to Builder alone', r.s === 200, r.s);
  ev = await appEvents(U.token);
  t('now Uma sees none of its events', ev.length === 0, ev.length);
  t('and Builder still does', (await appEvents(BLD)).length >= 5);
  r = await call(U.token, 'taskboard__list_tasks', {});
  t("and Uma's calls are refused before the app is asked", r.j.ok === false && /does not hold/.test(r.j.error), JSON.stringify(r.j));

  // --- Signed events (§5.1) -----------------------------------------------------------------------------------------------
  r = await fetch(`${B}/v1/apps/${A}/taskboard/events`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'task.created' }) });
  t('an unsigned event is refused', r.status === 401, r.status);

  // --- The screen's door key (§6.2) ---------------------------------------------------------------------------------------
  r = await api(U.token, 'POST', `/v1/workspaces/${A}/apps/taskboard/screen`, {});
  t('Uma, without a scope now, gets no screen', r.s === 404, r.s);
  await api(O.token, 'PUT', `/v1/workspaces/${A}/apps/taskboard/grants`, { members: true, accounts: [BA] });
  r = await api(U.token, 'POST', `/v1/workspaces/${A}/apps/taskboard/screen`, {});
  const key = r.s === 200 ? new URL(r.j.url).searchParams.get('flow_token') : null;
  const payload = key ? JSON.parse(Buffer.from(key.split('.')[0], 'base64url').toString()) : null;
  t('with it again, a one-use version 2 door key for her account', payload?.v === 2 && payload.app === 'taskboard' && payload.accountId === UA, JSON.stringify(payload));

  // --- A personal agent's switch (§5.2) -----------------------------------------------------------------------------------
  // The panel over the app's screen offers only the agents that may use it (§5.2).
  const panelAgents = async (q) => ((await api(U.token, 'GET', `/api/agent/agents?workspace=${A}${q}`)).j.agents ?? []);
  const own = (await panelAgents('')).find((a) => a.self);
  t('Uma has an assistant to ask', !!own, JSON.stringify(await panelAgents('')));
  t('which the panel over Taskboard does not offer while the app is off for her agents', !(await panelAgents('&app=taskboard')).some((a) => a.self));
  r = await api(U.token, 'PUT', `/v1/workspaces/${A}/apps/taskboard/agents`, { on: true });
  t('Uma turns it on for her agents', r.s === 200, r.s);
  r = await api(U.token, 'GET', `/v1/workspaces/${A}/apps`);
  t('and the list says so', r.j.apps?.[0]?.agentsOn === true, JSON.stringify(r.j.apps?.[0]).slice(0, 120));
  t('and now the panel offers her assistant', (await panelAgents('&app=taskboard')).some((a) => a.self && a.id === own?.id));
  t('but no agent for an app that is not installed', (await panelAgents('&app=nothing')).length === 0);

  // --- Removal ------------------------------------------------------------------------------------------------------------
  r = await api(O.token, 'DELETE', `/v1/workspaces/${A}/apps/taskboard`);
  t('Olga removes it', r.s === 200, r.s);
  r = await api(BLD, 'GET', `/v1/tools?door=bridge&workspace=${A}`);
  t('its tools are gone', !(r.j.tools ?? []).some((x) => x.name.startsWith('taskboard__')));
  r = await call(BLD, 'taskboard__list_tasks', {});
  t('and a call says so', r.j.ok === false, JSON.stringify(r.j));
} catch (err) {
  fail++;
  console.log('FAIL the run stopped: ' + (err.stack ?? err));
} finally {
  child?.kill();
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
