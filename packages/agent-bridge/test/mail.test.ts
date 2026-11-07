// The agent's mailbox (platform.md §3.3, phase 5.4): a `mail.received` event on the agent's account starts a turn in the DM
// with the sender when they are a member (with the sponsor when the sender is an agent), naming the message id for
// read_mail; outside mail is ignored unless `mail.fromOutside` is `wake`; each message once, across restarts. The six mail
// tools call /v1/mail/* as the agent with ?workspace=, on its hosted account. Against a fake server, as calendar.test.ts.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChannelDTO, PlatformEvent } from '@flow/shared';
import { FlowApi } from '../src/api.js';
import { AgentBridge } from '../src/bridge.js';
import { ACCOUNT_TYPES, CATCH_UP_TYPES } from '../src/catch-up.js';
import { MAIL_TOOL_NAMES, NO_MAILBOX, htmlToText, mailPrompt, mailTool, markdownToHtml, type MailReceivedEventData } from '../src/mail-tools.js';
import { loadConfig, type BridgeConfig } from '../src/config.js';

const AGENT = 'aaaaaaaa-0000-0000-0000-000000000001';
const ANN = 'bbbbbbbb-0000-0000-0000-000000000002';
const SPONSOR = 'cccccccc-0000-0000-0000-000000000003';
const OTHER_BOT = 'dddddddd-0000-0000-0000-000000000004';
const ORG = 'ws-1';
const BOX = 'acct-box';

interface Hit { method: string; path: string; query: string; body: unknown }

class FakeServer {
  hits: Hit[] = [];
  /** The agent's mail accounts: its hosted mailbox, after a connected one, unless a test empties it. */
  accounts: unknown[] = [{ id: 'acct-conn', kind: 'connected', email: 'me@gmail.com', displayName: 'Me' }, { id: BOX, kind: 'hosted', email: 'builder@acme.freeflow.im', displayName: 'Builder' }];
  private server = http.createServer((req, res) => void this.handle(req, res));
  url = '';
  async start(): Promise<void> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }
  stop(): Promise<void> { return new Promise((r) => this.server.close(() => r())); }
  of(re: RegExp): Hit[] { return this.hits.filter((h) => re.test(`${h.method} ${h.path}`)); }
  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const u = new URL(req.url!, 'http://x');
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    this.hits.push({ method: req.method!, path: u.pathname, query: u.search, body });
    const json = (status: number, j: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
    if (req.method === 'POST' && u.pathname === `/v1/workspaces/${ORG}/dms`) return json(201, { ...dm, id: `dm-${body.userIds[0]}` });
    if (req.method === 'POST' && /^\/v1\/channels\/[^/]+\/messages$/.test(u.pathname)) return json(201, { id: `m-${this.hits.length}`, body: body.body });
    if (req.method === 'GET' && /^\/v1\/channels\/[^/]+\/messages$/.test(u.pathname)) return json(200, { messages: [], hasMore: false });
    if (req.method === 'GET' && u.pathname === '/v1/mail/accounts') return json(200, { accounts: this.accounts });
    if (req.method === 'GET' && u.pathname === `/v1/mail/accounts/${BOX}/messages`) return json(200, { messages: [summary(7, false), summary(6, true)], next: null });
    if (req.method === 'GET' && u.pathname.startsWith(`/v1/mail/accounts/${BOX}/messages/`)) {
      const uid = Number(u.pathname.split('/').pop());
      if (uid === 404) return json(404, { error: { code: 'not_found', message: 'no such message' } });
      return json(200, { message: { ...summary(uid, false), cc: [], replyTo: [], messageId: '<m7@acme.freeflow.im>', inReplyTo: null, references: ['<m1@acme.freeflow.im>'],
        html: '<p>Hi Builder,</p><p>Can you send the <a href="https://acme.test/r">report</a>?</p><script>x()</script>', text: null, attachments: [{ index: 0, filename: 'q3.pdf', mimeType: 'application/pdf', size: 1200, inline: false }] } });
    }
    if (req.method === 'POST' && u.pathname === `/v1/mail/accounts/${BOX}/send`) return json(200, { ok: true, messageId: '<sent1@acme.freeflow.im>' });
    return json(200, { ok: true });
  }
}

const summary = (uid: number, seen: boolean) => ({ uid, folder: 'INBOX', from: { name: 'Ann', address: 'ann@acme.freeflow.im' }, to: [{ name: '', address: 'builder@acme.freeflow.im' }], subject: 'Report', date: '2026-11-07T10:00:00.000Z', seen, flagged: false, hasAttachments: uid === 7 });
const dm = { id: 'dm', workspaceId: ORG, name: null, kind: 'dm', isPrivate: true, createdBy: AGENT, isMember: true } as unknown as ChannelDTO;

function config(over: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    serverUrl: server.url, agentToken: 'token', workspace: null, logFile: null,
    runtime: { kind: 'demo', command: 'demo', extraArgs: [], cwd: process.cwd(), allowedTools: [], maxTurns: 10, timeoutSec: 30, idleTimeoutSec: 10, sessionIdleSec: 600, sessionHardCapSec: 3600, mcp: false },
    eventScope: 'mentions', respondToAgents: false, agentMentionsOnly: false, agentChainLimit: 6, concurrency: 1, progress: 'silent', relayText: true,
    ...over,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function bridge(cfg = config()): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const b = new AgentBridge(cfg) as any;
  b.me = { id: AGENT, isAgent: true, displayName: 'Builder', accounts: [{ organizationId: ORG, address: 'builder@acme.freeflow.im' }] };
  b.workspace = { id: ORG, name: 'Acme' };
  b.channels = new Map();
  b.members = new Map([
    [ANN, { userId: ANN, displayName: 'Ann Lee', isAgent: false, accountId: 'acct-ann', address: 'ann@acme.freeflow.im', email: 'ann@example.com' }],
    [SPONSOR, { userId: SPONSOR, displayName: 'Sam', isAgent: false, accountId: 'acct-sam', address: 'sam@acme.freeflow.im', email: 'sam@example.com' }],
    [OTHER_BOT, { userId: OTHER_BOT, displayName: 'Helper', isAgent: true, sponsorId: ANN, accountId: 'acct-helper', address: 'helper@acme.freeflow.im', email: '' }],
    [AGENT, { userId: AGENT, displayName: 'Builder', isAgent: true, sponsorId: SPONSOR, accountId: 'acct-bot', address: 'builder@acme.freeflow.im' }],
  ]);
  b.refreshes = 0;
  b.refreshDirectory = async () => { b.refreshes++; };
  b.socket = { sendTyping: () => {} };
  b.lines = [] as string[];
  b.log = (m: string) => b.lines.push(m);
  b.asked = [] as { channelId: string; userId: string; body: string }[];
  const enqueue = b.enqueue.bind(b);
  b.enqueue = (m: { channelId: string; userId: string; body: string }) => { b.asked.push(m); enqueue(m); };
  return b;
}

let seq = 40;
function received(uid: number, from: MailReceivedEventData['from'] = { name: 'Ann', address: 'Ann@acme.freeflow.im' }, org = ORG): PlatformEvent<MailReceivedEventData> {
  return {
    id: `e${++seq}`, seq, type: 'mail.received', organizationId: org, actor: null, depth: 0, ts: '2026-11-07T10:00:00Z',
    ref: { organizationId: org, app: 'mail', kind: 'message', id: `${BOX}:INBOX:${uid}` },
    data: { accountId: BOX, folder: 'INBOX', uid, from, subject: 'Report', date: '2026-11-07T10:00:00.000Z' },
  } as PlatformEvent<MailReceivedEventData>;
}

let server: FakeServer;
let dir: string;
beforeEach(async () => {
  server = new FakeServer();
  await server.start();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-mail-'));
});
afterEach(async () => {
  await server.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('mail from a member', () => {
  it('starts a turn in the DM with the sender, naming the message id for read_mail', async () => {
    expect(CATCH_UP_TYPES).toContain('mail.received');
    expect(ACCOUNT_TYPES).toEqual(['agent.job', 'calendar.invited', 'mail.received']);
    const b = bridge();
    await b.handleAccountEvent(received(7));
    expect(server.of(/dms$/).map((h) => h.body)).toEqual([{ userIds: [ANN] }]);
    expect(b.asked).toHaveLength(1);
    expect(b.asked[0]).toMatchObject({ channelId: `dm-${ANN}`, userId: ANN });
    expect(b.asked[0].body).toBe('You received an email from Ann Lee <Ann@acme.freeflow.im>: "Report". Read it with `read_mail` (id acct-box:INBOX:7) and act on it; reply by email with `send_mail` (reply_to_id) if a reply is wanted, or answer here.');
    expect(b.refreshes).toBe(0);
  });

  it('from an agent, with the sponsor; a member found by their login email too', async () => {
    const b = bridge();
    await b.handleMail(received(8, { name: 'Helper', address: 'helper@acme.freeflow.im' }));
    expect(server.of(/dms$/).map((h) => h.body)).toEqual([{ userIds: [SPONSOR] }]);
    await b.handleMail(received(9, { name: '', address: 'ann@example.com' }));
    expect(server.of(/dms$/).map((h) => h.body)).toEqual([{ userIds: [SPONSOR] }, { userIds: [ANN] }]);
    expect(b.asked.map((m: { body: string }) => m.body.slice(0, 55))).toEqual(['You received an email from Helper <helper@acme.freeflow', 'You received an email from Ann Lee <ann@example.com>: "']);
  });

  it('from outside is logged and ignored by default, and wakes the sponsor with fromOutside: wake', async () => {
    let b = bridge();
    await b.handleMail(received(10, { name: 'Pat', address: 'pat@example.org' }));
    expect(b.refreshes).toBe(1);
    expect(server.of(/dms$/)).toHaveLength(0);
    expect(b.asked).toHaveLength(0);
    expect(b.lines.some((l: string) => /pat@example.org, not a member — ignored/.test(l))).toBe(true);
    b = bridge(config({ mail: { fromOutside: 'wake' } }));
    await b.handleMail(received(11, { name: 'Pat', address: 'pat@example.org' }));
    expect(server.of(/dms$/).map((h) => h.body)).toEqual([{ userIds: [SPONSOR] }]);
    expect(b.asked[0].body).toMatch(/^You received an email from Pat <pat@example.org>: "Report"\. Read it with `read_mail` \(id acct-box:INBOX:11\)/);
  });

  it('is taken once per message id, across a restart; its own mail and another organization\'s are not', async () => {
    const stateFile = path.join(dir, 'state.json');
    let b = bridge(config({ stateFile }));
    await Promise.all([b.handleMail(received(12)), b.handleMail(received(12))]);
    await b.handleMail(received(12));
    expect(server.of(/dms$/)).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf8')).handledMailIds).toEqual([`${BOX}:INBOX:12`]);
    b = bridge(config({ stateFile }));
    await b.handleMail(received(12));
    await b.handleMail(received(13, { name: 'Builder', address: 'builder@acme.freeflow.im' }));
    await b.handleMail(received(14, undefined, 'ws-2'));
    expect(server.of(/dms$/)).toHaveLength(1);
    expect(b.lines.some((l: string) => /already taken/.test(l))).toBe(true);
  });
});

describe('the mail tools', () => {
  it('call /v1/mail/* as the agent, with ?workspace=, on its hosted mailbox', async () => {
    expect([...MAIL_TOOL_NAMES]).toEqual(['list_mail', 'search_mail', 'read_mail', 'send_mail', 'move_mail', 'mark_mail']);
    const api = new FlowApi(server.url, 'token');
    let out = await mailTool(api, ORG, 'list_mail', { unread_only: true, limit: 5 });
    expect(out).toEqual({ isError: false, text: 'builder@acme.freeflow.im, INBOX:\nacct-box:INBOX:7  2026-11-07T10:00:00.000Z  Ann <ann@acme.freeflow.im>  Report  [unread]  [attachments]\nacct-box:INBOX:6  2026-11-07T10:00:00.000Z  Ann <ann@acme.freeflow.im>  Report' });
    out = await mailTool(api, ORG, 'search_mail', { query: 'report' });
    expect(out.isError).toBe(false);
    out = await mailTool(api, ORG, 'read_mail', { ids: [`${BOX}:INBOX:7`, `${BOX}:INBOX:404`] });
    expect(out.isError).toBe(false);
    expect(out.text).toContain('id: acct-box:INBOX:7\nfrom: Ann <ann@acme.freeflow.im>\nto: builder@acme.freeflow.im\nsubject: Report');
    expect(out.text).toContain('attachments: q3.pdf (application/pdf, 1200 bytes)');
    expect(out.text).toContain('Hi Builder,\n\nCan you send the report (https://acme.test/r)?');
    expect(out.text).not.toContain('x()');
    expect(out.text).toContain('id: acct-box:INBOX:404\nnot read:');
    out = await mailTool(api, ORG, 'move_mail', { ids: [`${BOX}:INBOX:7`, `${BOX}:Sent:2`], to_folder: 'Archive' });
    expect(out.text).toBe('moved 2 messages to Archive; their ids changed (list Archive to find them)');
    out = await mailTool(api, ORG, 'mark_mail', { id: `${BOX}:INBOX:6`, seen: true, flagged: false });
    expect(out.text).toBe('marked 1 message read and not starred');
    expect(server.hits.filter((h) => h.path !== '/v1/mail/accounts').map((h) => `${h.method} ${h.path}${h.query}`)).toEqual([
      'GET /v1/mail/accounts/acct-box/messages?folder=INBOX&limit=5&unread=1&workspace=ws-1',
      'GET /v1/mail/accounts/acct-box/messages?folder=INBOX&limit=20&q=report&workspace=ws-1',
      'GET /v1/mail/accounts/acct-box/messages/7?folder=INBOX&workspace=ws-1',
      'GET /v1/mail/accounts/acct-box/messages/404?folder=INBOX&workspace=ws-1',
      'POST /v1/mail/accounts/acct-box/messages/move?workspace=ws-1',
      'POST /v1/mail/accounts/acct-box/messages/move?workspace=ws-1',
      'PATCH /v1/mail/accounts/acct-box/messages?workspace=ws-1',
    ]);
    expect(server.of(/move$/).map((h) => h.body)).toEqual([{ folder: 'INBOX', uids: [7], to: 'Archive' }, { folder: 'Sent', uids: [2], to: 'Archive' }]);
    expect(server.of(/^PATCH/)[0]!.body).toEqual({ folder: 'INBOX', uids: [6], seen: true, flagged: false });
    expect(server.of(/^GET \/v1\/mail\/accounts$/).every((h) => h.query === '?workspace=ws-1')).toBe(true);
    // Ids from another account are refused before any request.
    out = await mailTool(api, ORG, 'read_mail', { ids: ['acct-conn:INBOX:1'] });
    expect(out).toEqual({ isError: true, text: 'acct-conn:INBOX:1 is not in your mailbox (builder@acme.freeflow.im)' });
    expect((await mailTool(api, ORG, 'read_mail', { ids: ['nope'] })).isError).toBe(true);
    expect((await mailTool(api, ORG, 'mark_mail', { ids: [`${BOX}:INBOX:6`] })).isError).toBe(true);
  });

  it('send mail as Markdown made HTML, and a reply threaded to the original', async () => {
    const api = new FlowApi(server.url, 'token');
    let out = await mailTool(api, ORG, 'send_mail', { to: ['Ann <ann@acme.freeflow.im>'], subject: 'Done', body: 'The **report** is ready:\n\n- [link](https://acme.test/r)\n- `q3.pdf`' });
    expect(out).toEqual({ isError: false, text: 'sent "Done" from builder@acme.freeflow.im to Ann <ann@acme.freeflow.im> (Message-ID <sent1@acme.freeflow.im>)' });
    expect(server.of(/send$/)[0]!.body).toEqual({
      to: [{ name: 'Ann', address: 'ann@acme.freeflow.im' }], subject: 'Done',
      html: '<p>The <strong>report</strong> is ready:</p><ul><li><a href="https://acme.test/r">link</a></li><li><code>q3.pdf</code></li></ul>',
      text: 'The **report** is ready:\n\n- [link](https://acme.test/r)\n- `q3.pdf`',
    });
    out = await mailTool(api, ORG, 'send_mail', { reply_to_id: `${BOX}:INBOX:7`, body: 'Here it is.' });
    expect(out.text).toBe('sent "Re: Report" from builder@acme.freeflow.im to Ann <ann@acme.freeflow.im> (Message-ID <sent1@acme.freeflow.im>)');
    const reply = server.of(/send$/)[1]!.body as Record<string, unknown>;
    expect(reply).toMatchObject({ to: [{ name: 'Ann', address: 'ann@acme.freeflow.im' }], subject: 'Re: Report', inReplyTo: '<m7@acme.freeflow.im>', references: ['<m1@acme.freeflow.im>', '<m7@acme.freeflow.im>'] });
    expect(reply.html).toMatch(/^<p>Here it is\.<\/p><br><p>On 2026-11-07T10:00:00.000Z, Ann &lt;ann@acme.freeflow.im&gt; wrote:<\/p><blockquote><p>Hi Builder,<\/p>/);
    expect(reply.text).toContain('\n> Hi Builder,\n>\n> Can you send the report (https://acme.test/r)?');
    expect((await mailTool(api, ORG, 'send_mail', { to: ['not an address'], subject: 'x', body: 'y' })).isError).toBe(true);
    expect((await mailTool(api, ORG, 'send_mail', { to: ['a@b.co'], body: 'y' })).isError).toBe(true);
    expect(server.of(/send$/)).toHaveLength(2);
  });

  it('say there is no mailbox yet without failing the turn', async () => {
    server.accounts = [{ id: 'acct-conn', kind: 'connected', email: 'me@gmail.com', displayName: 'Me' }];
    const api = new FlowApi(server.url, 'token');
    for (const name of MAIL_TOOL_NAMES) expect(await mailTool(api, ORG, name, { ids: ['acct-conn:INBOX:1'], body: 'x', query: 'x' })).toEqual({ isError: false, text: NO_MAILBOX });
    expect(server.hits.every((h) => h.path === '/v1/mail/accounts')).toBe(true);
  });
});

describe('agent.json', () => {
  it('mail.fromOutside is ignore by default, wake on request, and nothing else', () => {
    const write = (j: unknown) => { const f = path.join(dir, 'agent.json'); fs.writeFileSync(f, JSON.stringify({ serverUrl: 'http://x', agentToken: 't', runtime: { kind: 'demo' }, ...(j as object) })); return f; };
    expect(loadConfig(write({})).mail).toEqual({ fromOutside: 'ignore' });
    expect(loadConfig(write({ mail: { fromOutside: 'wake' } })).mail).toEqual({ fromOutside: 'wake' });
    expect(() => loadConfig(write({ mail: { fromOutside: 'always' } }))).toThrow(/mail.fromOutside/);
  });
});

describe('Markdown and HTML', () => {
  it('Markdown as mail HTML: raw HTML stays text, line breaks kept', () => {
    expect(markdownToHtml('# Hi\n\nline one\nline two\n\n1. a\n2. *b*\n\n> quoted\n\n```\n<b>x</b>\n```\n\n<script>x</script>')).toBe(
      '<h1>Hi</h1><p>line one<br>line two</p><ol><li>a</li><li><em>b</em></li></ol><blockquote><p>quoted</p></blockquote><pre><code>&lt;b&gt;x&lt;/b&gt;</code></pre><p>&lt;script&gt;x&lt;/script&gt;</p>');
    expect(markdownToHtml('[bad](javascript:alert(1)) snake_case_name')).toBe('<p>[bad](javascript:alert(1)) snake_case_name</p>');
  });
  it('HTML as text', () => {
    expect(htmlToText('<div>A&amp;B</div><ul><li>one</li><li>two</li></ul><a href="mailto:x@y.z">x@y.z</a>')).toBe('A&B\n\n- one\n- two\n\nx@y.z');
    expect(mailPrompt({ accountId: BOX, folder: 'INBOX', uid: 1, from: null, subject: '', date: '' }, 'x', null)).toMatch(/^You received an email from an unknown sender: "\(no subject\)"/);
  });
});
