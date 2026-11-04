// End-to-end check of the assistant in FreeFlow Mail (packages/mail AssistantPanel, docs/specs/web-mcp.md "The assistant in
// Mail") against GreenMail and a local `wrangler dev` started as test/e2e-mail-mcp.mjs says, with the clients assembled
// into public/ (scripts/assemble.mjs) and ASSET_HOSTS including localhost. In a real Chrome (Playwright): the Assistant
// button opens the panel on a message, a turn asks for a summary and a reply draft, and Open draft opens it in Compose.
// Nothing is sent. With LIVE=1 the turn runs on the Worker's model (ANTHROPIC_API_KEY in .dev.vars); without it the
// browser's /api/agent/turn is answered with a scripted stream (the draft itself made through the Mail API, as
// create_mail_draft makes it), which checks the panel but not the model.
//   B=http://localhost:<port> PW=<path to playwright> SHOTS=<dir> [LIVE=1] node test/e2e-mail-assistant.mjs <wrangler log>
import fs from 'node:fs';
import { createRequire } from 'node:module';
import nodemailer from 'nodemailer';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW ?? 'playwright');
const log = process.argv[2];
const B = process.env.B ?? 'http://localhost:18811';
const SHOTS = process.env.SHOTS ?? '.';
let pass = 0, fail = 0;
const t = (n, ok, d = '') => { ok ? pass++ : fail++; console.log((ok ? 'ok  ' : 'FAIL') + ' ' + n + (d ? ': ' + String(d).slice(0, 300) : '')); };
const api = async (tok, m, p, b) => { const r = await fetch(B + p, { method: m, headers: { ...(tok ? { authorization: 'Bearer ' + tok } : {}), ...(b !== undefined ? { 'content-type': 'application/json' } : {}) }, body: b === undefined ? undefined : JSON.stringify(b) }); const x = await r.text(); let j; try { j = JSON.parse(x); } catch { j = x; } return { s: r.status, j }; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function signup(email, name) { await api(null, 'POST', '/v1/auth/register', { email }); await sleep(400); const m = [...fs.readFileSync(log, 'utf8').matchAll(new RegExp('to=' + email + '.*?signup=([A-Za-z0-9_-]+)', 'g'))].at(-1); return (await api(null, 'POST', '/v1/auth/register/complete', { token: m[1], displayName: name, password: 'correct-horse-battery' })).j; }

const tag = Date.now().toString(36);
const MAIL_USER = `assist-${tag}@test.local`;
const A = await signup(`ann-${tag}@example.com`, 'Ann');
let r = await api(A.token, 'POST', '/v1/workspaces', { name: `Acme ${tag}`, slug: `acme-${tag}` });
const ORG = r.j.id;
t('Ann signs up, with an organization', A.token && ORG);
const server = (port) => ({ host: '127.0.0.1', port, security: 'none' });
r = await api(A.token, 'POST', '/v1/mail/accounts', { email: MAIL_USER, displayName: 'Ann', password: 'x', imap: server(3143), smtp: server(3025) });
const ACC = r.j.account?.id;
t('connects a GreenMail account', r.s === 201 && ACC, r.s + ' ' + JSON.stringify(r.j));
const smtp = nodemailer.createTransport({ host: '127.0.0.1', port: 3025, secure: false, ignoreTLS: true });
await smtp.sendMail({ from: 'Bo Brown <bo@test.local>', to: MAIL_USER, subject: 'Lunch on Thursday?', text: 'Hi Ann,\n\nAre you free for lunch on Thursday at 12:30? The new place on Main Street.\n\nBo' });
await smtp.sendMail({
  from: 'Cara Diaz <cara@test.local>',
  to: MAIL_USER,
  subject: 'Q3 numbers for review',
  text: 'Hi Ann,\n\nAttached are the Q3 numbers. Revenue is up 12% on Q2, mostly from the new enterprise plan; costs are flat. Could you review them and send me your comments by Friday?\n\nThanks,\nCara',
  attachments: [{ filename: 'q3.csv', content: 'month,revenue,costs\nJul,120,80\nAug,130,82\nSep,140,81\n' }],
});
let list;
for (let i = 0; i < 20; i++) { list = await api(A.token, 'GET', `/v1/mail/accounts/${ACC}/messages?folder=INBOX`); if (list.j.messages?.length >= 2) break; await sleep(500); }
const q3 = list.j.messages.find((m) => m.subject.startsWith('Q3'));
t('the mail arrives', !!q3, JSON.stringify(list.j).slice(0, 200));

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await ctx.addCookies([{ name: 'sid', value: A.token, url: B }]);
await ctx.addInitScript((org) => localStorage.setItem('flow.activeWorkspace', org), ORG);
const page = await ctx.newPage();
const turns = [];
page.on('request', (req) => { if (req.url().includes('/api/agent/turn')) turns.push({ url: req.url(), body: req.postDataJSON() }); });
await page.goto(`${B}/mail/?account=${ACC}&folder=INBOX&uid=${q3.uid}`);
await page.locator('text=Q3 numbers for review >> visible=true').first().waitFor();
await page.getByTestId('suite-assistant').click();
await page.getByTestId('mail-assistant').waitFor();
t('the Assistant button opens the panel, pressed', (await page.getByTestId('suite-assistant').getAttribute('aria-pressed')) === 'true');
t('the panel is remembered', (await page.evaluate(() => localStorage.getItem('mail.assistant'))) === 'open');
await page.screenshot({ path: `${SHOTS}/mail-assistant-open.png` });

const LIVE = !!process.env.LIVE;
if (!LIVE) {
  // The model's part, scripted: it reads the message and drafts the reply, which the Mail API saves as create_mail_draft does.
  let n = 0;
  await page.route('**/api/agent/turn**', async (route) => {
    turns.push({ url: route.request().url(), body: route.request().postDataJSON() });
    n++;
    const saved = (await api(A.token, 'POST', `/v1/mail/accounts/${ACC}/drafts`, { to: [{ name: 'Cara Diaz', address: 'cara@test.local' }], subject: 'Re: Q3 numbers for review', html: '<p>Hi Cara,</p><p>Thanks for the Q3 numbers. I will send you my comments by Friday.</p><p>Ann</p>', text: 'Hi Cara,\n\nThanks for the Q3 numbers. I will send you my comments by Friday.\n\nAnn' })).j;
    const draftId = `${ACC}:${saved.folder}:${saved.uid}`;
    const ev = [
      { type: 'tool_start', id: 'r1', name: 'read_mail', input: { ids: [`${ACC}:INBOX:${q3.uid}`] } },
      { type: 'tool_end', id: 'r1', ok: true },
      { type: 'text', text: '**Summary.** Cara sent the Q3 numbers (q3.csv): revenue is up 12% on Q2, mostly from the new enterprise plan, and costs are flat. She asks for your comments by **Friday**.\n\n' },
      { type: 'tool_start', id: 'd1', name: 'create_mail_draft', input: { reply_to_id: `${ACC}:INBOX:${q3.uid}`, body: 'Hi Cara, ...' } },
      { type: 'tool_end', id: 'd1', ok: true, result: JSON.stringify({ saved: true, account: MAIL_USER, folder: saved.folder, draft_id: draftId, link: `${B}/mail/?account=${ACC}&folder=${saved.folder}&uid=${saved.uid}` }) },
      { type: 'text', text: `I drafted a reply saying you will send your comments by Friday. It is in [Drafts](${B}/mail/?account=${ACC}&folder=${encodeURIComponent(saved.folder)}&uid=${saved.uid}), unsent: open it to check and send it.` },
      { type: 'done' },
    ];
    await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: ev.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') });
  });
}
await page.getByLabel('Message the assistant').fill('Summarize this email, then draft a reply saying I will send my comments by Friday.');
await page.keyboard.press('Enter');
await page.getByRole('button', { name: 'Send' }).waitFor({ timeout: 180_000 });
const first = turns[0];
t('the turn goes to the selected organization’s Docs, in the Mail chat', first?.url.endsWith(`/api/agent/turn?workspace=${ORG}`) && first.body.scope === 'mail' && first.body.workspace === ORG, first?.url);
t('with the open message as its context', first?.body.context?.page === 'mail' && first.body.context.message?.id === `${ACC}:INBOX:${q3.uid}` && first.body.context.message.subject === 'Q3 numbers for review', JSON.stringify(first?.body.context));
const panelText = await page.getByTestId('mail-assistant').innerText();
const err = await page.getByTestId('mail-assistant').locator('.text-danger').allInnerTexts();
t('the assistant answers, without an error', !err.length || !err.join('').trim(), err.join(' | ') || panelText.slice(-300));
t('it drafts the reply', /Drafted a reply|Drafted an email/.test(panelText), panelText.slice(0, 600));
await page.screenshot({ path: `${SHOTS}/mail-assistant-reply.png` });
const drafts = await api(A.token, 'GET', `/v1/mail/accounts/${ACC}/messages?folder=Drafts`);
t('the draft is in Drafts, and nothing was sent', drafts.j.messages?.length >= 1 && !(await api(A.token, 'GET', `/v1/mail/accounts/${ACC}/messages?folder=Sent`)).j.messages?.length, JSON.stringify(drafts.j).slice(0, 200));

const open = page.getByRole('button', { name: 'Open draft' });
if (await open.count()) {
  await open.first().click();
  await page.getByRole('dialog').waitFor({ timeout: 15_000 });
  const dlg = await page.getByRole('dialog').innerText();
  t('Open draft opens it in Compose', /Draft/.test(dlg) && /Friday/i.test(dlg), dlg.slice(0, 200));
  await page.screenshot({ path: `${SHOTS}/mail-assistant-open-draft.png` });
  await page.keyboard.press('Escape');
} else t('Open draft is shown', false);

// The chat is kept on the server: a reload finds it (a scripted turn never reached it).
if (LIVE) {
  await page.goto(`${B}/mail/?account=${ACC}&folder=INBOX`);
  await page.getByTestId('mail-assistant').waitFor();
  await page.getByTestId('mail-assistant').getByText('Summarize this email').first().waitFor({ timeout: 15_000 }).then(() => t('the chat is kept across reloads', true), (e) => t('the chat is kept across reloads', false, e.message));
} else {
  const saved = await api(A.token, 'GET', `/api/agent?scope=mail&workspace=${ORG}`);
  t('the Mail chat is its own, in the organization’s Docs', saved.s === 200 && Array.isArray(saved.j.items), saved.s);
}
// Full-width reading and a narrow screen.
await page.evaluate(() => localStorage.setItem('mail.readingPane', 'full'));
await page.goto(`${B}/mail/?account=${ACC}&folder=INBOX&uid=${q3.uid}`);
await page.getByTestId('mail-assistant').waitFor();
await page.screenshot({ path: `${SHOTS}/mail-assistant-full-width.png` });
await page.evaluate(() => localStorage.setItem('mail.readingPane', 'split'));
await page.goto(`${B}/mail/?account=${ACC}&folder=INBOX&uid=${q3.uid}`);
await page.getByTestId('mail-assistant').waitFor();
await page.locator('text=Revenue is up 12% >> visible=true').first().waitFor().catch(() => {});
await page.screenshot({ path: `${SHOTS}/mail-assistant-split.png` });
await page.setViewportSize({ width: 820, height: 900 });
await page.waitForTimeout(800);
await page.screenshot({ path: `${SHOTS}/mail-assistant-narrow.png` });
await browser.close();
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
