// Wake jobs (platform.md §5.2, phase 2.4): an `agent.job` event, live or from the catch-up, is acked, run as a turn the
// way start_task runs one with `x-flow-job` on every request of it, its lease extended while it runs, and reported done
// (or failed). A job is taken once, across restarts too. Against a fake server, in the style of catch-up.test.ts.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentJobEventData, ChannelDTO, PlatformEvent } from '@flow/shared';
import { AgentBridge } from '../src/bridge.js';
import { ACCOUNT_TYPES, CATCH_UP_TYPES } from '../src/catch-up.js';
import { DEMO_REPLY } from '../src/runtime.js';
import type { BridgeConfig } from '../src/config.js';

const AGENT = 'aaaaaaaa-0000-0000-0000-000000000001';
const HUMAN = 'bbbbbbbb-0000-0000-0000-000000000002';
const ORG = 'ws-1';

interface Hit { method: string; path: string; job: string | undefined; body: unknown }

/** The job, channel and message routes of an edge server; every request is recorded with its `x-flow-job`. */
class FakeServer {
  hits: Hit[] = [];
  /** Jobs the server no longer offers: their ack is a 409. */
  closed = new Set<string>();
  subs: unknown[] = [];
  pages: { events: PlatformEvent[]; next: number }[] = [];
  private last = 20;
  private server = http.createServer((req, res) => void this.handle(req, res));
  url = '';

  async start(): Promise<void> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  stop(): Promise<void> {
    return new Promise((r) => this.server.close(() => r()));
  }

  of(re: RegExp): Hit[] {
    return this.hits.filter((h) => re.test(`${h.method} ${h.path}`));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const u = new URL(req.url!, 'http://x');
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    this.hits.push({ method: req.method!, path: u.pathname, job: req.headers['x-flow-job'] as string | undefined, body });
    const json = (status: number, j: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
    const job = /^\/v1\/events\/jobs\/([^/]+)\/(ack|extend|done)$/.exec(u.pathname);
    if (job) {
      if (job[2] === 'ack' && this.closed.has(job[1]!)) return json(409, { error: { code: 'job_state', message: 'the job is parked' } });
      return json(200, { job: { id: job[1], state: job[2] === 'done' ? (body.ok ? 'done' : 'failed') : 'running' } });
    }
    if (req.method === 'GET' && u.pathname === '/v1/events/subscriptions') return json(200, { subscriptions: this.subs });
    if (req.method === 'GET' && u.pathname.startsWith('/v1/events/subscriptions/')) {
      const page = this.pages.shift() ?? { events: [], next: this.last };
      this.last = page.next;
      return json(200, page);
    }
    if (u.pathname.endsWith('/ack')) return json(200, { cursor: body.cursor });
    if (req.method === 'POST' && u.pathname === `/v1/workspaces/${ORG}/channels`) return json(201, { ...channel, id: 'chan-job', name: body.name, createdBy: AGENT });
    if (req.method === 'POST' && /^\/v1\/channels\/[^/]+\/messages$/.test(u.pathname)) return json(201, { id: `m-${this.hits.length}`, body: body.body });
    if (req.method === 'GET' && /\/messages$/.test(u.pathname)) return json(200, { messages: [], hasMore: false });
    return json(200, {});
  }
}

function config(over: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    serverUrl: server.url, agentToken: 'token', workspace: null, logFile: null,
    runtime: { kind: 'demo', command: 'demo', extraArgs: [], cwd: process.cwd(), allowedTools: [], maxTurns: 10, timeoutSec: 30, idleTimeoutSec: 10, sessionIdleSec: 600, sessionHardCapSec: 3600, mcp: false },
    eventScope: 'mentions', respondToAgents: false, agentMentionsOnly: false, agentChainLimit: 6, concurrency: 1, progress: 'silent', relayText: true,
    ...over,
  };
}

const channel = { id: 'chan-1', workspaceId: ORG, name: 'general', kind: 'standard', isPrivate: false, createdBy: HUMAN, isMember: true } as ChannelDTO;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function bridge(cfg = config()): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const b = new AgentBridge(cfg) as any;
  b.me = { id: AGENT, isAgent: true, displayName: 'Omni' };
  b.workspace = { id: ORG, name: 'QA Lab' };
  b.channels = new Map([[channel.id, channel]]);
  b.members = new Map([[HUMAN, { userId: HUMAN, displayName: 'Alice', isAgent: false }]]);
  b.socket = { sendTyping: () => {} };
  b.lines = [] as string[];
  b.log = (m: string) => b.lines.push(m);
  b.jobExtendMs = 100;
  return b;
}

let seq = 20;
function jobEvent(jobId: string, channelId?: string): PlatformEvent<AgentJobEventData> {
  return {
    id: `e${++seq}`, seq, type: 'agent.job', organizationId: ORG, actor: null, causedBy: jobId, depth: 1, ts: '2026-11-06T00:00:00Z',
    data: { jobId, subscriptionId: 'sub-w', prompt: 'Summarize: {"body":"hi"}', ...(channelId ? { channelId } : {}), event: { id: 'e1', seq: 1, type: 'chat.message.created', channelId: 'chan-1' } },
  };
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-jobs-'));
});
afterEach(async () => {
  await server.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('a wake job', () => {
  it('is acked, run in its channel with x-flow-job on every request, extended while it runs, and reported done', async () => {
    const b = bridge();
    await b.handleJob(jobEvent('job-1', 'chan-1'));
    // While it runs, the MCP server's question (`/job` on the task IPC) for this conversation names the job.
    await until(() => b.activeJobs.size > 0);
    expect([...b.activeJobs]).toEqual([['chan-1|', 'job-1']]);
    await until(() => server.of(/done$/).length > 0);
    expect(b.activeJobs.size).toBe(0);
    const ack = server.of(/\/jobs\/job-1\/ack$/);
    expect(ack).toHaveLength(1);
    expect(ack[0]!.job).toBe('job-1');
    const reply = server.of(/^POST \/v1\/channels\/chan-1\/messages$/);
    expect(reply.map((h) => (h.body as { body: string }).body)).toEqual([DEMO_REPLY]);
    expect(reply[0]!.job).toBe('job-1');
    // The demo turn takes 500 ms; the lease is extended every 100 ms in this test.
    expect(server.of(/\/jobs\/job-1\/extend$/).length).toBeGreaterThanOrEqual(2);
    const done = server.of(/\/jobs\/job-1\/done$/);
    expect(done[0]!.body).toEqual({ ok: true, note: DEMO_REPLY });
    // Every request of the turn, the reply's and the job steps', carried the job.
    const ours = server.hits.filter((h) => h.method !== 'GET');
    expect(ours.every((h) => h.job === 'job-1')).toBe(true);
  });

  it('without a channel runs in a new job channel of its own', async () => {
    const b = bridge();
    await b.handleJob(jobEvent('0123456789abcdef'));
    await until(() => server.of(/done$/).length > 0);
    const made = server.of(/^POST \/v1\/workspaces\/ws-1\/channels$/);
    expect(made.map((h) => (h.body as { name: string }).name)).toEqual(['job-01234567']);
    expect(made[0]!.job).toBe('0123456789abcdef');
    expect(server.of(/^POST \/v1\/channels\/chan-job\/messages$/)).toHaveLength(1);
  });

  it('is taken once: a copy, and the same job after a restart, are passed over', async () => {
    const stateFile = path.join(dir, 'state.json');
    fs.writeFileSync(stateFile, JSON.stringify({ handledMessageIds: ['m-1'] }));
    const b = bridge(config({ stateFile }));
    await Promise.all([b.handleJob(jobEvent('job-2', 'chan-1')), b.handleJob(jobEvent('job-2', 'chan-1'))]);
    await until(() => server.of(/done$/).length > 0);
    await b.handleJob(jobEvent('job-2', 'chan-1'));
    const again = bridge(config({ stateFile }));
    await again.handleJob(jobEvent('job-2', 'chan-1'));
    expect(server.of(/\/jobs\/job-2\/ack$/)).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf8'))).toEqual({ handledMessageIds: ['m-1'], handledJobIds: ['job-2'] });
  });

  it('whose turn fails is reported done with ok false', async () => {
    const b = bridge(config({ runtime: { ...config().runtime, kind: 'codex', command: path.join(dir, 'no-such-cli') } }));
    await b.handleJob(jobEvent('job-3', 'chan-1'));
    await until(() => server.of(/done$/).length > 0);
    const done = server.of(/\/jobs\/job-3\/done$/)[0]!;
    expect((done.body as { ok: boolean }).ok).toBe(false);
    expect((done.body as { note: string }).note.length).toBeGreaterThan(0);
  });

  it('the server no longer offers is not run, and not asked about again', async () => {
    server.closed.add('job-4');
    const b = bridge();
    await b.handleJob(jobEvent('job-4', 'chan-1'));
    await b.handleJob(jobEvent('job-4', 'chan-1'));
    await new Promise((r) => setTimeout(r, 100));
    expect(server.of(/\/jobs\/job-4\/ack$/)).toHaveLength(1);
    expect(server.of(/messages$/).filter((h) => h.method === 'POST')).toHaveLength(0);
  });

  it('comes with the catch-up, and live with a poke for the job subscription', async () => {
    server.subs = [
      { id: 'sub-main', name: `bridge:${AGENT}`, consumer: 'acct', owner: 'acct', filter: { types: CATCH_UP_TYPES }, delivery: 'pull', cursor: 20 },
      { id: 'sub-jobs', name: `bridge-jobs:${AGENT}`, consumer: 'acct', owner: 'acct', filter: { types: ACCOUNT_TYPES, self: true }, delivery: 'socket', cursor: 20 },
    ];
    server.pages = [{ events: [jobEvent('job-5', 'chan-1')], next: 21 }];
    const b = bridge();
    expect(await b.catchUp()).toBe(21);
    await b.ensureJobsSubscription();
    server.pages = [{ events: [jobEvent('job-6', 'chan-1'), jobEvent('job-5', 'chan-1')], next: 23 }];
    await b.readJobs('sub-jobs');
    await b.readJobs('someone-elses');
    expect(server.of(/\/ack$/).filter((h) => h.path.includes('/jobs/')).map((h) => h.path)).toEqual(['/v1/events/jobs/job-5/ack', '/v1/events/jobs/job-6/ack']);
    expect(server.of(/subscriptions\/sub-jobs\/ack$/).map((h) => (h.body as { cursor: number }).cursor)).toEqual([23]);
    await until(() => server.of(/done$/).length === 2);
  });
});
