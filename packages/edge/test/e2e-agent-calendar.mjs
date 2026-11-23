// End-to-end check of a personal agent's own calendar (agents.md §1.1, taskboard task 31): the sponsor invites their
// assistant to a meeting by its address, and in their DM the assistant finds it on its own calendar, not the sponsor's;
// asked, it puts an event on its own calendar, which the sponsor's calendar does not get. Against `pnpm dev:suite` (a real
// model key in ~/.config/flow/dev.vars), as its test account:
//   pnpm dev:suite --port=8797
//   B=http://localhost:8797 node packages/edge/test/e2e-agent-calendar.mjs
// DEV_USER_PASSWORD overrides the dev account's default password (scripts/dev-suite.mjs).
import crypto from 'node:crypto';
const B = process.env.B ?? 'http://localhost:8797';
let pass = 0, fail = 0;
const t = (n, ok, d = '') => { ok ? pass++ : fail++; console.log((ok ? 'ok  ' : 'FAIL') + ' ' + n + (d ? ': ' + String(d).slice(0, 400) : '')); };
const api = async (tok, m, p, b) => {
  const r = await fetch(B + p, { method: m, headers: { ...(tok ? { authorization: 'Bearer ' + tok } : {}), ...(b !== undefined ? { 'content-type': 'application/json' } : {}) }, body: b === undefined ? undefined : JSON.stringify(b) });
  const x = await r.text(); let j; try { j = JSON.parse(x); } catch { j = x; } return { s: r.status, j };
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (get, ok, ms) => { const t0 = Date.now(); for (;;) { const v = await get(); if (ok(v) || Date.now() - t0 > ms) return v; await sleep(2000); } };
const tag = Date.now().toString(36);

const login = await api(null, 'POST', '/v1/auth/login', { email: 'dev@flow.test', password: process.env.DEV_USER_PASSWORD || 'flow-dev-password' });
t('the dev account signs in', login.s === 200, login.s);
const tok = login.j.token, me = login.j.user?.id;
const W = ((await api(tok, 'GET', '/v1/me/workspaces')).j.workspaces ?? []).find((w) => w.slug === 'dev')?.id;
t('it has the Dev organization', !!W);

// The assistant, named so it has an address, a mailbox and a calendar.
const asstAccount = async () => ((await api(tok, 'GET', `/v1/workspaces/${W}/accounts`)).j.accounts ?? []).find((a) => a.kind === 'personal_agent' && a.sponsorId === me);
let ada = await until(asstAccount, (a) => !!a, 20000);
if (!ada?.address) {
  const r = await api(tok, 'PUT', `/api/agent/definition?workspace=${W}`, { name: 'Ada' });
  t('the assistant is named Ada', r.s === 200, r.s);
  ada = await until(asstAccount, (a) => !!a?.address, 30000);
}
t('the assistant has its own address', !!ada?.address, JSON.stringify(ada).slice(0, 200));
const asst = ((await api(tok, 'GET', `/v1/workspaces/${W}/members`)).j.members ?? []).find((m) => m.kind === 'personal_agent' && m.address === ada.address);
t('and is a member to DM', !!asst?.userId);
const DM = (await api(tok, 'POST', `/v1/workspaces/${W}/dms`, { userIds: [asst.userId] })).j.id;

// The sponsor invites the assistant to a meeting tomorrow by its address: it lands on the assistant's own calendar.
const day = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
const NCAL = ((await api(tok, 'GET', '/v1/calendar/calendars')).j.calendars ?? []).find((c) => /^n\./.test(c.id));
// A sponsor with no hosted address (the dev account on the platform subdomain) has no FreeFlow calendar to invite from:
// then the invitation is skipped and only the assistant's own writes are checked.
const title = `Budget review ${tag}`;
let r;
if (NCAL) {
  r = await api(tok, 'POST', '/v1/calendar/events', { calendarId: NCAL.id, summary: title, start: `${day}T17:00:00Z`, end: `${day}T17:30:00Z`, timezone: 'UTC', attendees: [{ email: ada.address, name: 'Ada' }] });
  t('the sponsor invites the assistant to a meeting', r.s === 201, r.s + ' ' + JSON.stringify(r.j).slice(0, 200));
} else console.log('skip the sponsor has no FreeFlow calendar: no invitation');

const ask = async (body, check, ms = 150000) => {
  const sent = (await api(tok, 'POST', `/v1/channels/${DM}/messages`, { clientMsgId: crypto.randomUUID(), body })).j;
  const after = (l) => l.filter((m) => m.userId === asst.userId && Date.parse(m.createdAt) > Date.parse(sent.createdAt));
  const list = await until(async () => (await api(tok, 'GET', `/v1/channels/${DM}/messages?limit=30`)).j.messages ?? [], (l) => after(l).some((m) => check(m.body)), ms);
  return after(list).map((m) => m.body).join(' | ');
};

// Asked about its own calendar, it reads it (before task 31 it said it had no calendar).
let answer = await ask(`Do you have your own calendar? What is on YOUR OWN calendar on ${day} (UTC)? Not mine, yours. Give each title exactly, or say it is empty.`, (b) => b.length > 0);
if (NCAL) t('it finds the meeting on its own calendar', answer.includes(tag), answer);
t('it does not say it has no calendar', !/no (own )?calendar|(don.t|do not) have (a|an|my|its)( own| personal)? calendar/i.test(answer), answer);

// Asked, it puts an event on its own calendar; the sponsor's calendar does not get it.
const prep = `Prep notes ${tag}`;
answer = await ask(`Put an event titled exactly "${prep}" on YOUR OWN calendar on ${day} from 16:00 to 16:30 UTC, no guests. Then say done.`, (b) => /done/i.test(b) || b.includes(prep));
t('it says it added the event', /done/i.test(answer) || answer.includes(prep), answer);
r = await api(tok, 'GET', `/v1/calendar/events?from=${day}T00:00:00Z&to=${day}T23:59:59Z`);
t('the sponsor\'s calendars do not get it', r.s === 200 && !(r.j.events ?? []).some((e) => e.summary === prep), JSON.stringify((r.j.events ?? []).map((e) => e.summary)));
answer = await ask(`List the titles on your own calendar on ${day} (UTC), exactly.`, (b) => b.includes(prep));
t('reading its own calendar again, the event is there', answer.includes(prep) && (!NCAL || answer.includes(title)), answer);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
