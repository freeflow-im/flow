// Invitations (platform.md §7, phase 4.2): a `calendar.invited` event on the agent's account starts a turn in the DM with
// the organizer when they are a member (else with the sponsor), once per event id across restarts; it comes with the
// catch-up and with the job subscription's poke, which an older bridge's subscription is renewed for. The three calendar
// tools call /v1/calendar/* as the agent with ?workspace=. Against a fake server, in the style of jobs.test.ts.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CalendarInvitedEventData, ChannelDTO, PlatformEvent } from '@flow/shared';
import { FlowApi } from '../src/api.js';
import { AgentBridge } from '../src/bridge.js';
import { ACCOUNT_TYPES, CATCH_UP_TYPES } from '../src/catch-up.js';
import { calendarTool, invitationPrompt, whenOf } from '../src/calendar-tools.js';
import { DEMO_REPLY } from '../src/runtime.js';
import type { BridgeConfig } from '../src/config.js';

const AGENT = 'aaaaaaaa-0000-0000-0000-000000000001';
const ANN = 'bbbbbbbb-0000-0000-0000-000000000002';
const SPONSOR = 'cccccccc-0000-0000-0000-000000000003';
const ORG = 'ws-1';

interface Hit { method: string; path: string; query: string; body: unknown }

class FakeServer {
  hits: Hit[] = [];
  subs: unknown[] = [];
  pages: { events: PlatformEvent[]; next: number }[] = [];
  private last = 20;
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
    if (req.method === 'GET' && u.pathname === '/v1/events/subscriptions') return json(200, { subscriptions: this.subs });
    if (req.method === 'POST' && u.pathname === '/v1/events/subscriptions') return json(201, { subscription: { id: 'sub-new', name: body.name, consumer: 'acct', owner: 'acct', filter: body.filter, delivery: body.delivery, cursor: 30 } });
    if (req.method === 'GET' && u.pathname.startsWith('/v1/events/subscriptions/')) { const page = this.pages.shift() ?? { events: [], next: this.last }; this.last = page.next; return json(200, page); }
    if (u.pathname.endsWith('/ack')) return json(200, { cursor: body.cursor });
    if (req.method === 'POST' && /^\/v1\/channels\/[^/]+\/messages$/.test(u.pathname)) return json(201, { id: `m-${this.hits.length}`, body: body.body });
    if (req.method === 'GET' && /\/messages$/.test(u.pathname)) return json(200, { messages: [], hasMore: false });
    if (req.method === 'GET' && u.pathname === '/v1/calendar/events') return json(200, { events: [event()] });
    if (req.method === 'GET' && u.pathname.startsWith('/v1/calendar/events/')) return json(200, { event: event() });
    if (req.method === 'POST' && u.pathname.endsWith('/respond')) return json(200, { event: { ...event(), myResponse: body.response }, replied: 'server' });
    return json(200, {});
  }
}

const event = () => ({
  id: 'n.acct-bot.abc:u1', summary: 'Review', start: '2026-12-03T15:00:00.000Z', end: '2026-12-03T16:00:00.000Z', allDay: false, location: 'Room 4', status: 'confirmed',
  organizer: { name: 'Ann', email: 'ann@acme.freeflow.im' }, attendees: [{ name: 'Ann', email: 'ann@acme.freeflow.im', response: 'accepted' }, { name: null, email: 'builder@acme.freeflow.im', response: 'needs-action' }], myResponse: 'needs-action',
});
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
  b.me = { id: AGENT, isAgent: true, displayName: 'Builder' };
  b.workspace = { id: ORG, name: 'Acme' };
  b.channels = new Map();
  b.members = new Map([
    [ANN, { userId: ANN, displayName: 'Ann', isAgent: false, accountId: 'acct-ann', address: 'ann@acme.freeflow.im', email: 'ann@example.com' }],
    [SPONSOR, { userId: SPONSOR, displayName: 'Sam', isAgent: false, accountId: 'acct-sam', address: 'sam@acme.freeflow.im', email: 'sam@example.com' }],
    [AGENT, { userId: AGENT, displayName: 'Builder', isAgent: true, sponsorId: SPONSOR, accountId: 'acct-bot' }],
  ]);
  b.refreshDirectory = async () => {};
  b.socket = { sendTyping: () => {} };
  b.lines = [] as string[];
  b.log = (m: string) => b.lines.push(m);
  return b;
}

let seq = 20;
function invited(eventId = 'n.acct-bot.abc:u1', organizer: CalendarInvitedEventData['organizer'] = { email: 'ann@acme.freeflow.im', name: 'Ann', accountId: 'acct-ann' }, org = ORG): PlatformEvent<CalendarInvitedEventData> {
  return {
    id: `e${++seq}`, seq, type: 'calendar.invited', organizationId: org, actor: 'acct-ann', depth: 0, ts: '2026-11-06T00:00:00Z',
    data: { calendarId: 'n.acct-bot.abc', eventId, uid: 'u1', summary: 'Review', start: '2026-12-03T15:00:00.000Z', end: '2026-12-03T16:00:00.000Z', allDay: false, ownerAccountId: 'acct-bot', url: 'https://app.test/calendar/week/2026-12-03?event=x', organizer },
  } as PlatformEvent<CalendarInvitedEventData>;
}

async function until(fn: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

let server: FakeServer;
let dir: string;
beforeEach(async () => {
  server = new FakeServer();
  await server.start();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-calendar-'));
});
afterEach(async () => {
  await server.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('an invitation', () => {
  it('starts a turn in the DM with the organizer, asking for respond_to_event', async () => {
    const b = bridge();
    const asked: { channelId: string; userId: string; body: string }[] = [];
    const enqueue = b.enqueue.bind(b);
    b.enqueue = (m: { channelId: string; userId: string; body: string }) => { asked.push(m); enqueue(m); };
    await b.handleAccountEvent(invited());
    expect(server.of(/^POST \/v1\/workspaces\/ws-1\/dms$/).map((h) => h.body)).toEqual([{ userIds: [ANN] }]);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ channelId: `dm-${ANN}`, userId: ANN });
    expect(asked[0]!.body).toBe('You were invited to "Review" on Thu, Dec 3, 2026, 15:00–16:00 UTC by Ann <ann@acme.freeflow.im>. Decide whether to accept, decline or answer tentatively, and respond with the `respond_to_event` tool (event id n.acct-bot.abc:u1); you may ask a question in this DM first. get_event shows its details.');
    await until(() => server.of(/^POST \/v1\/channels\/dm-[^/]+\/messages$/).length > 0);
    expect(server.of(/^POST \/v1\/channels\/dm-[^/]+\/messages$/).map((h) => (h.body as { body: string }).body)).toEqual([DEMO_REPLY]);
  });

  it('with the sponsor when the organizer is not a member; another organization\'s is not ours', async () => {
    const b = bridge();
    await b.handleInvitation(invited('n.acct-bot.abc:u2', { email: 'guest@example.com', name: null, accountId: 'acct-elsewhere' }));
    expect(server.of(/dms$/).map((h) => h.body)).toEqual([{ userIds: [SPONSOR] }]);
    await b.handleInvitation(invited('n.acct-bot.abc:u3', undefined, 'ws-2'));
    expect(server.of(/dms$/)).toHaveLength(1);
  });

  it('is answered once per event id, across a restart too', async () => {
    const stateFile = path.join(dir, 'state.json');
    let b = bridge(config({ stateFile }));
    await Promise.all([b.handleInvitation(invited()), b.handleInvitation(invited())]);
    await b.handleInvitation(invited());
    expect(server.of(/dms$/)).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf8')).handledInvitationIds).toEqual(['n.acct-bot.abc:u1']);
    b = bridge(config({ stateFile }));
    await b.handleInvitation(invited());
    expect(server.of(/dms$/)).toHaveLength(1);
    expect(b.lines.some((l: string) => /already answered/.test(l))).toBe(true);
  });

  it('comes with the catch-up and the job subscription; an older job subscription is renewed with calendar.invited', async () => {
    expect(CATCH_UP_TYPES).toContain('calendar.invited');
    expect(ACCOUNT_TYPES).toEqual(['agent.job', 'calendar.invited']);
    server.subs = [
      { id: 'sub-main', name: `bridge:${AGENT}`, consumer: 'acct', owner: 'acct', filter: { types: CATCH_UP_TYPES }, delivery: 'pull', cursor: 20 },
      { id: 'sub-jobs', name: `bridge-jobs:${AGENT}`, consumer: 'acct', owner: 'acct', filter: { types: ['agent.job'], self: true }, delivery: 'socket', cursor: 20 },
    ];
    server.pages = [{ events: [invited('n.acct-bot.abc:c1')], next: 21 }];
    const b = bridge();
    expect(await b.catchUp()).toBe(21);
    expect(server.of(/dms$/)).toHaveLength(1);
    await b.ensureJobsSubscription();
    expect(server.of(/^POST \/v1\/events\/subscriptions$/).map((h) => h.body)).toEqual([{ name: `bridge-jobs:${AGENT}`, filter: { types: ACCOUNT_TYPES, self: true }, delivery: 'socket' }]);
    expect(server.of(/^DELETE \/v1\/events\/subscriptions\/sub-jobs$/)).toHaveLength(1);
    expect(b.jobsSub).toEqual({ id: 'sub-new' });
    server.pages = [{ events: [invited('n.acct-bot.abc:c2')], next: 31 }];
    await b.readJobs('sub-new');
    expect(server.of(/dms$/)).toHaveLength(2);
  });
});

describe('the calendar tools', () => {
  it('call /v1/calendar/* as the agent, with ?workspace=', async () => {
    const api = new FlowApi(server.url, 'token');
    let out = await calendarTool(api, ORG, 'list_my_events', { from: '2026-12-01T00:00:00Z', to: '2026-12-31T00:00:00Z' });
    expect(out).toEqual({ isError: false, text: 'n.acct-bot.abc:u1  Thu, Dec 3, 2026, 15:00–16:00 UTC  Review  organizer Ann <ann@acme.freeflow.im>  [your answer: needs-action]' });
    out = await calendarTool(api, ORG, 'get_event', { id: 'n.acct-bot.abc:u1' });
    expect(out.text).toContain('attendees: Ann <ann@acme.freeflow.im> (accepted), builder@acme.freeflow.im (needs-action)');
    expect(out.text).toContain('where: Room 4');
    out = await calendarTool(api, ORG, 'respond_to_event', { id: 'n.acct-bot.abc:u1', response: 'declined', comment: 'Out that day' });
    expect(out).toEqual({ isError: false, text: 'answered declined to "Review" — the organizer has your answer' });
    expect(server.hits.map((h) => `${h.method} ${h.path}${h.query}`)).toEqual([
      'GET /v1/calendar/events?from=2026-12-01T00%3A00%3A00Z&to=2026-12-31T00%3A00%3A00Z&workspace=ws-1',
      'GET /v1/calendar/events/n.acct-bot.abc%3Au1?workspace=ws-1',
      'POST /v1/calendar/events/n.acct-bot.abc%3Au1/respond?workspace=ws-1',
    ]);
    expect(server.hits[2]!.body).toEqual({ response: 'declined', comment: 'Out that day' });
    expect((await calendarTool(api, ORG, 'respond_to_event', { id: 'x', response: 'maybe' })).isError).toBe(true);
    expect((await calendarTool(api, '', 'get_event', { id: 'x' })).isError).toBe(true);
    expect(server.hits).toHaveLength(3);
  });

  it('say when in words', () => {
    expect(whenOf('2026-12-03', '2026-12-04', true)).toBe('Thu, Dec 3, 2026 (all day)');
    expect(whenOf('2026-12-03T23:00:00Z', '2026-12-04T01:00:00Z', false)).toBe('Thu, Dec 3, 2026 23:00 – Fri, Dec 4, 2026 01:00 UTC');
    expect(invitationPrompt({ ...invited().data!, summary: '' })).toMatch(/^You were invited to "an event"/);
  });
});
