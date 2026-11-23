// search_events (decision_log 2026-11-22, "agents remember through events"): an agent looks back through the organization's
// event log for what it, or the person it works for, did and took part in: meetings it was sent to (`meet.*`), messages
// it posted, files it changed, jobs it ran. Newest first, as the Admin app's Event log reads it (core.ts `before`).
//
// The reader is the turn's account, as GET /v1/events reads: a person (a personal agent acts as its sponsor) sees their
// own events, their personal agents' and their private channels'. A shared agent sees its own; when a person asked for the
// turn (`invokedBy`), that person's own events and private channels too, and nobody else's.
import { eventLabel, type PlatformEvent } from '@flow/shared';
import type { Events } from './object';
import type { Org } from '../org/object';
import type { ReadQuery, Reader } from './core';

export interface EventSearchInput {
  types?: string[];
  text?: string;
  channelId?: string;
  actorKind?: 'person' | 'agent';
  /** An ISO time: nothing older. */
  since?: string;
  /** A `next_before` from an earlier search: the page before it. */
  before?: number;
  limit?: number;
}

export interface EventHit {
  seq: number; type: string; label: string; ts: string;
  actor: string | null; via?: string; invokedBy?: string; channelId?: string; ref?: string;
  data: unknown;
}

export interface EventSearchOps {
  search(input: EventSearchInput): Promise<{ events: EventHit[]; next_before: number | null }>;
}

export const SEARCH_LIMIT_DEFAULT = 20;
export const SEARCH_LIMIT_MAX = 50;
/** A string in an event's data is cut to this many characters, so a page of events stays small for a model. */
const STRING_MAX = 300;

/** The event's data with long strings cut and deep nesting summarized. */
export function trimData(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return value.length > STRING_MAX ? `${value.slice(0, STRING_MAX)}…` : value;
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 4) return Array.isArray(value) ? `[${value.length} items]` : '{…}';
  if (Array.isArray(value)) {
    const head = value.slice(0, 20).map((v) => trimData(v, depth + 1));
    return value.length > 20 ? [...head, `… ${value.length - 20} more`] : head;
  }
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, trimData(v, depth + 1)]));
}

const refText = (e: PlatformEvent) => (e.ref ? `${e.ref.app}:${e.ref.kind}:${e.ref.id}` : undefined);

export function toHit(e: PlatformEvent): EventHit {
  return {
    seq: e.seq, type: e.type, label: eventLabel(e.type), ts: e.ts, actor: e.actor ?? null,
    ...(e.via ? { via: e.via } : {}), ...(e.invokedBy ? { invokedBy: e.invokedBy } : {}),
    ...(e.channelId ? { channelId: e.channelId } : {}), ...(refText(e) ? { ref: refText(e) } : {}),
    data: trimData(e.data),
  };
}

/**
 * The search as one account (`accountId`), and, for a shared agent's turn a person asked for, that person too (`invokedBy`,
 * an account the caller's door already checked is a member). Their own audiences and private channels make one reader.
 */
export function eventSearchAs(
  events: DurableObjectStub<Events>, org: DurableObjectStub<Org>, p: { accountId: string; invokedBy?: string | null },
): EventSearchOps {
  return {
    async search(input) {
      const limit = Math.min(SEARCH_LIMIT_MAX, Math.max(1, Math.floor(Number(input.limit) || SEARCH_LIMIT_DEFAULT)));
      const since = input.since ? Date.parse(input.since) : NaN;
      const query: ReadQuery = {
        before: input.before && input.before > 0 ? Math.floor(input.before) : 0,
        limit,
        ...(input.types?.length ? { types: input.types } : {}),
        ...(input.text?.trim() ? { text: input.text.trim() } : {}),
        ...(input.channelId ? { channelId: input.channelId } : {}),
        ...(input.actorKind ? { actorKind: input.actorKind } : {}),
      };
      const also = p.invokedBy && p.invokedBy !== p.accountId ? p.invokedBy : null;
      const accounts = also ? [p.accountId, also] : [p.accountId];
      const [channels, sponsored, agentAccountIds] = await Promise.all([
        org.privateChannelIdsOfAccounts(accounts) as Promise<Record<string, string[]>>,
        org.personalAgentAccountsOf(accounts) as Promise<Record<string, string[]>>,
        input.actorKind ? (org.agentAccountIds() as Promise<string[]>) : Promise.resolve(undefined),
      ]);
      // The person who asked is read as one more of the reader's own audiences, beside its personal agents.
      const own = [...new Set([...(also ? [also] : []), ...accounts.flatMap((a) => sponsored[a] ?? [])])];
      const reader: Reader = {
        accountId: p.accountId,
        channelIds: [...new Set(accounts.flatMap((a) => channels[a] ?? []))],
        ...(own.length ? { sponsoredAgentIds: own } : {}),
        ...(agentAccountIds ? { agentAccountIds } : {}),
      };
      const page = (await events.read(query, reader)) as { events: PlatformEvent[]; next: number };
      const kept = Number.isFinite(since) ? page.events.filter((e) => Date.parse(e.ts) >= since) : page.events;
      const reachedSince = kept.length < page.events.length;
      // A scan stops at `limit` events or SCAN_MAX rows; either way more may lie below, unless it reached the oldest kept.
      const oldest = page.events.length >= limit ? 0 : (((await events.stats()) as { first: number | null }).first ?? 0);
      const more = !reachedSince && page.next > 1 && page.next > oldest && (!input.before || page.next < input.before);
      return { events: kept.map(toHit), next_before: more ? page.next : null };
    },
  };
}
