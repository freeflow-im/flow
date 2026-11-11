// Wake jobs and schedules (platform.md §5.2, phase 2.4): a publish that matches a wake subscription files a job and its
// `agent.job` event and queues its check; loop safety (self, the depth cap, the owner told once); a post subscription
// posts; the job's states and the queue's check (deliver again, park); schedules' ticks from the alarm; the consumer.
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_EVENT_DEPTH, type AgentJobEventData } from '@flow/shared';
import { EventsCore, JOB_LEASE_MS, renderTemplate, type PublishInput } from './core';
import { Events, type JobMessage } from './object';
import { handleJobBatch } from './queue';

function sqlite() {
  const db = new DatabaseSync(':memory:');
  return {
    exec(query: string, ...args: unknown[]) {
      const stmt = db.prepare(query);
      const rows = stmt.columns().length ? stmt.all(...(args as never[])) : (stmt.run(...(args as never[])), []);
      return { toArray: () => rows as Record<string, unknown>[] };
    },
  };
}

const ORG = 'org-1';
const BOB = 'acct-bob';
const BOT = 'acct-bot';
const ev = (type: string, extra: Partial<PublishInput> = {}): PublishInput =>
  ({ type, organizationId: ORG, actor: 'acct-ann', audience: 'org', channelId: 'general', ts: new Date().toISOString(), data: { body: 'hi' }, ...extra });

/** An Events object over node:sqlite, with a stand-in Org object and Queue that record what they are asked. */
function harness() {
  const sql = sqlite();
  const alarms: number[] = [];
  const sent: { body: JobMessage; delaySeconds?: number }[] = [];
  const posts: unknown[] = [];
  const notices: unknown[] = [];
  const org = {
    privateChannelIdsOfAccounts: async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, []])),
    agentAccountIds: async () => [BOT],
    postAutomation: async (p: unknown) => { posts.push(p); return 'm1'; },
    automationNotice: async (p: unknown) => { notices.push(p); },
    pokeSubscription: async () => 0,
  };
  const env = {
    ORG: { idFromName: (n: string) => n, get: () => org },
    JOBS: { send: async (body: JobMessage, opts?: { delaySeconds?: number }) => { sent.push({ body, ...opts }); } },
    JOBS_ACK_DELAY_SECONDS: '2',
  };
  const storage = { sql, transactionSync: <T>(fn: () => T) => fn(), getAlarm: async () => alarms.at(-1) ?? null, setAlarm: async (t: number) => { alarms.push(t); } };
  const o = new Events({ storage, waitUntil: () => undefined } as never, env as never);
  return { o, alarms, sent, posts, notices };
}

const wakeSub = (o: Events, extra: Record<string, unknown> = {}) => o.createSubscription({
  name: 'summaries', consumer: BOT, owner: BOB, createdBy: BOB, delivery: 'wake', filter: { types: ['chat.message.created'], channelId: 'general' },
  action: { kind: 'wake', prompt: 'Summarize: {{data}} ({{type}} in {{channel}} by {{actor}})' }, ...extra,
});

afterEach(() => vi.restoreAllMocks());

describe('wake subscriptions', () => {
  it('file a job, publish its agent.job on the agent, and queue its check', async () => {
    const h = harness();
    const sub = await wakeSub(h.o);
    await h.o.publish(ev('chat.message.created'));
    await h.o.publish(ev('chat.message.created', { channelId: 'random' }));
    await h.o.settled();
    const jobs = h.o.listJobs(sub.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ agent: BOT, state: 'delivered', attempts: 0, depth: 1, eventSeq: 1, prompt: 'Summarize: {"body":"hi"} (chat.message.created in general by acct-ann)' });
    const read = await h.o.read({ since: 0, types: ['agent.job'] }, { accountId: BOT, channelIds: [] });
    expect(read.events).toHaveLength(1);
    const job = read.events[0]!;
    expect(job).toMatchObject({ causedBy: jobs[0]!.id, depth: 1, actor: null, ref: { app: 'events', kind: 'job', id: jobs[0]!.id } });
    expect((job.data as AgentJobEventData)).toMatchObject({ jobId: jobs[0]!.id, subscriptionId: sub.id, event: { seq: 1, type: 'chat.message.created', channelId: 'general' } });
    // Only the agent sees it.
    expect((await h.o.read({ since: 0, types: ['agent.job'] }, { accountId: BOB, channelIds: [] })).events).toHaveLength(0);
    expect(h.sent).toEqual([{ body: { organizationId: ORG, jobId: jobs[0]!.id, check: 'ack' }, delaySeconds: 2 }]);
    expect(h.o.getSubscription(sub.id)!.cursor).toBeGreaterThanOrEqual(2);
  });

  it('skip what the agent itself caused unless the action opts in, and stop at the depth cap, telling the owner once', async () => {
    const h = harness();
    const sub = await wakeSub(h.o);
    await h.o.publish(ev('chat.message.created', { actor: BOT }));
    await h.o.publish(ev('chat.message.created', { depth: MAX_EVENT_DEPTH }));
    await h.o.publish(ev('chat.message.created', { depth: MAX_EVENT_DEPTH + 1 }));
    await h.o.settled();
    expect(h.o.listJobs(sub.id)).toHaveLength(0);
    expect(h.notices).toEqual([{ ownerAccountId: BOB, agentAccountId: BOT, name: 'summaries', why: 'capped' }]);
    const selfish = await wakeSub(h.o, { action: { kind: 'wake', prompt: 'p', includeSelf: true } });
    await h.o.publish(ev('chat.message.created', { actor: BOT, depth: 2 }));
    await h.o.settled();
    expect(h.o.listJobs(selfish.id)).toMatchObject([{ depth: 3 }]);
  });

  it('read as the owner: a private channel the owner is not in wakes nothing', async () => {
    const h = harness();
    const sub = await wakeSub(h.o, { filter: { types: ['chat.message.created'] } });
    await h.o.publish(ev('chat.message.created', { channelId: 'secret', audience: 'channel:secret' }));
    await h.o.settled();
    expect(h.o.listJobs(sub.id)).toHaveLength(0);
  });
});

describe('post subscriptions', () => {
  it('ask the Org object to post as the owner, once per event, one deeper', async () => {
    const h = harness();
    await h.o.createSubscription({ name: 'echo', consumer: BOB, owner: BOB, createdBy: BOB, delivery: 'post', filter: { types: ['chat.reaction.added'] }, action: { kind: 'post', channelId: 'general', body: 'reacted: {{data}}' } });
    const { id } = await h.o.publish(ev('chat.reaction.added', { depth: 1 }));
    await h.o.settled();
    expect(h.posts).toEqual([{ ownerAccountId: BOB, channelId: 'general', body: 'reacted: {"body":"hi"}', clientMsgId: expect.stringContaining(id), depth: 2 }]);
  });
});

describe('a job', () => {
  it('goes delivered → running → done for its agent alone, with a lease that extends', async () => {
    const h = harness();
    const sub = await wakeSub(h.o);
    await h.o.publish(ev('chat.message.created'));
    await h.o.settled();
    const [job] = h.o.listJobs(sub.id);
    expect(h.o.jobStep(job!.id, BOB, 'ack')).toBeNull();
    const t0 = Date.now();
    const acked = h.o.jobStep(job!.id, BOT, 'ack') as { state: string; leaseUntil: string };
    expect(acked.state).toBe('running');
    expect(Date.parse(acked.leaseUntil)).toBeGreaterThanOrEqual(t0 + JOB_LEASE_MS - 1000);
    expect(h.o.jobStep(job!.id, BOT, 'extend')).toMatchObject({ state: 'running' });
    expect(h.o.jobDepth(job!.id, BOT)).toBe(1);
    expect(h.o.jobDepth(job!.id, BOB)).toBeNull();
    expect(h.o.jobStep(job!.id, BOT, 'done', { ok: true, note: 'summarized' })).toMatchObject({ state: 'done', note: 'summarized' });
    expect(h.o.jobStep(job!.id, BOT, 'extend')).toEqual({ conflict: 'done' });
    expect(await h.o.checkJob(job!.id)).toEqual({ ack: true });
  });

  it('not acked in time is delivered again with a growing delay, then parked and the owner told', async () => {
    const h = harness();
    const sub = await wakeSub(h.o);
    await h.o.publish(ev('chat.message.created'));
    await h.o.settled();
    const [job] = h.o.listJobs(sub.id);
    const answers = [];
    for (let i = 0; i < 4; i++) answers.push(await h.o.checkJob(job!.id));
    expect(answers).toEqual([{ retryAfter: 120 }, { retryAfter: 240 }, { retryAfter: 360 }, { ack: true }]);
    const deliveries = (await h.o.read({ since: 0, types: ['agent.job'] }, { accountId: BOT, channelIds: [] })).events;
    expect(deliveries.map((e) => (e.data as AgentJobEventData).jobId)).toEqual(Array(4).fill(job!.id));
    expect(new Set(deliveries.map((e) => e.id)).size).toBe(4);
    expect(h.o.getJob(job!.id)).toMatchObject({ state: 'parked', attempts: 3 });
    expect(h.notices).toEqual([{ ownerAccountId: BOB, agentAccountId: BOT, name: 'summaries', why: 'parked' }]);
  });

  it('running is checked again when its lease ends, and delivered again once it lapses', () => {
    const core = new EventsCore(sqlite());
    const sub = core.createSubscription({ name: 's', consumer: BOT, owner: BOB, createdBy: BOB, delivery: 'wake', filter: {}, action: { kind: 'wake', prompt: 'p' } });
    core.publish(ev('chat.x'));
    const { job } = core.wake(sub, core.read({ since: 0 }, { accountId: BOB, channelIds: [] }).events[0]!, 1_000);
    core.jobStep(job.id, BOT, 'ack', {}, 1_000);
    expect(core.checkJob(job.id, 61_000)).toEqual({ kind: 'later', delayS: Math.ceil((1_000 + JOB_LEASE_MS - 61_000) / 1000) + 1 });
    expect(core.checkJob(job.id, 1_000 + JOB_LEASE_MS + 1)).toMatchObject({ kind: 'redeliver', delayS: 120, job: { state: 'delivered', attempts: 1, note: 'delivered again: its lease lapsed' } });
  });
});

describe('templates', () => {
  it('fill the five placeholders', () => {
    const e = { id: 'e', seq: 1, type: 't.x', organizationId: ORG, actor: null, depth: 0, ts: '', data: [1], ref: { organizationId: ORG, app: 'a', kind: 'k', id: 'i' } };
    expect(renderTemplate('{{type}}|{{ ref }}|{{channel}}|{{actor}}|{{data}}|{{other}}', e)).toBe(`t.x|${ORG}/a/k/i|||[1]|{{other}}`);
  });
});

describe('schedules', () => {
  it('force the filter, arm the alarm for the next tick, and tick from the alarm on the owner', async () => {
    const h = harness();
    const sub = await h.o.createSubscription({
      name: 'hourly digest', consumer: BOT, owner: BOB, createdBy: BOB, delivery: 'wake', filter: { types: ['chat.*'] }, organizationId: ORG,
      action: { kind: 'wake', prompt: 'Digest at {{data}}' }, schedule: { every: 'hourly', timezone: 'UTC' },
    });
    expect(sub.filter).toEqual({ types: ['schedule.tick'], ref: { organizationId: ORG, app: 'events', kind: 'schedule', id: sub.schedule!.id } });
    const next = Date.parse(sub.schedule!.nextAt);
    expect(next - Date.now()).toBeLessThanOrEqual(3_600_000);
    expect(h.alarms.at(-1)).toBe(next);
    vi.spyOn(Date, 'now').mockReturnValue(next + 5);
    await h.o.alarm();
    await h.o.settled();
    const ticks = (await h.o.read({ since: 0, types: ['schedule.tick'] }, { accountId: BOB, channelIds: [] })).events;
    expect(ticks).toHaveLength(1);
    expect(ticks[0]).toMatchObject({ actor: null, ref: { kind: 'schedule', id: sub.schedule!.id }, data: { subscriptionId: sub.id, at: new Date(next).toISOString() } });
    expect(h.o.listJobs(sub.id)).toMatchObject([{ state: 'delivered', prompt: expect.stringContaining('"every":"hourly"') }]);
    const after = h.o.getSubscription(sub.id)!.schedule!;
    expect(Date.parse(after.nextAt)).toBe(next + 3_600_000);
    expect(h.alarms.at(-1)).toBe(next + 3_600_000);
  });
});

describe('the flow-jobs consumer', () => {
  it('retries, requeues or acks each message as the check says', async () => {
    const answers: Record<string, unknown> = { a: { retryAfter: 120 }, b: { requeueAfter: 30 }, c: { ack: true } };
    const events = { idFromName: (n: string) => n, get: () => ({ checkJob: async (id: string) => { if (id === 'd') throw new Error('boom'); return answers[id]; } }) };
    const sent: unknown[] = [];
    const did: string[] = [];
    const msg = (jobId: string) => ({ body: { organizationId: ORG, jobId, check: 'ack' }, ack: () => did.push(`${jobId}:ack`), retry: (o?: { delaySeconds?: number }) => did.push(`${jobId}:retry${o?.delaySeconds ?? ''}`) });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await handleJobBatch({ messages: ['a', 'b', 'c', 'd'].map(msg) } as never, { EVENTS: events as never, JOBS: { send: async (b: unknown, o: unknown) => { sent.push([b, o]); } } as never });
    expect(did).toEqual(['a:retry120', 'b:ack', 'c:ack', 'd:retry']);
    expect(sent).toEqual([[{ organizationId: ORG, jobId: 'b', check: 'ack' }, { delaySeconds: 30 }]]);
  });

  it('hands a hosted agent’s job to its runtime at once, and never an external agent’s (agents.md §6)', async () => {
    const woken: { key: string; job: string; runtime: string }[] = [];
    const asked: string[] = [];
    const runtimeOf: Record<string, unknown> = { 'acct-omni': { runtimeKey: 'acct-omni', agentId: 'omni', agentAccountId: 'acct-omni', mode: 'shared', organizationId: ORG, sponsorId: 'ann', sponsorAccountId: 'acct-ann' }, [BOT]: null };
    const env = {
      DIRECTORY: { idFromName: (n: string) => n, get: () => ({ call: async (_m: string, args: unknown[]) => { asked.push(args[0] as string); return { ok: true, value: runtimeOf[args[0] as string] ?? null }; } }) },
      ASSISTANT: { idFromName: (n: string) => n, get: (key: string) => ({ wake: async (p: { job: { id: string }; runtime: { agentId: string } }) => { woken.push({ key, job: p.job.id, runtime: p.runtime.agentId }); } }) },
    };
    const storage = { sql: sqlite(), transactionSync: <T>(fn: () => T) => fn(), getAlarm: async () => null, setAlarm: async () => undefined };
    const o = new Events({ storage, waitUntil: () => undefined } as never, { ...env, ORG: { idFromName: (n: string) => n, get: () => ({ privateChannelIdsOfAccounts: async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, []])), agentAccountIds: async () => [BOT, 'acct-omni'], pokeSubscription: async () => 0 }) } } as never);
    await o.createSubscription({ name: 'omni', consumer: 'acct-omni', owner: 'acct-ann', filter: { types: ['chat.*'] }, delivery: 'wake', createdBy: 'acct-ann', action: { kind: 'wake', prompt: 'p' } });
    await o.createSubscription({ name: 'bot', consumer: BOT, owner: BOB, filter: { types: ['chat.*'] }, delivery: 'wake', createdBy: BOB, action: { kind: 'wake', prompt: 'p' } });
    await o.publish(ev('chat.message.created'));
    await new Promise((r) => setTimeout(r, 20));
    expect(woken).toEqual([{ key: 'acct-omni', job: expect.any(String), runtime: 'omni' }]);
    // The directory is asked once per consumer.
    await o.publish(ev('chat.message.created'));
    await new Promise((r) => setTimeout(r, 20));
    expect(woken).toHaveLength(2);
    expect(asked.sort()).toEqual(['acct-omni', BOT].sort());
  });
});
