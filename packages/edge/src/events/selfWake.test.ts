// Agents that wake themselves (docs/specs/agent-self-wake.md): a one-time schedule that wakes its own agent in the thread
// it was set from, then is spent; the limits (how soon, how far, how many waiting, how many a day); a wake whose agent is
// gone; the sweep of spent ones; and the operations and tools an agent uses (wakesAs, WAKE_TOOLS).
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SELF_WAKE_KEEP_MS, SELF_WAKE_MAX_PENDING, SELF_WAKE_MAX_PER_DAY, type AgentJobEventData, type SubscriptionDTO } from '@flow/shared';
import { Events, type JobMessage } from './object';
import { wakesAs } from './subscriptions';
import { EventToolError, WAKE_TOOLS } from './eventTools';

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
const ANN = 'acct-ann';
const BOT = 'acct-bot';
const MIN = 60_000;

function harness(opts: { agentGone?: boolean } = {}) {
  const sql = sqlite();
  const alarms: number[] = [];
  const notices: { why: string; ownerAccountId: string; agentAccountId: string | null }[] = [];
  const org = {
    privateChannelIdsOfAccounts: async (ids: string[]) => Object.fromEntries(ids.map((id) => [id, []])),
    agentAccountIds: async () => [BOT],
    agentSponsorOf: async () => (opts.agentGone ? null : { userId: 'u-bot', sponsorUserId: 'u-ann', personal: false }),
    postAutomation: async () => 'm1',
    automationNotice: async (p: { why: string; ownerAccountId: string; agentAccountId: string | null }) => { notices.push(p); },
    pokeSubscription: async () => 0,
  };
  const env = {
    ORG: { idFromName: (n: string) => n, get: () => org },
    JOBS: { send: async (_b: JobMessage) => undefined },
  };
  const storage = { sql, transactionSync: <T>(fn: () => T) => fn(), getAlarm: async () => alarms.at(-1) ?? null, setAlarm: async (t: number) => { alarms.push(t); } };
  const o = new Events({ storage, waitUntil: () => undefined } as never, env as never);
  return { o, alarms, notices };
}

const wake = (o: Events, at: number, extra: Record<string, unknown> = {}) => o.scheduleSelfWake({
  name: 'check the deploy', agent: BOT, owner: ANN, prompt: 'Is the deploy green?', at, channelId: 'general', threadRootId: 'm-root', organizationId: ORG, ...extra,
});

afterEach(() => vi.restoreAllMocks());

describe('a self-wake', () => {
  it('fires once at its time, wakes its agent in its thread, and is then spent', async () => {
    const h = harness();
    const now = Date.now();
    const at = now + 5 * MIN;
    const sub = (await wake(h.o, at)) as SubscriptionDTO;
    expect(sub).toMatchObject({ consumer: BOT, owner: ANN, createdBy: BOT, delivery: 'wake', schedule: { every: 'once', nextAt: new Date(at).toISOString() } });
    expect(sub.action).toEqual({ kind: 'wake', prompt: 'Is the deploy green?', channelId: 'general', threadRootId: 'm-root' });
    expect(h.alarms.at(-1)).toBe(at);
    expect(h.o.selfWakes(BOT).map((s) => s.id)).toEqual([sub.id]);
    // The sponsor sees it among their automations.
    expect(h.o.listSubscriptions(ANN).map((s) => s.id)).toEqual([sub.id]);

    vi.spyOn(Date, 'now').mockReturnValue(at + 5);
    await h.o.alarm();
    await h.o.settled();
    const jobs = h.o.listJobs(sub.id);
    expect(jobs).toMatchObject([{ agent: BOT, channelId: 'general', threadRootId: 'm-root', prompt: 'Is the deploy green?', state: 'delivered' }]);
    const job = (await h.o.read({ since: 0, types: ['agent.job'] }, { accountId: BOT, channelIds: [] })).events[0]!;
    const data = job.data as AgentJobEventData;
    expect(data).toMatchObject({ channelId: 'general', threadRootId: 'm-root' });
    expect(data.prompt).toMatch(/^You asked to be woken now \("check the deploy", for /);
    expect(data.prompt).toContain('Your note to yourself:\nIs the deploy green?');
    expect(data.prompt).toContain('posted in that thread (channel general, thread m-root)');

    // Spent: no longer waiting or listed, the schedule gone, the job still there to list; the alarm moves on.
    expect(h.o.selfWakes(BOT)).toEqual([]);
    expect(h.o.listSubscriptions(ANN)).toEqual([]);
    expect(h.o.getSubscription(sub.id)!.schedule).toBeUndefined();
    expect(h.alarms.at(-1)).not.toBe(at);

    // A second alarm does not fire it again.
    await h.o.alarm();
    await h.o.settled();
    expect(h.o.listJobs(sub.id)).toHaveLength(1);
  });

  it('is refused too soon, too far ahead, or past the number waiting', async () => {
    const h = harness();
    const now = Date.now();
    expect(await wake(h.o, now + 30_000)).toMatchObject({ refused: 'wake_too_soon' });
    expect(await wake(h.o, now + 366 * 86_400_000)).toMatchObject({ refused: 'wake_too_far' });
    for (let i = 0; i < SELF_WAKE_MAX_PENDING; i++) expect(await wake(h.o, now + (i + 2) * MIN)).toHaveProperty('id');
    expect(await wake(h.o, now + 60 * MIN)).toMatchObject({ refused: 'too_many_wakes' });
    expect(h.o.selfWakes(BOT)).toHaveLength(SELF_WAKE_MAX_PENDING);
  });

  it('is dropped past the daily cap, and the owner told once that day', async () => {
    const h = harness();
    const now = Date.now();
    const a = (await wake(h.o, now + 2 * MIN)) as SubscriptionDTO;
    const b = (await wake(h.o, now + 3 * MIN)) as SubscriptionDTO;
    // The agent has already been woken the most a day allows.
    const day = new Date(now + 3 * MIN).toISOString().slice(0, 10);
    (h.o as unknown as { core: { setMeta(k: string, v: string): void } }).core.setMeta(`self_wake:${day}:${BOT}`, String(SELF_WAKE_MAX_PER_DAY));
    vi.spyOn(Date, 'now').mockReturnValue(now + 3 * MIN + 5);
    await h.o.alarm();
    await h.o.settled();
    expect(h.o.listJobs(a.id)).toEqual([]);
    expect(h.o.listJobs(b.id)).toEqual([]);
    expect(h.o.selfWakes(BOT)).toEqual([]);
    expect(h.notices).toEqual([expect.objectContaining({ why: 'daily', ownerAccountId: ANN, agentAccountId: BOT })]);
  });

  it('is deleted, not filed, when its agent is gone', async () => {
    const h = harness({ agentGone: true });
    const now = Date.now();
    const sub = (await wake(h.o, now + 2 * MIN)) as SubscriptionDTO;
    vi.spyOn(Date, 'now').mockReturnValue(now + 2 * MIN + 5);
    await h.o.alarm();
    await h.o.settled();
    expect(h.o.getSubscription(sub.id)).toBeNull();
  });

  it('is swept a week after it fired', async () => {
    const h = harness();
    const now = Date.now();
    const sub = (await wake(h.o, now + 2 * MIN)) as SubscriptionDTO;
    vi.spyOn(Date, 'now').mockReturnValue(now + 2 * MIN + 5);
    await h.o.alarm();
    await h.o.settled();
    expect(h.o.listJobs(sub.id)).toHaveLength(1);
    (h.o as unknown as { core: { retain(now: number): unknown } }).core.retain(now + 2 * MIN + SELF_WAKE_KEEP_MS + 10);
    expect(h.o.getSubscription(sub.id)).toBeNull();
    expect(h.o.listJobs(sub.id)).toEqual([]);
  });
});

describe('wakesAs', () => {
  const NOW = Date.parse('2026-11-20T18:00:00Z');
  function ops(opts: { agent?: 'shared' | 'personal' | null; place?: { channelId: string; threadRootId: string | null } | null; channels?: string[] } = {}) {
    const h = harness();
    const kind = opts.agent === undefined ? 'shared' : opts.agent;
    const org = {
      selfWakeOwnerOf: async () => (kind ? { ownerAccountId: ANN, agentUserId: 'u-bot', channelUserId: kind === 'personal' ? 'u-ann' : 'u-bot', personal: kind === 'personal' } : null),
      channelIdsOf: async () => opts.channels ?? ['general'],
      sponsorDmOf: async () => 'dm-ann',
    };
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    const w = wakesAs(h.o as never, org as never, { agentAccountId: BOT, organizationId: ORG, place: () => opts.place ?? null, now: () => NOW });
    return { h, w };
  }

  it('answers where the turn runs, in its thread, by default', async () => {
    const { w } = ops({ place: { channelId: 'random', threadRootId: 'm-9' } });
    const made = await w.schedule({ prompt: 'Look again', inMinutes: 20 });
    expect(made).toMatchObject({ prompt: 'Look again', name: 'Look again', at: new Date(NOW + 20 * MIN).toISOString(), channelId: 'random', threadRootId: 'm-9' });
    expect(await w.list()).toEqual([made]);
  });

  it('takes an ISO time with its offset, and a channel the agent is in', async () => {
    const { w } = ops({ place: { channelId: 'random', threadRootId: null } });
    const made = await w.schedule({ prompt: 'Remind Ann', at: '2026-11-21T09:00:00-08:00', channelId: 'general' });
    expect(made).toMatchObject({ at: '2026-11-21T17:00:00.000Z', channelId: 'general' });
    expect(made.threadRootId).toBeUndefined();
    await expect(w.schedule({ prompt: 'x', inMinutes: 5, channelId: 'secret' })).rejects.toMatchObject({ code: 'bad_wake' });
  });

  it('uses a person’s assistant’s DM with its sponsor when the turn has no channel; a shared agent must name one', async () => {
    expect(await ops({ agent: 'personal' }).w.schedule({ prompt: 'Ping me', inMinutes: 5 })).toMatchObject({ channelId: 'dm-ann' });
    await expect(ops({ agent: 'shared' }).w.schedule({ prompt: 'Ping', inMinutes: 5 })).rejects.toMatchObject({ code: 'bad_wake' });
  });

  it('refuses a caller that is no agent, and bad times', async () => {
    await expect(ops({ agent: null }).w.schedule({ prompt: 'x', inMinutes: 5 })).rejects.toMatchObject({ code: 'not_an_agent' });
    const { w } = ops({ place: { channelId: 'general', threadRootId: null } });
    await expect(w.schedule({ prompt: 'x' })).rejects.toMatchObject({ code: 'bad_wake' });
    await expect(w.schedule({ prompt: 'x', inMinutes: 5, at: '2026-11-21T09:00:00Z' })).rejects.toMatchObject({ code: 'bad_wake' });
    await expect(w.schedule({ prompt: 'x', at: 'tomorrow' })).rejects.toMatchObject({ code: 'bad_wake' });
    await expect(w.schedule({ prompt: 'x', at: '2026-11-20T18:00:30Z' })).rejects.toMatchObject({ code: 'wake_too_soon' });
  });

  it('cancels only the agent’s own waiting wakes', async () => {
    const { h, w } = ops({ place: { channelId: 'general', threadRootId: null } });
    const made = await w.schedule({ prompt: 'Later', inMinutes: 10 });
    const other = await h.o.createSubscription({ name: 'not a wake', consumer: BOT, owner: ANN, createdBy: ANN, filter: {}, delivery: 'pull' });
    expect(await w.cancel(other.id)).toBe(false);
    expect(await w.cancel(made.id)).toBe(true);
    expect(await w.list()).toEqual([]);
    expect(h.o.getSubscription(other.id)).not.toBeNull();
  });
});

describe('the wake tools', () => {
  const tool = (name: string) => WAKE_TOOLS.find((t) => t.name === name)!;

  it('pass the input through and say why a wake was refused', async () => {
    const seen: unknown[] = [];
    const wakes = {
      schedule: async (w: unknown) => { seen.push(w); if ((w as { inMinutes?: number }).inMinutes === 99) throw Object.assign(new Error('You already have 10 wakes waiting.'), { code: 'too_many_wakes' }); return { id: 'w1', name: 'n', prompt: 'p', at: 'a' }; },
      list: async () => [],
      cancel: async (id: string) => id === 'w1',
    };
    expect(await tool('schedule_wake').run({ wakes }, { prompt: 'p', in_minutes: 5, threadRootId: 't' })).toEqual({ wake: { id: 'w1', name: 'n', prompt: 'p', at: 'a' } });
    expect(seen[0]).toEqual({ prompt: 'p', inMinutes: 5, threadRootId: 't' });
    await expect(tool('schedule_wake').run({ wakes }, { prompt: 'p', in_minutes: 99 })).rejects.toBeInstanceOf(EventToolError);
    expect(await tool('cancel_wake').run({ wakes }, { wake_id: 'w1' })).toEqual({ cancelled: true });
    await expect(tool('cancel_wake').run({ wakes }, { wake_id: 'w2' })).rejects.toBeInstanceOf(EventToolError);
  });
});
