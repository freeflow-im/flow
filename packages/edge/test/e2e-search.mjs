// End-to-end check of Docs search (docs/specs/search.md §5) through the Worker and an organization's Docs object, against a
// local suite: `pnpm dev:suite --port=<port> > /tmp/suite.log 2>&1`, then `B=http://localhost:<port> node test/e2e-search.mjs /tmp/suite.log`.
// It reads sign-up links from the Worker's log, because local mail goes there. It also times searches over 200 documents.
import fs from 'node:fs';
const log = process.argv[2]; const B = process.env.B ?? 'http://localhost:8787';
let pass = 0, fail = 0; const t = (n, ok, d = '') => { ok ? pass++ : fail++; console.log((ok ? 'ok  ' : 'FAIL') + ' ' + n + (d ? ': ' + String(d).slice(0, 200) : '')); };
const api = async (tok, m, p, b) => { const r = await fetch(B + p, { method: m, headers: { ...(tok ? { authorization: 'Bearer ' + tok } : {}), ...(b !== undefined ? { 'content-type': 'application/json' } : {}) }, body: b === undefined ? undefined : JSON.stringify(b) }); const x = await r.text(); let j; try { j = JSON.parse(x) } catch { j = x } return { s: r.status, j }; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function signup(email, name) { await api(null, 'POST', '/v1/auth/register', { email }); await sleep(500); const m = [...fs.readFileSync(log, 'utf8').matchAll(new RegExp('to=' + email + '.*?signup=([A-Za-z0-9_-]+)', 'g'))].at(-1); return (await api(null, 'POST', '/v1/auth/register/complete', { token: m[1], displayName: name, password: 'correct-horse-battery' })).j; }
const tag = Date.now().toString(36);
const A = await signup(`dana-${tag}@example.com`, 'Dana'), E = await signup(`eli-${tag}@example.com`, 'Eli');
let r = await api(A.token, 'POST', '/v1/workspaces', { name: 'Search Org', slug: `search-${tag}` }); const W = r.j.id;
r = await api(A.token, 'POST', `/v1/workspaces/${W}/invites`, { email: `eli-${tag}@example.com` }); r = await api(E.token, 'POST', '/v1/invites/accept', { token: (r.j.inviteUrl ?? '').split('/').pop() }); t('Eli joins the organization', r.s < 300, r.s);

const shared = (await api(A.token, 'POST', `/api/markdown?workspace=${W}&shared=1`, { title: 'Pricing memo', text: 'We will raise renewal pricing in March for enterprise customers.' })).j.doc;
const mine = (await api(A.token, 'POST', `/api/markdown?workspace=${W}`, { title: 'Salary notes', text: 'Renewal bonus is confidential.' })).j.doc;
t('two Markdown documents made', shared?.id && mine?.id);
const search = async (tok, q, extra = '') => { const t0 = performance.now(); const res = await api(tok, 'GET', `/api/search?workspace=${W}&q=${encodeURIComponent(q)}${extra}`); return { ...res, ms: Math.round(performance.now() - t0) }; };

r = await search(A.token, 'renewal');
t('Dana finds both by a word inside them', r.s === 200 && r.j.hits?.length === 2, `${r.s} ${r.ms}ms ${JSON.stringify(r.j).slice(0, 160)}`);
t('the snippet marks the word', JSON.stringify(r.j.hits).includes('\\u0002renewal\\u0003') || r.j.hits?.some((h) => h.snippet.includes('\u0002')), r.j.hits?.[0]?.snippet);
r = await search(E.token, 'renewal');
t('Eli sees only the organization file, not Dana’s private one', r.j.hits?.length === 1 && r.j.hits[0].title === 'Pricing memo', JSON.stringify(r.j.hits?.map((h) => h.title)));
r = await search(A.token, 'prices');
t('stemming: "prices" finds "pricing"', r.j.hits?.[0]?.id === shared.id, JSON.stringify(r.j.hits?.map((h) => h.title)));
r = await search(A.token, 'enterp', '&prefix=1');
t('search as you type', r.j.hits?.[0]?.id === shared.id, JSON.stringify(r.j.hits?.map((h) => h.title)));
r = await search(A.token, 'renewal is:shared');
t('is:shared', r.j.hits?.length === 1 && r.j.hits[0].id === shared.id);
r = await search(A.token, 'renewal type:doc');
t('type:doc leaves Markdown out', r.j.hits?.length === 0);

await api(A.token, 'PUT', `/api/markdown/${shared.id}?workspace=${W}`, { doc: { version: 1, text: 'Pricing stays flat; we add a loyalty discount.' } });
r = await search(A.token, 'loyalty');
t('a save replaces the words', r.j.hits?.[0]?.id === shared.id && (await search(A.token, 'enterprise')).j.hits?.length === 0);
await api(A.token, 'PATCH', `/api/markdown/${mine.id}?workspace=${W}`, { title: 'Compensation draft' });
r = await search(A.token, 'compensation');
t('a rename changes the title searched', r.j.hits?.[0]?.title === 'Compensation draft', JSON.stringify(r.j).slice(0, 120));
await api(A.token, 'DELETE', `/api/markdown/${mine.id}?workspace=${W}`);
r = await search(A.token, 'bonus');
t('a delete removes it', r.j.hits?.length === 0);

// Many documents: how fast is it in the Worker?
const words = ['budget', 'roadmap', 'hiring', 'launch', 'customer', 'invoice', 'design', 'travel', 'contract', 'vendor'];
const t0 = performance.now();
await Promise.all(Array.from({ length: 200 }, (_, i) => api(A.token, 'POST', `/api/markdown?workspace=${W}&shared=1`, { title: `Note ${i} ${words[i % 10]}`, text: Array.from({ length: 400 }, (_, j) => words[(i * 7 + j * 3) % 10]).join(' ') + (i === 137 ? ' ptarmigan' : '') })));
t('200 more documents made', true, `${Math.round(performance.now() - t0)}ms`);
const times = [];
for (const q of ['ptarmigan', 'budget', 'roadmap launch', 'cont', 'vendor -travel']) { const x = await search(A.token, q, q === 'cont' ? '&prefix=1' : ''); times.push(`${q}: ${x.j.hits?.length} hits ${x.ms}ms`); }
r = await search(A.token, 'ptarmigan');
t('a rare word among 200 documents', r.j.hits?.length === 1 && r.j.hits[0].title === 'Note 137 travel', times.join(' | '));
r = await search(null, 'budget');
t('no session: refused', r.s === 401, r.s);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
