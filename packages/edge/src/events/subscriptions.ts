// A subscription's operations as one account in one organization (platform.md §5.2): what the HTTP routes
// (routes/events.ts) and the /mcp tools (eventTools.ts) both do, so the two doors read a queue the same way. The consumer
// is the caller's account, except for a `wake` subscription, whose consumer is an agent the caller sponsors (or any agent,
// for an owner or admin); a subscription the caller neither consumes nor owns is as good as missing (null). The reader is
// the account with the private channels its person is in, read again on every read, so leaving a channel stops its
// events at once. A job is the agent's to ack, extend and finish; its subscription's owner and the agent may list them.
import type { AccountRole, AgentJobDTO, CreateSubscriptionBody, EventFilter, JobState, SubscriptionDTO } from '@flow/shared';
import type { Events } from './object';
import type { Org } from '../org/object';
import type { Reader, SubscriptionRead } from './core';
import { ApiError, badRequest } from '../errors';

export type NewSubscriptionBody = Omit<CreateSubscriptionBody, 'filter'> & { filter?: EventFilter };

export interface SubscriptionOps {
  list(): Promise<SubscriptionDTO[]>;
  create(body: NewSubscriptionBody): Promise<SubscriptionDTO>;
  /** `waitS` long-polls, in seconds (at most 30). */
  read(id: string, limit?: number, waitS?: number): Promise<SubscriptionRead | null>;
  ack(id: string, cursor: number): Promise<number | null>;
  remove(id: string): Promise<boolean>;
  /** A subscription's last 50 jobs, for its owner or its agent; null when it is neither's. */
  jobs(subscriptionId: string): Promise<AgentJobDTO[] | null>;
  /** The agent's side of a job; null for a job that is not the caller's. A 409 `job_state` when its state forbids the step. */
  jobStep(id: string, step: 'ack' | 'extend' | 'done', opts?: { ok?: boolean; note?: string }): Promise<AgentJobDTO | null>;
}

export const agentForbidden = () => new ApiError(403, 'agent_forbidden', "only the agent's sponsor, or an owner or admin of the organization, may make it a wake subscription");

/** `role` is the caller's account role in the organization (from the directory), for the wake check. */
export function subscriptionsAs(
  events: DurableObjectStub<Events>, org: DurableObjectStub<Org>, accountId: string, userId: string, role?: AccountRole | string, organizationId?: string,
): SubscriptionOps {
  const get = async (id: string) => (await events.getSubscription(id)) as SubscriptionDTO | null;
  const mine = async (id: string) => {
    const sub = await get(id);
    return sub && sub.consumer === accountId ? sub : null;
  };
  const readerFor = async (filter: EventFilter): Promise<Reader> => {
    const kind = filter.actorKind === 'person' || filter.actorKind === 'agent';
    const [channelIds, agentAccountIds] = await Promise.all([org.privateChannelIdsOf(userId), kind ? org.agentAccountIds() : Promise.resolve(undefined)]);
    return { accountId, channelIds, ...(agentAccountIds ? { agentAccountIds } : {}) };
  };
  return {
    list: async () => (await events.listSubscriptions(accountId)) as SubscriptionDTO[],
    create: async (body) => {
      let consumer = accountId;
      if (body.delivery === 'wake') {
        consumer = body.consumer!;
        const agent = (await org.agentSponsorOf(consumer)) as { userId: string; sponsorUserId: string | null } | null;
        if (!agent) throw badRequest('not_an_agent', 'consumer is not an agent of this organization');
        if (agent.sponsorUserId !== userId && role !== 'owner' && role !== 'admin') throw agentForbidden();
      }
      try {
        return (await events.createSubscription({
          name: body.name, consumer, owner: accountId, filter: body.filter ?? {}, delivery: body.delivery ?? 'pull', createdBy: accountId,
          ...(body.action ? { action: body.action } : {}),
          ...(body.schedule ? { schedule: { every: body.schedule.every, timezone: body.schedule.timezone ?? 'UTC' } } : {}),
          ...(organizationId ? { organizationId } : {}),
        })) as SubscriptionDTO;
      } catch (err) {
        if (/^bad schedule/.test((err as Error).message)) throw badRequest('bad_schedule', (err as Error).message);
        throw err;
      }
    },
    read: async (id, limit, waitS) => {
      const sub = await mine(id);
      if (!sub) return null;
      return (await events.wait(id, await readerFor(sub.filter), limit, Math.max(0, Number(waitS) || 0) * 1000)) as SubscriptionRead | null;
    },
    ack: async (id, cursor) => ((await mine(id)) ? ((await events.ack(id, cursor)) as number | null) : null),
    remove: async (id) => {
      const sub = await get(id);
      return sub && (sub.consumer === accountId || sub.owner === accountId) ? ((await events.deleteSubscription(id)) as boolean) : false;
    },
    jobs: async (subscriptionId) => {
      const sub = await get(subscriptionId);
      if (!sub || (sub.consumer !== accountId && sub.owner !== accountId)) return null;
      return (await events.listJobs(subscriptionId)) as AgentJobDTO[];
    },
    jobStep: async (id, step, opts = {}) => {
      const out = (await events.jobStep(id, accountId, step, opts)) as AgentJobDTO | { conflict: JobState } | null;
      if (out && 'conflict' in out) throw new ApiError(409, 'job_state', `the job is ${out.conflict}`);
      return out;
    },
  };
}

/** The operations once `make` has found the account (asked of the directory on first use, as the Mail tools find theirs). */
export function lazySubscriptions(make: () => Promise<SubscriptionOps>): SubscriptionOps {
  let ops: Promise<SubscriptionOps> | null = null;
  const get = () => (ops ??= make());
  return {
    list: async () => (await get()).list(),
    create: async (body) => (await get()).create(body),
    read: async (id, limit, waitS) => (await get()).read(id, limit, waitS),
    ack: async (id, cursor) => (await get()).ack(id, cursor),
    remove: async (id) => (await get()).remove(id),
    jobs: async (id) => (await get()).jobs(id),
    jobStep: async (id, step, opts) => (await get()).jobStep(id, step, opts),
  };
}
