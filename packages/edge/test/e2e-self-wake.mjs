// End-to-end check of an agent waking itself (docs/specs/agent-self-wake.md): in a thread of their DM, the sponsor asks
// their assistant to check back in a minute; it calls schedule_wake, the wake shows among the sponsor's automations as a
// one-time wake, and about a minute later the assistant answers in the same thread. A person cannot set a wake for
// themself. Against `pnpm dev:suite` (a real model key in ~/.config/flow/dev.vars), as its test account:
//   pnpm dev:suite --port=8797
//   B=http://localhost:8797 node packages/edge/test/e2e-self-wake.mjs
// DEV_USER_PASSWORD overrides the dev account's default password (scripts/dev-suite.mjs).
import crypto from 'node:crypto';
const B = process.env.B ?? 'http://localhost:8797';
let pass = 0, fail = 0;
const t = (n, ok, d = '') => { ok ? pass++ : fail++; console.log((ok ? 'ok  ' : 'FAIL') + ' ' + n + (d ? ': ' + String(d).slice(0, 240) : '')); };
const api = async (tok, m, p, b) => {
  const r = await fetch(B + p, { method: m, headers: { ...(tok ? { authorization: 'Bearer ' + tok } : {}), ...(b !== undefined ? { 'content-type': 'application/json' } : {}) }, body: b === undefined ? undefined : JSON.stringify(b) });
  const x = await r.text(); let j; try { j = JSON.parse(x); } catch { j = x; } return { s: r.status, j };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (get, ok, ms) => { const t0 = Date.now(); for (;;) { const v = await get(); if (ok(v) || Date.now() - t0 > ms) return v; await sleep(2000); } };
const tag = Date.now().toString(36);

const login = await api(null, 'POST', '/v1/auth/login', { email: 'dev@flow.test', password: process.env.DEV_USER_PASSWORD || 'flow-dev-password' });
t('the dev account signs in', login.s === 200, login.s);
const tok = login.j.token;
const W = ((await api(tok, 'GET', '/v1/me/workspaces')).j.workspaces ?? []).find((w) => w.slug === 'dev')?.id;
t('it has the Dev organization', !!W);
const asst = await until(async () => ((await api(tok, 'GET', `/v1/workspaces/${W}/members`)).j.members ?? []).find((m) => m.kind === 'personal_agent'), (m) => !!m, 20000);
t('it has an assistant', !!asst?.userId);
const DM = (await api(tok, 'POST', `/v1/workspaces/${W}/dms`, { userIds: [asst.userId] })).j.id;

// A person cannot set a wake for themself.
let r = await api(tok, 'POST', `/v1/events/wakes?workspace=${W}`, { prompt: 'x', inMinutes: 5, channelId: DM });
t('a person is refused', r.s === 403 && r.j?.error?.code === 'not_an_agent', `${r.s} ${JSON.stringify(r.j).slice(0, 120)}`);

// A thread in the DM, and the ask inside it.
const root = (await api(tok, 'POST', `/v1/channels/${DM}/messages`, { clientMsgId: crypto.randomUUID(), body: `Deploy check ${tag}` })).j;
const word = `wake-ok-${tag}`;
await api(tok, 'POST', `/v1/channels/${DM}/messages`, {
  clientMsgId: crypto.randomUUID(), threadRootId: root.id,
  body: `Use schedule_wake to wake yourself in 1 minute. When you wake, reply with exactly "${word}" and nothing else. For now, just confirm you set it.`,
});
const thread = async () => { const x = (await api(tok, 'GET', `/v1/messages/${root.id}/thread?limit=50`)).j; return x.messages ?? []; };
const fromAsst = (list) => list.filter((m) => m.userId === asst.userId);
const first = await until(thread, (l) => fromAsst(l).length >= 1, 90000);
t('it answers in the thread that it set the wake', fromAsst(first).length >= 1, fromAsst(first)[0]?.body);

// The wake waits among the sponsor's automations, as a one-time one in this thread.
const subs = (await api(tok, 'GET', `/v1/events/subscriptions?workspace=${W}`)).j.subscriptions ?? [];
const wake = subs.find((s) => s.schedule?.every === 'once' && s.action?.threadRootId === root.id);
t('the wake is listed for the sponsor, once, in the thread', !!wake, JSON.stringify(subs.map((s) => [s.name, s.schedule?.every, s.action?.threadRootId])).slice(0, 200));
t('it fires a minute or more ahead', wake && Date.parse(wake.schedule.nextAt) - Date.now() > 0, wake?.schedule?.nextAt);

// About a minute later the assistant answers in the same thread, and the wake is spent.
const after = await until(thread, (l) => fromAsst(l).some((m) => m.body.includes(word)), 180000);
const woke = fromAsst(after).find((m) => m.body.includes(word));
t('woken, it answers in the same thread', !!woke, fromAsst(after).map((m) => m.body).join(' | '));
const left = (await api(tok, 'GET', `/v1/events/subscriptions?workspace=${W}`)).j.subscriptions ?? [];
t('the wake is spent, no longer listed', wake && !left.some((s) => s.id === wake.id));
if (wake) {
  const jobs = (await api(tok, 'GET', `/v1/events/jobs?subscription=${wake.id}&workspace=${W}`)).j.jobs ?? [];
  t('its job ran to done, in the thread', jobs[0]?.state === 'done' && jobs[0]?.threadRootId === root.id, JSON.stringify(jobs[0] ?? null).slice(0, 200));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
