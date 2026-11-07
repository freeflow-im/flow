// A subscription's four operations as one account in one organization (platform.md §5.2): what the HTTP routes
// (routes/events.ts) and the /mcp tools (eventTools.ts) both do, so the two doors read a queue the same way. The consumer
// is the caller's account; another consumer's subscription is as good as missing (null). The reader is the account with
// the private channels its person is in, read again on every read, so leaving a channel stops its events at once.
import type { EventFilter, SubscriptionDTO } from '@flow/shared';
import type { Events } from './object';
import type { Org } from '../org/object';
import type { Reader, SubscriptionRead } from './core';

export interface SubscriptionOps {
  list(): Promise<SubscriptionDTO[]>;
  create(body: { name: string; filter: EventFilter; delivery?: SubscriptionDTO['delivery'] }): Promise<SubscriptionDTO>;
  /** `waitS` long-polls, in seconds (at most 30). */
  read(id: string, limit?: number, waitS?: number): Promise<SubscriptionRead | null>;
  ack(id: string, cursor: number): Promise<number | null>;
  remove(id: string): Promise<boolean>;
}

export function subscriptionsAs(events: DurableObjectStub<Events>, org: DurableObjectStub<Org>, accountId: string, userId: string): SubscriptionOps {
  const mine = async (id: string) => {
    const sub = (await events.getSubscription(id)) as SubscriptionDTO | null;
    return sub && sub.consumer === accountId ? sub : null;
  };
  const readerFor = async (filter: EventFilter): Promise<Reader> => {
    const kind = filter.actorKind === 'person' || filter.actorKind === 'agent';
    const [channelIds, agentAccountIds] = await Promise.all([org.privateChannelIdsOf(userId), kind ? org.agentAccountIds() : Promise.resolve(undefined)]);
    return { accountId, channelIds, ...(agentAccountIds ? { agentAccountIds } : {}) };
  };
  return {
    list: async () => (await events.listSubscriptions(accountId)) as SubscriptionDTO[],
    create: async (body) =>
      (await events.createSubscription({ name: body.name, consumer: accountId, owner: accountId, filter: body.filter, delivery: body.delivery ?? 'pull', createdBy: accountId })) as SubscriptionDTO,
    read: async (id, limit, waitS) => {
      const sub = await mine(id);
      if (!sub) return null;
      return (await events.wait(id, await readerFor(sub.filter), limit, Math.max(0, Number(waitS) || 0) * 1000)) as SubscriptionRead | null;
    },
    ack: async (id, cursor) => ((await mine(id)) ? ((await events.ack(id, cursor)) as number | null) : null),
    remove: async (id) => ((await mine(id)) ? ((await events.deleteSubscription(id)) as boolean) : false),
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
  };
}
