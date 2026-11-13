// End-to-end check of message search (docs/specs/search.md, Chat) through the Worker and an organization's Org object,
// against a local suite: `pnpm dev:suite --port=<port> > /tmp/suite.log 2>&1`, then
// `B=http://localhost:<port> node test/e2e-chat-search.mjs /tmp/suite.log`. It reads sign-up links from the Worker's log,
// because local mail goes there. It also times searches over 500 messages.
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
const log = process.argv[2]; const B = process.env.B ?? 'http://localhost:8787';
let pass = 0, fail = 0; const t = (n, ok, d = '') => { ok ? pass++ : fail++; console.log((ok ? 'ok  ' : 'FAIL') + ' ' + n + (d ? ': ' + String(d).slice(0, 220) : '')); };
const api = async (tok, m, p, b) => { const r = await fetch(B + p, { method: m, headers: { ...(tok ? { authorization: 'Bearer ' + tok } : {}), ...(b !== undefined ? { 'content-type': 'application/json' } : {}) }, body: b === undefined ? undefined : JSON.stringify(b) }); const x = await r.text(); let j; try { j = JSON.parse(x) } catch { j = x } return { s: r.status, j }; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function signup(email, name) { await api(null, 'POST', '/v1/auth/register', { email }); await sleep(500); const m = [...fs.readFileSync(log, 'utf8').matchAll(new RegExp('to=' + email + '.*?signup=([A-Za-z0-9_-]+)', 'g'))].at(-1); return (await api(null, 'POST', '/v1/auth/register/complete', { token: m[1], displayName: name, password: 'correct-horse-battery' })).j; }
const tag = Date.now().toString(36);
const D = await signup(`dana-${tag}@example.com`, 'Dana'), E = await signup(`eli-${tag}@example.com`, 'Eli'), O = await signup(`olga-${tag}@example.com`, 'Olga');
let r = await api(D.token, 'POST', '/v1/workspaces', { name: 'Search Org', slug: `chat-${tag}` }); const W = r.j.id;
r = await api(D.token, 'POST', `/v1/workspaces/${W}/invites`, { email: `eli-${tag}@example.com` }); r = await api(E.token, 'POST', '/v1/invites/accept', { token: (r.j.inviteUrl ?? '').split('/').pop() }); t('Eli joins the organization', r.s < 300, r.s);

const launch = (await api(D.token, 'POST', `/v1/workspaces/${W}/channels`, { name: `launch-${tag}` })).j.id;
const salaries = (await api(D.token, 'POST', `/v1/workspaces/${W}/channels`, { name: `salaries-${tag}`, isPrivate: true })).j.id;
const dm = (await api(D.token, 'POST', `/v1/workspaces/${W}/dms`, { userIds: [E.user.id] })).j.id;
t('channels and a DM made', launch && salaries && dm, JSON.stringify({ launch, salaries, dm }));
const send = async (tok, ch, body, extra = {}) => (await api(tok, 'POST', `/v1/channels/${ch}/messages`, { clientMsgId: randomUUID(), body, ...extra })).j;
const pub = await send(D.token, launch, `The launch moves to Thursday, <@${E.user.id}> please confirm https://example.com/plan`);
await send(D.token, salaries, 'Thursday is also payroll day.');
await send(D.token, dm, 'Thursday lunch?');
const search = async (tok, q, extra = '') => { const t0 = performance.now(); const res = await api(tok, 'GET', `/v1/workspaces/${W}/search?q=${encodeURIComponent(q)}${extra}`); return { ...res, ms: Math.round(performance.now() - t0) }; };

r = await search(D.token, 'thursday');
t('Dana finds all three', r.s === 200 && r.j.hits?.length === 3, `${r.s} ${r.ms}ms ${JSON.stringify(r.j).slice(0, 160)}`);
r = await search(E.token, 'thursday');
const titles = (r.j.hits ?? []).map((h) => h.title).sort();
t('Eli finds the public channel they never joined and their DM, not the private channel', JSON.stringify(titles) === JSON.stringify([`#launch-${tag}`, 'Direct message'].sort()), JSON.stringify(titles));
t('the snippet marks the word', r.j.hits?.some((h) => h.snippet.includes('\u0002Thursday\u0003')), r.j.hits?.[0]?.snippet);
r = await search(O.token, 'thursday');
t('someone outside the organization is refused', r.s >= 400 && r.s < 500, r.s);
r = await search(D.token, 'eli confirm');
t('a mention is found by the name it stands for', r.j.hits?.[0]?.id === pub.id, JSON.stringify(r.j.hits?.map((h) => h.snippet)));
r = await search(D.token, 'thursday has:link');
t('has:link', r.j.hits?.length === 1 && r.j.hits[0].id === pub.id);
r = await search(D.token, `thursday in:#salaries-${tag}`);
t('in:#channel', r.j.hits?.length === 1 && r.j.hits[0].channelId === salaries);
r = await search(E.token, `in:#salaries-${tag}`);
t('in: a private channel Eli is not in finds nothing', r.j.hits?.length === 0, JSON.stringify(r.j));
r = await search(D.token, 'thursday from:me', '&sort=recent');
t('from:me, newest first', r.j.hits?.length === 3 && r.j.hits[0].channelId === dm, JSON.stringify(r.j.hits?.map((h) => h.title)));
r = await search(D.token, 'payrol', '&prefix=1');
t('search as you type', r.j.hits?.length === 1);

await api(D.token, 'PATCH', `/v1/messages/${pub.id}`, { body: 'The launch moves to Friday.' });
t('an edit replaces the words', (await search(D.token, 'friday')).j.hits?.[0]?.id === pub.id && (await search(D.token, 'confirm')).j.hits?.length === 0);
await api(D.token, 'DELETE', `/v1/messages/${pub.id}`);
t('a delete removes it', (await search(D.token, 'friday')).j.hits?.length === 0);
r = await search(D.token, ' ');
t('an empty query is refused', r.s === 400, r.s);

// Many messages: how fast is it in the Worker?
const words = ['budget', 'roadmap', 'hiring', 'launch', 'customer', 'invoice', 'design', 'travel', 'contract', 'vendor'];
const t0 = performance.now();
for (let i = 0; i < 500; i += 25) await Promise.all(Array.from({ length: 25 }, (_, k) => send(D.token, launch, Array.from({ length: 30 }, (_, j) => words[((i + k) * 7 + j * 3) % 10]).join(' ') + (i + k === 437 ? ' ptarmigan' : ''))));
t('500 more messages sent', true, `${Math.round(performance.now() - t0)}ms`);
const times = [];
for (const q of ['ptarmigan', 'budget', 'roadmap launch', 'cont', 'vendor -travel']) { const x = await search(D.token, q, q === 'cont' ? '&prefix=1' : ''); times.push(`${q}: ${x.j.hits?.length} hits ${x.ms}ms`); }
r = await search(D.token, 'ptarmigan');
t('a rare word among 500 messages', r.j.hits?.length === 1, times.join(' | '));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
