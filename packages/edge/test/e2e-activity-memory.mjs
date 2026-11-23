// End-to-end check of agents remembering through events (task 32, decision_log 2026-11-22): the assistant, asked in its
// DM, looks back through the event log with search_events and finds a message the sponsor posted in another channel;
// and an automation's owner edits its name and prompt (PATCH /v1/events/subscriptions/:id), which nobody else can.
// The Meet half (meet.ended waking the Meeting notes automation) needs a live RealtimeKit session and is unit-tested.
// Against `pnpm dev:suite` (a real model key in ~/.config/flow/dev.vars), as its test account:
//   pnpm dev:suite --port=8797
//   B=http://localhost:8797 node packages/edge/test/e2e-activity-memory.mjs
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

// A message in a channel the assistant is not asked in: the thing to remember.
const channels = (await api(tok, 'GET', `/v1/workspaces/${W}/channels`)).j.channels ?? (await api(tok, 'GET', `/v1/workspaces/${W}/channels`)).j;
const general = (Array.isArray(channels) ? channels : []).find((c) => c.name === 'general');
t('it has #general', !!general?.id);
const word = `pineapple-${tag}`;
await api(tok, 'POST', `/v1/channels/${general.id}/messages`, { clientMsgId: crypto.randomUUID(), body: `The launch code word is ${word}.` });

// The event log has it, as the sponsor reads it.
const log = await api(tok, 'GET', `/v1/events?workspace=${W}&before=0&limit=20&text=${encodeURIComponent(word)}`);
t('the message is in the event log', (log.j.events ?? []).some((e) => e.type === 'chat.message.created'), JSON.stringify(log.j).slice(0, 160));

// In its DM, the assistant finds it with search_events.
const DM = (await api(tok, 'POST', `/v1/workspaces/${W}/dms`, { userIds: [asst.userId] })).j.id;
await api(tok, 'POST', `/v1/channels/${DM}/messages`, {
  clientMsgId: crypto.randomUUID(),
  body: `In another channel I mentioned a launch code word starting with "pineapple-". Use search_events (text "pineapple-${tag}") to find it, and reply with the full word only.`,
});
const msgs = async () => ((await api(tok, 'GET', `/v1/channels/${DM}/messages?limit=20`)).j.messages ?? []);
const answered = await until(msgs, (l) => l.some((m) => m.userId === asst.userId && m.body.includes(word)), 120000);
const reply = answered.find((m) => m.userId === asst.userId && m.body.includes(word));
t('the assistant finds the word with search_events', !!reply, answered.filter((m) => m.userId === asst.userId).map((m) => m.body).slice(0, 2).join(' | '));

// An automation's owner edits it; the edit keeps what it listens to.
const made = await api(tok, 'POST', `/v1/events/subscriptions?workspace=${W}`, {
  name: `Echo ${tag}`, delivery: 'wake', consumer: asst.accountId, filter: { types: ['chat.reaction.added'] }, action: { kind: 'wake', prompt: 'Say hi.' },
});
t('a wake automation is made', made.s === 201, `${made.s} ${JSON.stringify(made.j).slice(0, 160)}`);
const id = made.j.subscription?.id;
const edited = await api(tok, 'PATCH', `/v1/events/subscriptions/${id}?workspace=${W}`, { name: `Echo edited ${tag}`, prompt: 'Say hello.' });
t('its owner edits the name and prompt', edited.s === 200 && edited.j.subscription?.name === `Echo edited ${tag}` && edited.j.subscription?.action?.prompt === 'Say hello.', `${edited.s} ${JSON.stringify(edited.j).slice(0, 200)}`);
t('what it listens to stays', JSON.stringify(edited.j.subscription?.filter) === JSON.stringify({ types: ['chat.reaction.added'] }));
const bad = await api(tok, 'PATCH', `/v1/events/subscriptions/${id}?workspace=${W}`, { filter: {} });
t('a change to its filter is refused', bad.s === 400, bad.s);
await api(tok, 'DELETE', `/v1/events/subscriptions/${id}?workspace=${W}`);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
