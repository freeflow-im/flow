// Catching up after being offline (platform.md §5.2, phase 2.3): the bridge's subscription is made once, read page by
// page before the socket opens, each page acked, each event fed through the live path, and a message answered before a
// restart is not answered again. Against a fake server speaking the subscription routes, in the style of routing.test.ts.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelDTO, MessageDTO, PlatformEvent, SubscriptionDTO } from '@flow/shared';
import { AgentBridge } from '../src/bridge.js';
import { CATCH_UP_TYPES, HandledMessages } from '../src/catch-up.js';
import { stateFileFor, type BridgeConfig } from '../src/config.js';
import { socketEventOf } from '../src/gateway.js';

const AGENT = 'aaaaaaaa-0000-0000-0000-000000000001';
const HUMAN = 'bbbbbbbb-0000-0000-0000-000000000002';
const ORG = 'ws-1';

/** The subscription routes of an edge server, over one organization's log. */
class FakeServer {
  subs: SubscriptionDTO[] = [];
  /** What each read answers, in turn; then empty reads at the last `next`. */
  pages: { events: PlatformEvent[]; next: number }[] = [];
  acks: number[] = [];
  reads: string[] = [];
  private last = 0;
  private server = http.createServer((req, res) => void this.handle(req, res));
  url = '';

  async start(): Promise<void> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  stop(): Promise<void> {
    return new Promise((r) => this.server.close(() => r()));
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const u = new URL(req.url!, 'http://x');
    let body = '';
    for await (const chunk of req) body += chunk;
    const json = (status: number, j: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(j)); };
    if (u.searchParams.get('workspace') !== ORG) return json(400, { error: { code: 'bad', message: 'workspace' } });
    if (req.method === 'GET' && u.pathname === '/v1/events/subscriptions') return json(200, { subscriptions: this.subs });
    if (req.method === 'POST' && u.pathname === '/v1/events/subscriptions') {
      const b = JSON.parse(body);
      const sub = { id: `sub-${this.subs.length + 1}`, consumer: 'acct', owner: 'acct', cursor: 10, createdBy: 'acct', createdAt: '', ...b } as SubscriptionDTO;
      this.subs.push(sub);
      return json(201, { subscription: sub });
    }
    const m = /^\/v1\/events\/subscriptions\/([^/]+)(\/ack)?$/.exec(u.pathname);
    const sub = m && this.subs.find((s) => s.id === m[1]);
    if (!sub) return json(404, { error: { code: 'not_found', message: 'no such subscription' } });
    if (m[2]) {
      const { cursor } = JSON.parse(body) as { cursor: number };
      this.acks.push(cursor);
      sub.cursor = Math.max(sub.cursor, cursor);
      return json(200, { cursor: sub.cursor });
    }
    this.reads.push(u.search);
    const page = this.pages.shift() ?? { events: [], next: Math.max(this.last, sub.cursor) };
    this.last = page.next;
    return json(200, page);
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
function message(id: string, body: string): MessageDTO {
  return { id, channelId: 'chan-1', userId: HUMAN, threadRootId: null, clientMsgId: id, body, systemKind: null, deletedAt: null, files: [], reactions: [], createdAt: '2026-11-06T00:00:00Z' } as unknown as MessageDTO;
}
let seq = 10;
const logged = (type: string, data: unknown): PlatformEvent =>
  ({ id: `e${++seq}`, seq, type, organizationId: ORG, actor: 'acct-human', channelId: 'chan-1', depth: 0, ts: '2026-11-06T00:00:00Z', data });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function bridge(cfg = config()): any {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const b = new AgentBridge(cfg) as any;
  b.me = { id: AGENT, isAgent: true, displayName: 'Omni' };
  b.workspace = { id: ORG, name: 'QA Lab' };
  b.channels = new Map([[channel.id, channel]]);
  b.members = new Map([[HUMAN, { userId: HUMAN, displayName: 'Alice', isAgent: false }]]);
  b.lines = [] as string[];
  b.log = (m: string) => b.lines.push(m);
  b.enqueue = vi.fn();
  return b;
}

let server: FakeServer;
let dir: string;
beforeEach(async () => {
  server = new FakeServer();
  await server.start();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-catch-up-'));
  seq = 10;
});
afterEach(async () => {
  await server.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('the bridge catches up from its subscription', () => {
  it('makes its subscription once, then finds it by name', async () => {
    const b = bridge();
    expect(await b.catchUp()).toBe(10);
    expect(server.subs).toHaveLength(1);
    expect(server.subs[0]).toMatchObject({ name: `bridge:${AGENT}`, filter: { types: CATCH_UP_TYPES }, delivery: 'pull' });
    await bridge().catchUp();
    expect(server.subs).toHaveLength(1);
    expect(b.lines).toContain('caught up: 0 events, answered 0');
  });

  it('reads without waiting until empty, acks each page, and answers what is addressed to it', async () => {
    server.subs.push({ id: 'sub-1', name: `bridge:${AGENT}`, consumer: 'acct', owner: 'acct', filter: { types: CATCH_UP_TYPES }, delivery: 'pull', cursor: 10, createdBy: 'acct', createdAt: '' });
    const mention = message('m-1', `<@${AGENT}> are you there?`);
    server.pages = [
      { events: [logged('chat.message.created', mention), logged('chat.message.created', message('m-2', 'not for you'))], next: 12 },
      { events: [logged('docs.file.updated', { title: 'x' }), logged('chat.reaction.added', { messageId: 'm-2', channelId: 'chan-1', emoji: '👍', userId: HUMAN })], next: 15 },
    ];
    const b = bridge();
    expect(await b.catchUp()).toBe(15);
    expect(server.reads.every((q) => q.includes('wait=0'))).toBe(true);
    expect(server.reads).toHaveLength(3);
    expect(server.acks).toEqual([12, 15]);
    expect(b.enqueue).toHaveBeenCalledTimes(1);
    expect(b.enqueue.mock.calls[0][0].id).toBe('m-1');
    expect(b.lines).toContain('caught up: 3 events, answered 1');
    // The socket's cursor is acked as it moves, and not again when it has not.
    b.latestCursor = 20;
    await b.ackCursor();
    await b.ackCursor();
    expect(server.acks).toEqual([12, 15, 20]);
  });

  it('does not answer a message twice across a restart', async () => {
    const stateFile = path.join(dir, 'state.json');
    server.subs.push({ id: 'sub-1', name: `bridge:${AGENT}`, consumer: 'acct', owner: 'acct', filter: {}, delivery: 'pull', cursor: 10, createdBy: 'acct', createdAt: '' });
    const mention = logged('chat.message.created', message('m-1', `<@${AGENT}> hi`));
    // Answered live, then the bridge stopped before acking: the next start reads it again.
    const first = bridge(config({ stateFile }));
    await first.handleEvent(socketEventOf(mention)!);
    expect(first.enqueue).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fs.readFileSync(stateFile, 'utf8')).handledMessageIds).toEqual(['m-1']);
    server.pages = [{ events: [mention, logged('chat.message.created', message('m-3', `<@${AGENT}> and this`))], next: 12 }];
    const second = bridge(config({ stateFile }));
    await second.catchUp();
    expect(second.enqueue).toHaveBeenCalledTimes(1);
    expect(second.enqueue.mock.calls[0][0].id).toBe('m-3');
    expect(second.lines).toContain('caught up: 2 events, answered 1');
  });

  it('keeps an older server on live events alone', async () => {
    const b = bridge(config({ serverUrl: 'http://127.0.0.1:9' }));
    expect(await b.catchUp()).toBeNull();
    expect(b.lines.some((l: string) => l.startsWith('no event subscription'))).toBe(true);
  });
});

describe('pieces', () => {
  it('turns a logged Chat event back into the socket event, and nothing else', () => {
    const e = logged('chat.thread.reply', { id: 'r' });
    expect(socketEventOf(e)).toEqual({ type: 'thread.reply', workspaceId: ORG, channelId: 'chan-1', ts: e.ts, data: { id: 'r' } });
    expect(socketEventOf(logged('mail.received', {}))).toBeNull();
  });

  it('remembers the last 500 answered ids in the state file', () => {
    const file = path.join(dir, 'state.json');
    const h = new HandledMessages(file);
    for (let i = 0; i < 510; i++) h.add(`m-${i}`);
    expect(h.add('m-509')).toBe(false);
    const again = new HandledMessages(file);
    expect(again.has('m-9')).toBe(false);
    expect(again.has('m-10')).toBe(true);
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).handledMessageIds).toHaveLength(500);
  });

  it('puts the state file beside the config', () => {
    expect(stateFileFor('/x/agent.json')).toBe('/x/state.json');
    expect(stateFileFor('/x/second.json')).toBe('/x/second.state.json');
  });
});

describe('the socket as a consumer', () => {
  it('sends since, skips a replay at or below its cursor, and reconnects from the latest cursor', async () => {
    const { WebSocketServer } = await import('ws');
    const { FlowSocket } = await import('../src/gateway.js');
    const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise<void>((r) => wss.once('listening', () => r()));
    const auths: Record<string, unknown>[] = [];
    wss.on('connection', (ws) => {
      ws.once('message', (raw) => {
        auths.push(JSON.parse(String(raw)));
        ws.send(JSON.stringify({ op: 'hello', sessionId: 's' }));
        if (auths.length > 1) return;
        for (const s of [15, 16]) ws.send(JSON.stringify({ op: 'event', seq: s, event: { type: 'message.created', workspaceId: ORG, ts: '', data: { s } } }));
        ws.send(JSON.stringify({ op: 'cursor', seq: 17 }));
        setTimeout(() => ws.close(), 50);
      });
    });
    const got: unknown[] = [];
    const cursors: number[] = [];
    const sock = new FlowSocket({
      serverUrl: `http://127.0.0.1:${(wss.address() as AddressInfo).port}`, token: 't', since: 15,
      onEvent: (e) => got.push(e.data), onCursor: (s) => cursors.push(s), log: () => {},
    });
    sock.connect();
    const deadline = Date.now() + 5_000;
    while (auths.length < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    sock.close();
    await new Promise<void>((r) => wss.close(() => r()));
    expect(auths.map((a) => a.since)).toEqual([15, 17]);
    expect(got).toEqual([{ s: 16 }]);
    expect(cursors).toEqual([17]);
  });
});
